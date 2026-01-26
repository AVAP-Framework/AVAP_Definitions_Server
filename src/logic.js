const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const pool = require('./db');

// --- IN-MEMORY CACHE ---
const definitionCache = new Map();

/**
 * Source code packing
 */
function packForLSP(pythonCode) {
    const MAGIC = 'AVAP';
    const VERSION = 1;
    // Key for packing
    const SECRET = Buffer.from('avap_secure_signature_key_2026', 'utf-8');
    
    const payload = Buffer.from(pythonCode, 'utf-8');
    const header = Buffer.alloc(10);
    
    // Write the header in Big-Endian format
    header.write(MAGIC, 0, 4, 'ascii');        // Magic (4 bytes)
    header.writeUInt16BE(VERSION, 4);          // Version (2 bytes)
    header.writeUInt32BE(payload.length, 6);   // Payload Size (4 bytes)

    // Generate signature HMAC-SHA256 over [Header + Payload]
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(Buffer.concat([header, payload]));
    const signature = hmac.digest(); // 32 bytes

    // Final structure: [Header][Signature][Payload]
    return Buffer.concat([header, signature, payload]);
}

/**
 * Loading and compilation process
 */
async function loadDefinitions() {
    console.log("[AVAP_Definitions] Initializing Build Pipeline...");
    try {
        const res = await pool.query(`
            SELECT f.name, f.type, f.interface, f.code as source_code, b.bytecode
            FROM obex_dapl_functions f
            LEFT JOIN avap_bytecode b ON f.name = b.command_name
        `);
        
        definitionCache.clear();
        
        for (const row of res.rows) {
            let finalBytecode = row.bytecode;

            // Verificamos si el bytecode ya es un paquete AVAP válido
            if (!finalBytecode || !finalBytecode.slice(0, 4).equals(Buffer.from('AVAP'))) {
                console.log(`[BUILD] Packaging: ${row.name}`);
                finalBytecode = packForLSP(row.source_code || "");
                
                // Persistimos para evitar re-empaquetar en el próximo reinicio
                await pool.query(`
                    INSERT INTO avap_bytecode (command_name, bytecode, source_hash)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (command_name) DO UPDATE SET bytecode = EXCLUDED.bytecode
                `, [row.name, finalBytecode, crypto.createHash('sha256').update(row.source_code || "").digest('hex')]);
            }

            definitionCache.set(row.name, {
                name: row.name,
                type: row.type || 'function',
                interface_json: row.interface || '[]',
                code: finalBytecode,
                hash: 'v-enterprise'
            });
        }
        console.log(`[AVAP_Definitions] ${definitionCache.size} definitions ready for ALS.`);
    } catch (err) {
        console.error("Critical Error in AVAP_Definitions Build Pipeline:", err);
    }
}

/**
 * Security validation
 */
const isAuthorized = (metadata, apiKeyBuffer) => {
    const authVal = metadata['x-avap-auth'];
    if (!authVal) return false;

    const receivedBuffer = Buffer.from(authVal);
    if (receivedBuffer.length !== apiKeyBuffer.length) return false;
    return crypto.timingSafeEqual(receivedBuffer, apiKeyBuffer);
};

/**
 * Get a command definition
 */
const getCommandLogic = (call, callback, apiKeyBuffer) => {
    const metadata = call.metadata.getMap();
    if (!isAuthorized(metadata, apiKeyBuffer)) {
        return callback({ code: grpc.status.UNAUTHENTICATED, details: 'Invalid Credentials' });
    }

    const def = definitionCache.get(call.request.name);
    if (def) {
        callback(null, {
            name: def.name,
            type: def.type,
            interface_json: def.interface_json,
            code: def.code,
            hash: def.hash
        });
    } else {
        callback({ code: grpc.status.NOT_FOUND, details: `Command '${call.request.name}' not found` });
    }
};

/**
 * Sync catalog (Batch fetch for ALS)
 */
const syncCatalogLogic = (call, callback, apiKeyBuffer) => {
    const metadata = call.metadata.getMap();
    if (!isAuthorized(metadata, apiKeyBuffer)) {
        return callback({ code: grpc.status.UNAUTHENTICATED, details: 'Invalid Credentials' });
    }

    const commandsList = Array.from(definitionCache.values());
    console.log(`SYNC: Sending ${commandsList.length} items to ALS.`);

    callback(null, {
        commands: commandsList,
        total_count: commandsList.length,
        version_hash: `v-${Date.now()}`
    });
};

module.exports = { 
    loadDefinitions, 
    getCommandLogic, 
    syncCatalogLogic 
};