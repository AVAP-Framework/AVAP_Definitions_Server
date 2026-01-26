import { ServiceDefinition } from '@grpc/proto-loader';
import { Server } from './server-type';
export declare const service: ServiceDefinition;
export type ServingStatus = 'UNKNOWN' | 'SERVING' | 'NOT_SERVING';
export interface ServingStatusMap {
    [serviceName: string]: ServingStatus;
}
export declare class HealthImplementation {
    private statusMap;
    private watchers;
    constructor(initialStatusMap?: ServingStatusMap);
    setStatus(service: string, status: ServingStatus): void;
    private addWatcher;
    private removeWatcher;
    addToServer(server: Server): void;
}
export declare const protoPath: string;
