const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const cluster = require('cluster');
const os = require('os');
const { performance } = require('perf_hooks');

// CONFIGURATION
const CONFIG = {
  server: '127.0.0.1:50052',
  protoPath: path.join(__dirname, '../avap.proto'),
  apiKey: 'avap_secret_key_2026',
  durationSeconds: 10,       // Duration of the attack
  concurrencyPerWorker: 50,  // Threads per CPU core
  clientWorkers: Math.max(2, os.cpus().length / 2) // Use half of available cores for load generation
};

// Main worker
if (cluster.isPrimary) {
  console.clear();
  console.log(`AVAP CLUSTER STRESS TEST | CANNON MODE`);
  console.log(`=========================================`);
  console.log(`Target: ${CONFIG.server}`);
  console.log(`Attackers: ${CONFIG.clientWorkers} Processes x ${CONFIG.concurrencyPerWorker} Threads`);
  console.log(`Duration: ${CONFIG.durationSeconds} seconds`);
  console.log(`-----------------------------------------`);

  let totalRequests = 0;
  let totalErrors = 0;
  let activeWorkers = 0;

  // Fork workers
  for (let i = 0; i < CONFIG.clientWorkers; i++) {
    const worker = cluster.fork();
    activeWorkers++;
    
    worker.on('message', (msg) => {
      if (msg.type === 'RESULTS') {
        totalRequests += msg.requests;
        totalErrors += msg.errors;
      }
    });
  }

  // Handle exit
  cluster.on('exit', () => {
    activeWorkers--;
    if (activeWorkers === 0) {
      const rps = (totalRequests / CONFIG.durationSeconds).toFixed(2);
      
      console.log(`\nSTRESS TEST COMPLETE`);
      console.log(`=======================`);
      console.log(`Total Requests: ${totalRequests.toLocaleString()}`);
      console.log(`Errors:         ${totalErrors}`);
      console.log(`FINAL THROUGHPUT: ${rps} RPS`);
      console.log(`=======================\n`);
    }
  });

} else {
  // Other workes
  
  const packageDefinition = protoLoader.loadSync(CONFIG.protoPath, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
  });
  const avapProto = grpc.loadPackageDefinition(packageDefinition).avap;
  
  // Create a pool of clients
  const clients = [];
  for(let i=0; i<CONFIG.concurrencyPerWorker; i++) {
     clients.push(new avapProto.DefinitionEngine(
        CONFIG.server,
        grpc.credentials.createInsecure(),
        { 'grpc.enable_http_proxy': 0 }
     ));
  }

  let requests = 0;
  let errors = 0;
  let keepRunning = true;

  // Metadata
  const metadata = new grpc.Metadata();
  metadata.add('x-avap-auth', CONFIG.apiKey);

  const attack = async (clientIndex) => {
    while (keepRunning) {
      const cmdName = Math.random() > 0.8 ? 'if' : `cmd_${Math.random()}`; // 20% hit, 80% miss
      
      await new Promise(resolve => {
        clients[clientIndex].GetCommand({ name: cmdName }, metadata, (err, response) => {
          requests++;
          if (err && err.code !== 5) errors++; // 5 is NOT_FOUND
          resolve();
        });
      });
    }
  };

  // Start Attack
  const attacks = clients.map((_, index) => attack(index));

  // Timer
  setTimeout(() => {
    keepRunning = false;
    // Wait for pending requests and report
    setTimeout(() => {
      process.send({ type: 'RESULTS', requests, errors });
      process.exit(0);
    }, 500);
  }, CONFIG.durationSeconds * 1000);
}