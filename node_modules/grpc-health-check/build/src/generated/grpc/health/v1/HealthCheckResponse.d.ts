export declare const _grpc_health_v1_HealthCheckResponse_ServingStatus: {
    readonly UNKNOWN: "UNKNOWN";
    readonly SERVING: "SERVING";
    readonly NOT_SERVING: "NOT_SERVING";
    /**
     * Used only by the Watch method.
     */
    readonly SERVICE_UNKNOWN: "SERVICE_UNKNOWN";
};
export type _grpc_health_v1_HealthCheckResponse_ServingStatus = 'UNKNOWN' | 0 | 'SERVING' | 1 | 'NOT_SERVING' | 2
/**
 * Used only by the Watch method.
 */
 | 'SERVICE_UNKNOWN' | 3;
export type _grpc_health_v1_HealthCheckResponse_ServingStatus__Output = typeof _grpc_health_v1_HealthCheckResponse_ServingStatus[keyof typeof _grpc_health_v1_HealthCheckResponse_ServingStatus];
export interface HealthCheckResponse {
    'status'?: (_grpc_health_v1_HealthCheckResponse_ServingStatus);
}
export interface HealthCheckResponse__Output {
    'status': (_grpc_health_v1_HealthCheckResponse_ServingStatus__Output);
}
