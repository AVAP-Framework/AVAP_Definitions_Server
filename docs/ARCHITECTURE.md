# AVAP Definition Server | Architecture Reference (v1.0)

> **Version:** 0.0.1
> **Protocol:** gRPC / HTTP/2
> **Runtime:** Node.js Cluster (Zero-IO Workers)
> **Status:** Production Ready

## 1. Executive Summary

The AVAP Definition Server is the high-performance **Single Source of Truth (SSOT)** for the platform's execution logic. Unlike traditional web services, this engine operates as a **Pure In-Memory Computing Cluster**.

It abstracts the persistence layer (PostgreSQL) from the execution layer (Python Interpreters), ensuring that database latency or locks never impact the runtime speed of the language. The system is engineered to serve Python logic definitions with **microsecond latency**.

---

## 2. Core Design Principles

This architecture deviates from standard REST patterns to achieve ultra-low latency (>35,000 RPS).

### A. The "Zero-I/O" Guarantee
Worker processes (the nodes handling client traffic) strictly follow a **Shared-Nothing, Zero-I/O architecture**.
* They **do not** connect to the database.
* They **do not** read from the disk.
* They serve 100% of requests from pre-allocated Heap Memory (RAM).

### B. Split-Plane Architecture
We separate the responsibilities into two distinct operational planes:
1.  **Control Plane (Master Process):** Handles infrastructure, database synchronization (`obex_dapl_functions`), IPC broadcasting, and process lifecycle management.
2.  **Data Plane (Worker Processes):** Pure computation units focused solely on gRPC serialization and request serving.

### C. Eager Consistency Model
Instead of "Lazy Loading" (fetch-on-demand), the engine uses **Eager Loading**. The entire logic catalog is pre-loaded at startup and kept synchronized via atomic updates. This eliminates "Cache Miss" penalties entirely.

---

## 3. Data Flow & Synchronization

The system uses an asynchronous **Master-Push** model.

```mermaid
sequenceDiagram
    participant DB as PostgreSQL (Legacy)
    participant M as AVAP Definition Server (Control)
    participant W as RAM Cache (Data Plane)
    participant C as AVAP Language Server

    Note over M, DB: 1. Hydration Phase (At Startup)
    M->>DB: SELECT * FROM obex_dapl_functions
    DB-->>M: Dataset (Raw SQL Rows)
    M->>M: Transform to Optimized Buffers
    M->>W: Atomic RAM Write (Map.set)

    Note over W: Engine is now READY

    Note over C, W: 2. Execution Phase (Real-time)
    
    rect rgb(240, 240, 240)
        Note right of C: Scenario A: Atomic Lookup
        C->>W: gRPC GetCommand(name="if")
        W->>W: O(1) Hash Map Seek
        W-->>C: Binary Definition (Proto)
    end

    rect rgb(220, 235, 255)
        Note right of C: Scenario B: Full Sync
        C->>W: gRPC SyncCatalog(Empty)
        W->>W: Map.values() Iterator
        W-->>C: Repeated CommandResponse (Bulk)
    end
    
    Note over M, DB: 3. Background Refresh (Optional)
    loop Every 60 seconds
        M->>DB: Poll for schema changes
        M-->>W: Update RAM if needed
    end