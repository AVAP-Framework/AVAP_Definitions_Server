const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { HealthImplementation } = require('grpc-health-check');
const client = require('prom-client');
const path = require('path');

// Logic functions
const logic = require('./logic');


const API_KEY = process.env.API_KEY || 'avap_secret_key_2026';
const PORT = process.env.PORT || '50051';
const API_KEY_BUFFER = Buffer.from(API_KEY);

// Observability
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Logger
function log(level, msg, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level: level,
    msg: msg
  };
  
  if (meta && typeof meta === 'object') {
    Object.keys(meta).forEach(key => {
      entry[key] = meta[key];
    });
  }
  
  console.log(JSON.stringify(entry));
}

async function startServer() {
    
    await logic.loadDefinitions();

    // Config gRPC
    const PROTO_PATH = path.join(__dirname, '../avap.proto');
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
    });
    const avapProto = grpc.loadPackageDefinition(packageDefinition).avap;

    const server = new grpc.Server();

    // Adding services
    server.addService(avapProto.DefinitionEngine.service, {
        GetCommand: (call, callback) => {
            return logic.getCommandLogic(call, callback, API_KEY_BUFFER);
        },
        SyncCatalog: (call, callback) => {
            return logic.syncCatalogLogic(call, callback, API_KEY_BUFFER);
        }
    });

    // Health Check
    const statusMap = { "avap.DefinitionEngine": "SERVING", "": "SERVING" };
    const healthImpl = new HealthImplementation(statusMap);
    healthImpl.addToServer(server);

    const bindAddr = `0.0.0.0:${PORT}`;
    server.bindAsync(bindAddr, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) {
            log('FATAL', 'Bind Failed', { error: err.message });
            process.exit(1);
        }
        log('AVAP_Definitions', `Server running on ${bindAddr}`);
    });
}

// Boot
startServer().catch(err => {
    log('FATAL', 'Startup Error', { error: err.message });
    process.exit(1);
});