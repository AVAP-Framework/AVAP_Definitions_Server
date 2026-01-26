# AVAP Definition Server | Production Operations Guide

> **Version:** 4.0.0 (Stable)
> **Runtime:** Node.js v18+ (Cluster Mode)
> **Infrastructure:** Kubernetes / Docker Swarm
> **SLA Target:** 99.99% Availability | <1ms P95 Latency

---

## 1. Runtime Architecture

This service operates on a **Split-Plane Architecture** designed for zero-latency responses.

* **Control Plane (Master Process):** Handles PostgreSQL synchronization (`obex_dapl_functions`), IPC broadcasting, and process lifecycle.
* **Data Plane (Worker Processes):** Pure computation nodes. They hold **zero database connections** and serve requests exclusively from RAM.

### Critical Operational Constraint
**Do not** attempt to scale this service by increasing `DATABASE_POOL_SIZE`. The workers do not use the DB. To scale throughput (RPS), you must scale **CPU Cores**.

---

## 2. Environment Configuration

The following variables must be injected via Kubernetes Secrets or Docker Envs.

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | yes | - | PostgreSQL Connection String (Read-Only user recommended). |
| `API_KEY` | yesz | - | High-entropy string for inter-service gRPC authentication. |
| `PORT` | no | `50051` | The gRPC listening port. |
| `UV_THREADPOOL_SIZE`| no | `64` | **Tuning:** Increases libuv threads for heavy crypto operations. |
| `NODE_ENV` | no | `production`| Disables dev-mode stack traces and logging overhead. |

---

## 3. Performance Tuning (The "Secret Sauce")

This service requires specific Kernel and V8 optimizations to reach peak performance (>35k RPS).

### A. V8 Engine Flags
The container entrypoint **must** override the default Node.js command to inject these flags. Failing to do so will result in GC pauses and latency spikes.

    node \
      --max-old-space-size=4096 \  # Allocates 4GB Heap (Reduces GC frequency)
      --min-semi-space-size=64 \   # Increases Young Gen for high-throughput gRPC buffers
      --no-lazy \                  # Forces eager compilation (JIT) at startup
      --expose-gc \                # Allows manual GC invocation during Warmup phase
      src/server.js

### B. OS / Kernel Limits (`ulimits`)
Because the service holds thousands of concurrent HTTP/2 streams:
* **File Descriptors (`nofile`):** Must be set to at least `65536`.
* **TCP Keepalive:** Ensure standard TCP keepalive is enabled on the ingress controller.

---

## 4. Kubernetes Deployment Strategy

To maintain the **"Google Standard"** performance profile, use the following specifications in your `Deployment` manifest.

### Quality of Service (QoS): Guaranteed
Kubernetes must treat these Pods as critical. You **must** set `requests` equal to `limits`. This ensures the Linux Kernel assigns dedicated CPU time slices (CPU Pinning behavior) and prevents eviction under node pressure.

    resources:
      requests:
        memory: "5Gi"  # See Memory Math below
        cpu: "4000m"   # 4 Dedicated Cores
      limits:
        memory: "5Gi"
        cpu: "4000m"

### The Memory Math (Avoid OOMKilled)
* **V8 Heap Limit:** 4096 MB (configured via flags).
* **Overhead Buffer:** ~1024 MB (Required for Off-Heap Buffers, C++ bindings, and OS kernel structures).
* **Pod Limit:** 5 GiB (5120 MB).
* **Rule:** Pod Limit must be > V8 Heap + 20%.

### Health Checks (Native gRPC)
Do not use `exec` probes. Use the native gRPC protocol enabled in the code.

    readinessProbe:
      grpc:
        port: 50051
      initialDelaySeconds: 5

* **Note:** The service will report `NOT_SERVING` until the DB data is fully loaded into RAM.

---

## 5. Observability & Monitoring

### Metrics (Prometheus)
The service exposes standard metrics. Set up alerts for:

1.  **Cache Size Drop:** `avap_cache_size < 100` (Indicates empty DB or sync failure).
2.  **Auth Failures:** `avap_requests_total{status="401"}` rate > 10/s (Indicates potential attack).
3.  **Process Restarts:** `kube_pod_container_status_restarts_total > 0` (Indicates unhandled exceptions or OOM).

### Logging
Logs are emitted in structured JSON format.
* **Filter:** `level: "ERROR"` or `level: "FATAL"`.
* **Audit:** Every database synchronization event is logged with `level: "INFO"` and `msg: "Definitions Broadcasted"`.

---

## 6. Disaster Recovery

### Scenario: Database Failure
* **Impact:** The Master process cannot fetch updates.
* **Behavior:** Workers **continue serving** the last known version of the definitions from RAM. The system "fails open" and remains available for execution.
* **Resolution:** Restore DB connectivity. The Master will auto-reconnect on the next 60s cycle.

### Scenario: Bad Definition Deployment
* **Problem:** A buggy Python script is injected into the DB.
* **Mitigation:** Rollback the database row.
* **Propagation:** The fix will propagate to all nodes within 60 seconds automatically. To force immediate update, restart the Pods (`kubectl rollout restart deployment avap-engine`).