'use strict';

/**
 * AVAP → AVBC Compiler bridge
 * 
 * Invokes compiler.py (Python) as a child process and returns
 * the compiled AVBC bytecode as a Buffer.
 *
 * Usage:
 *   const { compileToAVBC } = require('./compiler');
 *   const bytecode = await compileToAVBC(pythonSource, commandName);
 *   // bytecode is a Buffer starting with b'AVBC', or null if unsupported
 */

const { spawn } = require('child_process');
const path = require('path');

// Path to the Python compiler script (sits next to this file)
const COMPILER_PY = path.join(__dirname, '..', 'compiler.py');

// Python executable — use system python3
const PYTHON = process.env.PYTHON_BIN || 'python3';

/**
 * Compile Python source to AVBC bytecode.
 *
 * @param {string} pythonSource  — Python source code of the command
 * @param {string} commandName   — Command name (for error messages)
 * @returns {Promise<Buffer|null>} — AVBC bytecode Buffer, or null if unsupported
 */
async function compileToAVBC(pythonSource, commandName = 'unknown') {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const errChunks = [];

        // opcodes.json lives next to compiler.py
        const ISA_PATH = path.join(__dirname, '..', 'opcodes.json');

        const proc = spawn(PYTHON, [
            COMPILER_PY,
            '--name', commandName,
            '--isa',  ISA_PATH
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', chunk => errChunks.push(chunk));

        proc.on('close', code => {
            if (code === 0) {
                const bytecode = Buffer.concat(chunks);
                // Verify magic number
                if (bytecode.length >= 128 && bytecode.slice(0, 4).toString('ascii') === 'AVBC') {
                    resolve(bytecode);
                } else {
                    reject(new Error(`[AVBC] Invalid bytecode output for ${commandName}`));
                }
            } else if (code === 1) {
                // Unsupported construct — not a hard error, just skip AVBC
                const errRaw = Buffer.concat(errChunks).toString().trim();
                try {
                    const errMsg = JSON.parse(errRaw);
                    console.warn(`[AVBC] Unsupported in ${commandName}: ${errMsg.message}`);
                } catch (_) {
                    console.warn(`[AVBC] Unsupported construct in ${commandName}: ${errRaw}`);
                }
                resolve(null);  // null = fallback to exec() path
            } else {
                const errText = Buffer.concat(errChunks).toString();
                reject(new Error(`[AVBC] Compiler error in ${commandName}: ${errText}`));
            }
        });

        proc.on('error', err => {
            reject(new Error(`[AVBC] Failed to spawn compiler: ${err.message}`));
        });

        // Write Python source to stdin
        proc.stdin.write(pythonSource, 'utf-8');
        proc.stdin.end();
    });
}

module.exports = { compileToAVBC };
