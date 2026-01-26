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
const assert = require("assert");
const grpc = require("@grpc/grpc-js");
const health_1 = require("../src/health");
describe('Health checking', () => {
    const statusMap = {
        '': 'SERVING',
        'grpc.test.TestServiceNotServing': 'NOT_SERVING',
        'grpc.test.TestServiceServing': 'SERVING'
    };
    let healthServer;
    let healthClient;
    let healthImpl;
    beforeEach(done => {
        healthServer = new grpc.Server();
        healthImpl = new health_1.HealthImplementation(statusMap);
        healthImpl.addToServer(healthServer);
        healthServer.bindAsync('localhost:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
            if (error) {
                done(error);
                return;
            }
            const HealthClientConstructor = grpc.makeClientConstructor(health_1.service, 'grpc.health.v1.HealthService');
            healthClient = new HealthClientConstructor(`localhost:${port}`, grpc.credentials.createInsecure());
            healthServer.start();
            done();
        });
    });
    afterEach((done) => {
        healthClient.close();
        healthServer.tryShutdown(done);
    });
    describe('check', () => {
        it('Should say that an enabled service is SERVING', done => {
            healthClient.check({ service: '' }, (error, value) => {
                assert.ifError(error);
                assert.strictEqual(value === null || value === void 0 ? void 0 : value.status, 'SERVING');
                done();
            });
        });
        it('Should say that a disabled service is NOT_SERVING', done => {
            healthClient.check({ service: 'grpc.test.TestServiceNotServing' }, (error, value) => {
                assert.ifError(error);
                assert.strictEqual(value === null || value === void 0 ? void 0 : value.status, 'NOT_SERVING');
                done();
            });
        });
        it('Should get NOT_FOUND if the service is not registered', done => {
            healthClient.check({ service: 'not_registered' }, (error, value) => {
                assert(error);
                assert.strictEqual(error.code, grpc.status.NOT_FOUND);
                done();
            });
        });
        it('Should get a different response if the health status changes', done => {
            healthClient.check({ service: 'transient' }, (error, value) => {
                assert(error);
                assert.strictEqual(error.code, grpc.status.NOT_FOUND);
                healthImpl.setStatus('transient', 'SERVING');
                healthClient.check({ service: 'transient' }, (error, value) => {
                    assert.ifError(error);
                    assert.strictEqual(value === null || value === void 0 ? void 0 : value.status, 'SERVING');
                    done();
                });
            });
        });
    });
    describe('watch', () => {
        it('Should respond with the health status for an existing service', done => {
            const call = healthClient.watch({ service: '' });
            call.on('data', (response) => {
                assert.strictEqual(response.status, 'SERVING');
                call.cancel();
            });
            call.on('error', () => { });
            call.on('status', status => {
                assert.strictEqual(status.code, grpc.status.CANCELLED);
                done();
            });
        });
        it('Should send a new update when the status changes', done => {
            const receivedStatusList = [];
            const call = healthClient.watch({ service: 'grpc.test.TestServiceServing' });
            call.on('data', (response) => {
                switch (receivedStatusList.length) {
                    case 0:
                        assert.strictEqual(response.status, 'SERVING');
                        healthImpl.setStatus('grpc.test.TestServiceServing', 'NOT_SERVING');
                        break;
                    case 1:
                        assert.strictEqual(response.status, 'NOT_SERVING');
                        call.cancel();
                        break;
                    default:
                        assert.fail(`Unexpected third status update ${response.status}`);
                }
                receivedStatusList.push(response.status);
            });
            call.on('error', () => { });
            call.on('status', status => {
                assert.deepStrictEqual(receivedStatusList, ['SERVING', 'NOT_SERVING']);
                assert.strictEqual(status.code, grpc.status.CANCELLED);
                done();
            });
        });
        it('Should update when a service that did not exist is added', done => {
            const receivedStatusList = [];
            const call = healthClient.watch({ service: 'transient' });
            call.on('data', (response) => {
                switch (receivedStatusList.length) {
                    case 0:
                        assert.strictEqual(response.status, 'SERVICE_UNKNOWN');
                        healthImpl.setStatus('transient', 'SERVING');
                        break;
                    case 1:
                        assert.strictEqual(response.status, 'SERVING');
                        call.cancel();
                        break;
                    default:
                        assert.fail(`Unexpected third status update ${response.status}`);
                }
                receivedStatusList.push(response.status);
            });
            call.on('error', () => { });
            call.on('status', status => {
                assert.deepStrictEqual(receivedStatusList, ['SERVICE_UNKNOWN', 'SERVING']);
                assert.strictEqual(status.code, grpc.status.CANCELLED);
                done();
            });
        });
    });
    describe('list', () => {
        it('Should return all registered service statuses', done => {
            healthClient.list({}, (error, response) => {
                assert.ifError(error);
                assert(response);
                assert.deepStrictEqual(response.statuses, {
                    '': { status: 'SERVING' },
                    'grpc.test.TestServiceNotServing': { status: 'NOT_SERVING' },
                    'grpc.test.TestServiceServing': { status: 'SERVING' }
                });
                done();
            });
        });
        it('Should return an empty list when no services are registered', done => {
            // Create a new server with no services registered
            const emptyServer = new grpc.Server();
            const emptyImpl = new health_1.HealthImplementation({});
            emptyImpl.addToServer(emptyServer);
            emptyServer.bindAsync('localhost:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
                assert.ifError(error);
                const HealthClientConstructor = grpc.makeClientConstructor(health_1.service, 'grpc.health.v1.HealthService');
                const emptyClient = new HealthClientConstructor(`localhost:${port}`, grpc.credentials.createInsecure());
                emptyServer.start();
                emptyClient.list({}, (error, response) => {
                    assert.ifError(error);
                    assert(response);
                    assert.deepStrictEqual(response.statuses, {});
                    emptyClient.close();
                    emptyServer.tryShutdown(done);
                });
            });
        });
        it('Should return RESOURCE_EXHAUSTED when too many services are registered', done => {
            const largeStatusMap = {};
            for (let i = 0; i < 101; i++) {
                largeStatusMap[`service-${i}`] = 'SERVING';
            }
            const largeServer = new grpc.Server();
            const largeImpl = new health_1.HealthImplementation(largeStatusMap);
            largeImpl.addToServer(largeServer);
            largeServer.bindAsync('localhost:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
                assert.ifError(error);
                const HealthClientConstructor = grpc.makeClientConstructor(health_1.service, 'grpc.health.v1.HealthService');
                const largeClient = new HealthClientConstructor(`localhost:${port}`, grpc.credentials.createInsecure());
                largeServer.start();
                largeClient.list({}, (error, response) => {
                    assert(error);
                    assert.strictEqual(error.code, grpc.status.RESOURCE_EXHAUSTED);
                    assert.strictEqual(response, undefined);
                    largeClient.close();
                    largeServer.tryShutdown(done);
                });
            });
        });
    });
});
//# sourceMappingURL=test-health.js.map