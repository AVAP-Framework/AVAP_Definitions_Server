const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// --- CONFIGURATION ---
// Default to 50051 (Node Native) or 50052 (Docker External)
const PORT = process.env.PORT || '50051'; 
const HOST = process.env.HOST || 'localhost';
const SERVER_ADDR = `${HOST}:${PORT}`;
const TOTAL_REQUESTS = 1000;
const CONCURRENCY = 20; 
const REQUEST_TIMEOUT_MS = 1000; // 1 second max per request
const GLOBAL_TIMEOUT_MS = 15000; // 15 seconds max for whole test

console.log('\n==========================================');
console.log('SMOKE STRESS TEST | CI MODE');
console.log('==========================================');
console.log(`Target:       ${SERVER_ADDR}`);
console.log(`Concurrency:  ${CONCURRENCY} threads`);
console.log(`Total Reqs:   ${TOTAL_REQUESTS}`);
console.log('------------------------------------------');

// ---  PROTO SETUP ---
const PROTO_PATH = path.join(__dirname, '../avap.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, defaults: true, oneofs: true
});
const avap_proto = grpc.loadPackageDefinition(packageDefinition).avap;

// ---  CLIENT SETUP ---
const client = new avap_proto.DefinitionEngine(SERVER_ADDR, grpc.credentials.createInsecure());
const meta = new grpc.Metadata();
meta.add('x-avap-auth', 'avap_secret_key_2026');

// ---  STATE ---
let completed = 0;
let success = 0;
let failed = 0;
const errorsDetails = {}; // To aggregate error types
const startTime = Date.now();

// --- SAFETY NET (GLOBAL TIMEOUT) ---
// If the test hangs for any reason, this kills the process
const globalTimeout = setTimeout(() => {
    console.error('\nCRITICAL: Global Timeout Exceeded!');
    console.error(`   The test took longer than ${GLOBAL_TIMEOUT_MS/1000}s. process hanging.`);
    process.exit(1);
}, GLOBAL_TIMEOUT_MS);

// --- EXECUTION LOOP ---

function makeRequest() {
    if (completed >= TOTAL_REQUESTS) return;

    // Request Options: Strict Deadline
    const options = {
        deadline: Date.now() + REQUEST_TIMEOUT_MS
    };

    client.GetCommand({ name: 'if' }, meta, options, (err, response) => {
        completed++;

        if (err) {
            failed++;
            // Aggregate error messages for report
            const code = err.code || 'UNKNOWN';
            errorsDetails[code] = (errorsDetails[code] || 0) + 1;
        } else {
            // Validate payload integrity
            if (response && response.code) {
                success++;
            } else {
                failed++;
                errorsDetails['EMPTY_RESPONSE'] = (errorsDetails['EMPTY_RESPONSE'] || 0) + 1;
            }
        }

        // Visual Progress Bar
        if (completed % 100 === 0) {
            const percent = ((completed / TOTAL_REQUESTS) * 100).toFixed(0);
            process.stdout.write(`[${percent}%] `);
        }

        if (completed === TOTAL_REQUESTS) {
            finish();
        } else if (completed < TOTAL_REQUESTS) {
            // Keep the concurrency pool full
            makeRequest();
        }
    });
}

// --- TEARDOWN ---

function finish() {
    clearTimeout(globalTimeout); // Disarm safety net
    const duration = (Date.now() - startTime) / 1000;
    const rps = TOTAL_REQUESTS / duration;

    console.log('\n\n==========================================');
    console.log('TEST REPORT');
    console.log('==========================================');
    console.log(` Duration:     ${duration.toFixed(3)}s`);
    console.log(` Throughput:   ${rps.toFixed(2)} Req/Sec`);
    console.log('------------------------------------------');
    console.log(`Success:      ${success}`);
    console.log(`Failed:       ${failed}`);

    // Print Error Details if any
    if (failed > 0) {
        console.log('\n  ERROR BREAKDOWN:');
        Object.keys(errorsDetails).forEach(code => {
            console.log(`   - Error Code [${code}]: ${errorsDetails[code]} occurrences`);
        });
    }

    console.log('------------------------------------------');

    // Clean Exit
    client.close();

    if (failed > 0) {
        console.error('FAILURE: System produced errors under load.');
        process.exit(1);
    } else {
        console.log('PASSED: System is stable.');
        process.exit(0);
    }
}

// --- STARTUP SEQUENCE ---

console.log('Handshaking with server...');

// Wait up to 2 seconds for the server to be available
const deadline = new Date();
deadline.setSeconds(deadline.getSeconds() + 2);

client.waitForReady(deadline, (err) => {
    if (err) {
        console.error('\nFATAL: Could not connect to server.');
        console.error('   Possible reasons:');
        console.error('   1. Server is not running.');
        console.error(`   2. Wrong Port (Trying ${SERVER_ADDR}).`);
        console.error('   3. Firewall/Docker issue.');
        console.error(`   Error details: ${err.message}`);
        process.exit(1);
    }

    console.log('⚡ Connection Established! Firing requests...\n');
    // Fill the pool
    for (let i = 0; i < CONCURRENCY; i++) {
        makeRequest();
    }
});