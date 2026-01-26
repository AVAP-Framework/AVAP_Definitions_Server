import sys
import os
import time
import grpc
import concurrent.futures
import statistics

# --- CONFIGURATION ---
CONCURRENCY = 50           
TOTAL_REQUESTS = 10000     
TARGET = 'localhost:50051' 
AUTH_TOKEN = 'avap_secret_key_2026'
PERFORMANCE_THRESHOLD_RPS = 2000 

sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

try:
    from app.core import avap_pb2
    from app.core import avap_pb2_grpc
except ImportError:
    print("Proto files not found.")
    sys.exit(1)

def worker_get_command(stub, metadata):
    start = time.perf_counter()
    try:
        stub.GetCommand(avap_pb2.CommandRequest(name='if'), metadata=metadata)
        return True, time.perf_counter() - start
    except grpc.RpcError:
        return False, 0

def run_stress_test():
    print(f"AVAP ENGINE BENCHMARK | SRE MODE")
    print(f"Target: {TARGET} | Threads: {CONCURRENCY}")
    print("=" * 60)

    channel = grpc.insecure_channel(target=TARGET)
    stub = avap_pb2_grpc.DefinitionEngineStub(channel)
    metadata = (('x-avap-auth', AUTH_TOKEN),)

    # --- TEST 1: LATENCY & THROUGHPUT ---
    print(f"Running High Frequency Test...")
    latencies = []
    start_time = time.time()
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = [executor.submit(worker_get_command, stub, metadata) for _ in range(TOTAL_REQUESTS)]
        for future in concurrent.futures.as_completed(futures):
            success, latency = future.result()
            if success:
                latencies.append(latency * 1000) # Convert to ms

    duration = time.time() - start_time
    rps = len(latencies) / duration

    # --- CALCULATE METRICS ---
    avg_lat = statistics.mean(latencies)
    p95_lat = statistics.quantiles(latencies, n=20)[18] # P95
    p99_lat = statistics.quantiles(latencies, n=100)[98] # P99

    print("\n THROUGHPUT & LATENCY RESULTS:")
    print(f"┌────────────────────┬────────────────────────────┐")
    print(f"│ Metric             │ Result                     │")
    print(f"├────────────────────┼────────────────────────────┤")
    print(f"│ Throughput (RPS)   │ {rps:,.2f} req/sec         │")
    print(f"│ Avg Latency        │ {avg_lat:.3f} ms            │")
    print(f"│ P95 Latency        │ {p95_lat:.3f} ms            │")
    print(f"│ P99 Latency        │ {p99_lat:.3f} ms            │")
    print(f"└────────────────────┴────────────────────────────┘")

    # --- TEST 2: BULK DATA TRANSFER ---
    print(f"\n📦 Testing SyncCatalog Payload...")
    sync_start = time.time()
    resp = stub.SyncCatalog(avap_pb2.Empty(), metadata=metadata)
    total_bytes = sum(len(c.code) for c in resp.commands)
    sync_duration = time.time() - sync_start
    
    mb_processed = (total_bytes / 1024 / 1024)
    print(f" Sync: {len(resp.commands)} items | {mb_processed:.2f} MB | {sync_duration:.3f}s")

    channel.close()

    # --- PERFORMANCE BUDGET CHECK ---
    print("\n" + "=" * 60)
    if rps < PERFORMANCE_THRESHOLD_RPS:
        print(f" FAIL: Underperformance detected (< {PERFORMANCE_THRESHOLD_RPS} RPS)")
        sys.exit(1)
    else:
        print(f"✨ PASS: Performance within budget")
        sys.exit(0)

if __name__ == '__main__':
    run_stress_test()