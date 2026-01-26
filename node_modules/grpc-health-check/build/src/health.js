"use strict";
/*
 *
 * Copyright 2023 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.protoPath = exports.HealthImplementation = exports.service = void 0;
const path = require("path");
const proto_loader_1 = require("@grpc/proto-loader");
const loadedProto = (0, proto_loader_1.loadSync)('health/v1/health.proto', {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [`${__dirname}/../../proto`],
});
exports.service = loadedProto['grpc.health.v1.Health'];
const GRPC_STATUS_NOT_FOUND = 5;
const GRPC_STATUS_RESOURCE_EXHAUSTED = 8;
const RESOURCE_EXHAUSTION_LIMIT = 100;
class HealthImplementation {
    constructor(initialStatusMap) {
        this.statusMap = new Map();
        this.watchers = new Map();
        if (initialStatusMap) {
            for (const [serviceName, status] of Object.entries(initialStatusMap)) {
                this.statusMap.set(serviceName, status);
            }
        }
    }
    setStatus(service, status) {
        var _a;
        this.statusMap.set(service, status);
        for (const watcher of (_a = this.watchers.get(service)) !== null && _a !== void 0 ? _a : []) {
            watcher(status);
        }
    }
    addWatcher(service, watcher) {
        const existingWatcherSet = this.watchers.get(service);
        if (existingWatcherSet) {
            existingWatcherSet.add(watcher);
        }
        else {
            const newWatcherSet = new Set();
            newWatcherSet.add(watcher);
            this.watchers.set(service, newWatcherSet);
        }
    }
    removeWatcher(service, watcher) {
        var _a;
        (_a = this.watchers.get(service)) === null || _a === void 0 ? void 0 : _a.delete(watcher);
    }
    addToServer(server) {
        server.addService(exports.service, {
            check: (call, callback) => {
                const serviceName = call.request.service;
                const status = this.statusMap.get(serviceName);
                if (status) {
                    callback(null, { status: status });
                }
                else {
                    callback({ code: GRPC_STATUS_NOT_FOUND, details: `Health status unknown for service ${serviceName}` });
                }
            },
            watch: (call) => {
                const serviceName = call.request.service;
                const statusWatcher = (status) => {
                    call.write({ status: status });
                };
                this.addWatcher(serviceName, statusWatcher);
                call.on('cancelled', () => {
                    this.removeWatcher(serviceName, statusWatcher);
                });
                const currentStatus = this.statusMap.get(serviceName);
                if (currentStatus) {
                    call.write({ status: currentStatus });
                }
                else {
                    call.write({ status: 'SERVICE_UNKNOWN' });
                }
            },
            list: (_call, callback) => {
                const statuses = {};
                let serviceCount = 0;
                for (const [serviceName, status] of this.statusMap.entries()) {
                    if (serviceCount >= RESOURCE_EXHAUSTION_LIMIT) {
                        const error = {
                            code: GRPC_STATUS_RESOURCE_EXHAUSTED,
                            details: 'Too many services to list.',
                        };
                        callback(error, null);
                        return;
                    }
                    statuses[serviceName] = { status };
                    serviceCount++;
                }
                callback(null, { statuses });
            },
        });
    }
}
exports.HealthImplementation = HealthImplementation;
exports.protoPath = path.resolve(__dirname, '../../proto/health/v1/health.proto');
//# sourceMappingURL=health.js.map