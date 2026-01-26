import sys
import os
import grpc

# --- 1. PATH CONFIGURATION ---
# Add project root to path to allow importing 'app.core'
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

# --- 2. IMPORT GENERATED CODE ---
# If the compilation step failed, this will raise an error.
try:
    from app.core import avap_pb2
    from app.core import avap_pb2_grpc
except ImportError:
    print("ERROR: Generated Proto files not found.")
    print("   Run: python -m grpc_tools.protoc -Iprotos --python_out=app/core --grpc_python_out=app/core protos/avap.proto")
    sys.exit(1)

def run_test():
    print("Connecting to BRAIN (Node.js Definition Engine)...")
    
    # Server Address (Docker: localhost:50052, Local: localhost:50051)
    # Adjust depending on how you are running the Node server.
    target = 'localhost:50051' 
    
    # 3. CREATE gRPC CHANNEL
    with grpc.insecure_channel(target) as channel:
        stub = avap_pb2_grpc.DefinitionEngineStub(channel)
        
        # 4. PREPARE METADATA (AUTHENTICATION)
        # Without this, the server will reject the request with UNAUTHENTICATED
        metadata = (('x-avap-auth', 'avap_secret_key_2026'),)

        try:
            # 5. SEND REQUEST (Requesting 'if' command)
            print(f"📡 Requesting 'if' definition from {target}...")
            request = avap_pb2.CommandRequest(name='if')
            
            response = stub.GetCommand(request, metadata=metadata)

            # 6. VALIDATE RESPONSE
            print("\nRESPONSE RECEIVED!")
            print("-" * 40)
            print(f" Hash: {response.hash}")
            print(f" Code Length: {len(response.code)} chars")
            print(f" Code Preview: {response.code[:50]}...")
            print("-" * 40)

        except grpc.RpcError as e:
            print(f"\n gRPC ERROR: {e.code()}")
            print(f"   Detail: {e.details()}")

if __name__ == '__main__':
    run_test()