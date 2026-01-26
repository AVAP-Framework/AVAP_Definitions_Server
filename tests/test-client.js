const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { performance } = require('perf_hooks');

// CONFIG
const PORT = '50052';
const HOST = '127.0.0.1';
const PROTO_PATH = path.join(__dirname, '../avap.proto');
const API_KEY = 'avap_secret_key_2026';
const TOTAL_REQUESTS = 100; // Number of petitions for the swarm

// Proto load
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const avapProto = grpc.loadPackageDefinition(packageDefinition).avap;

// Client
const client = new avapProto.DefinitionEngine(
  `${HOST}:${PORT}`,
  grpc.credentials.createInsecure(),
  { 'grpc.enable_http_proxy': 0 }
);

// Command to make petition
function getCommandAsync(name) {
  return new Promise((resolve) => {
    const metadata = new grpc.Metadata();
    metadata.add('x-avap-auth', API_KEY);

    const start = performance.now();
    
    client.GetCommand({ name }, metadata, (err, response) => {
      const end = performance.now();
      const duration = parseFloat((end - start).toFixed(2));

      if (err) {
        // if the error was "NOT_FOUND" ita a "thechnical success" (server answered)
        // But we separate the result found from not found
        resolve({ 
          success: false, 
          status: err.code, 
          details: err.details, 
          duration,
          name 
        });
      } else {
        resolve({ 
          success: true, 
          status: 0, // OK
          size: response.code.length, 
          duration,
          name
        });
      }
    });
  });
}

// TEST ENGINE
async function runTestSuite() {
  console.log(`\nSTARTING TEST SUITE TOWARDS ${HOST}:${PORT}`);
  console.log('==================================================');

  // 1. Warm-up
  console.log('Warming up (1 petition)...');
  await getCommandAsync('if');

  // 2. Swarm test
  console.log(`Sending swarm o ${TOTAL_REQUESTS} mixed petitions...`);
  
  const promises = [];
  const commands = ['if', 'while', 'for', 'ghost_command', 'print', 'return'];

  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    // get a random command
    const cmd = commands[Math.floor(Math.random() * commands.length)];
    promises.push(getCommandAsync(cmd));
  }

  // wait for all
  const results = await Promise.all(promises);

  // 3. Process results
  const stats = {
    total: results.length,
    ok: results.filter(r => r.success).length,
    errors: results.filter(r => !r.success && r.status !== 5).length, // 5 is NOT_FOUND (waiting)
    notFound: results.filter(r => r.status === 5).length,
    minTime: Math.min(...results.map(r => r.duration)),
    maxTime: Math.max(...results.map(r => r.duration)),
    avgTime: results.reduce((acc, r) => acc + r.duration, 0) / results.length
  };

  console.log('\nPERFORMANCE STATISTIC');
  console.table({
    'Total Petitions': stats.total,
    'Success (Found)': stats.ok,
    'Success (Not Found)': stats.notFound,
    'Real Errors': stats.errors,
    'Average Latency': `${stats.avgTime.toFixed(2)} ms`,
    'Minimun Latency': `${stats.minTime} ms`,
    'Maximun Latency': `${stats.maxTime} ms`
  });

  if (stats.errors > 0) {
    console.log(' ALERT: There was errors. Look at the server logs.');
  } else {
    console.log(' RESULT: System running well and stable.');
  }

  // Closing connection
  setTimeout(() => process.exit(0), 500);
}

// Execution
client.waitForReady(Date.now() + 5000, (err) => {
  if (err) {
    console.error(' Cant connect to de server:', err);
    process.exit(1);
  }
  runTestSuite();
});