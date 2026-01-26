#  Security Policy: AVAP Definition Server (v1.0)

## 1. Perimeter Defense & Network Isolation

This service is classified as **Level 1 Critical Infrastructure**. It manages the execution logic of the platform.

### Air-Gapped Workers (Architectural Security)
We utilize a **Split-Plane Architecture** to isolate the database from the network edge.
* **Public Traffic:** Handled by Worker processes. These processes have **Zero Network Access** to the Database. Even if a Worker is compromised via Remote Code Execution (RCE), the attacker cannot reach the PostgreSQL database directly from that process context.
* **Database Traffic:** Handled exclusively by the Master process, which is not exposed to any incoming API traffic.


---

## 2. Database Security (Master Plane)

Since only the Master process connects to the Persistence Layer:
* **Connection Exhaustion Immunity:** It is mathematically impossible for an external flood of API requests to exhaust the database connection pool, as API requests never trigger DB queries.
* **SQL Injection Immunity:** The API inputs (command names) are treated strictly as Hash Map lookup keys in RAM. They are never interpolated into SQL queries during runtime.
* **Least Privilege:** The Master process requires `READ-ONLY` access to the `obex_dapl_functions` table.

---

## 3. API Hardening (gRPC Data Plane)

### Authentication & Timing Attacks
We implement protection against **Side-Channel Timing Attacks**.
* **Standard Comparison:** `if (input == secret)` leaks timing information (it returns faster if the first byte is wrong).
* **AVAP Implementation:** We use `crypto.timingSafeEqual()`. The server takes exactly the same amount of time to reject a fake key as it does to verify a real one, blinding attackers to key structure.

### Protocol Validation
* **Strict Protobuf Schema:** Unlike JSON, the gRPC binary protocol enforces strict type checking before the request reaches the application logic. Malformed payloads are rejected at the transport layer.
* **Metadata Sanitization:** Auth tokens are extracted from `x-avap-auth` metadata buffers without converting to strings, preventing certain buffer overflow exploits.

---

## 4. Secret Management

* **Ephemeral Credentials:** Database credentials (`DATABASE_URL`) and API Keys are injected via Environment Variables (`process.env`) or Kubernetes Secrets.
* **No Hardcoding:** The source code contains no default passwords or fallback keys.
* **Memory Hygiene:** The API Key is stored as a `Buffer` in memory to avoid string interning leaks in Node.js heap dumps.