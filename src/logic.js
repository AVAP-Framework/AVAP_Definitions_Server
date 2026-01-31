const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const pool = require('./db');

// In-memory cache
const definitionCache = new Map();

function packForLSP(pythonCode) {
    const MAGIC = 'AVAP';
    const VERSION = 1;

    const SECRET = Buffer.from('avap_secure_signature_key_2026', 'utf-8');
    
    const payload = Buffer.from(pythonCode, 'utf-8');
    const header = Buffer.alloc(10);
    
    // Header
    header.write(MAGIC, 0, 4, 'ascii');        
    header.writeUInt16BE(VERSION, 4);          
    header.writeUInt32BE(payload.length, 6);  

    // Signature HMAC-SHA256 [Header + Payload]
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(Buffer.concat([header, payload]));
    const signature = hmac.digest(); 

    return Buffer.concat([header, signature, payload]);
}

// Load from database
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

            if (!finalBytecode || !finalBytecode.slice(0, 4).equals(Buffer.from('AVAP'))) {
                console.log(`[AVAP_Definitions] Packaging: ${row.name}`);
                finalBytecode = packForLSP(row.source_code || "");
                
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


const isAuthorized = (metadata, apiKeyBuffer) => {
    const authVal = metadata['x-avap-auth'];
    if (!authVal) return false;

    const receivedBuffer = Buffer.from(authVal);
    if (receivedBuffer.length !== apiKeyBuffer.length) return false;
    return crypto.timingSafeEqual(receivedBuffer, apiKeyBuffer);
};

// Serve a command
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

// Sync the catalog
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