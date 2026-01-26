import { ServiceDefinition } from '@grpc/proto-loader';
import { ObjectReadable, ObjectWritable } from './object-stream';
import { EventEmitter } from 'events';
type Metadata = any;
interface StatusObject {
    code: number;
    details: string;
    metadata: Metadata;
}
type Deadline = Date | number;
type ServerStatusResponse = Partial<StatusObject>;
type ServerErrorResponse = ServerStatusResponse & Error;
type ServerSurfaceCall = {
    cancelled: boolean;
    readonly metadata: Metadata;
    getPeer(): string;
    sendMetadata(responseMetadata: Metadata): void;
    getDeadline(): Deadline;
    getPath(): string;
} & EventEmitter;
export type ServerUnaryCall<RequestType, ResponseType> = ServerSurfaceCall & {
    request: RequestType;
};
type ServerReadableStream<RequestType, ResponseType> = ServerSurfaceCall & ObjectReadable<RequestType>;
export type ServerWritableStream<RequestType, ResponseType> = ServerSurfaceCall & ObjectWritable<ResponseType> & {
    request: RequestType;
    end: (metadata?: Metadata) => void;
};
type ServerDuplexStream<RequestType, ResponseType> = ServerSurfaceCall & ObjectReadable<RequestType> & ObjectWritable<ResponseType> & {
    end: (metadata?: Metadata) => void;
};
export type sendUnaryData<ResponseType> = (error: ServerErrorResponse | ServerStatusResponse | null, value?: ResponseType | null, trailer?: Metadata, flags?: number) => void;
type handleUnaryCall<RequestType, ResponseType> = (call: ServerUnaryCall<RequestType, ResponseType>, callback: sendUnaryData<ResponseType>) => void;
type handleClientStreamingCall<RequestType, ResponseType> = (call: ServerReadableStream<RequestType, ResponseType>, callback: sendUnaryData<ResponseType>) => void;
type handleServerStreamingCall<RequestType, ResponseType> = (call: ServerWritableStream<RequestType, ResponseType>) => void;
type handleBidiStreamingCall<RequestType, ResponseType> = (call: ServerDuplexStream<RequestType, ResponseType>) => void;
export type HandleCall<RequestType, ResponseType> = handleUnaryCall<RequestType, ResponseType> | handleClientStreamingCall<RequestType, ResponseType> | handleServerStreamingCall<RequestType, ResponseType> | handleBidiStreamingCall<RequestType, ResponseType>;
export type UntypedHandleCall = HandleCall<any, any>;
export interface UntypedServiceImplementation {
    [name: string]: UntypedHandleCall;
}
export interface Server {
    addService(service: ServiceDefinition, implementation: UntypedServiceImplementation): void;
}
export {};
