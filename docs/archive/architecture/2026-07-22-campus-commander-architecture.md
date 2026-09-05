# Campus Commander — Architecture & Jobs Pipeline Design

**Date:** 2026-07-22  
**Status:** FINALIZED  
**Purpose:** Capture the complete technical architecture, job system design, and scaling strategy for Campus Commander. Prevents decision drift and provides a single source of truth for AI generation and human review.

---

## 1. Approved Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Frontend** | Angular 20 (NgRx Signals + Angular Material + Tailwind CSS) | High opinionation = AI produces predictable, auditable output. Signals/RxJS handle complex entity state natively. Material + Tailwind = enterprise UI speed. |
| **Grid** | ag-grid-community 36.x + LibreGrid (`@libregrid/*`) feature packages | SSRM, server-side selection, filters, Excel export, and charts as MIT-licensed modules on the Community registry. No enterprise license. See decision log 2026-08-29. |
| **Backend API** | NestJS (TypeScript) | Strict DI, decorators, and module structure. Mirrors Angular architecture. Enforces type safety across the monorepo. |
| **Orchestration** | Kestra (Declarative YAML Flows) | Self-hosted industrial orchestrator. Acts as the "Traffic Cop" for all jobs. No side effects, no business logic. |
| **Primary Database** | Postgres | Entity cache, audit logs, RBAC, configuration. |
| **Cache/Session** | Redis | NestJS request caching, session storage, selection hashes. |
| **Monorepo** | Nx | Shared TS interfaces, strict API contracts, single build/deploy surface. |
| **Deployment** | Docker Compose | Single artifact for all environments (dev → prod). |

---

## 2. Core Architectural Principles

1. **"The API is an Orchestrator, Not a Worker."** NestJS validates auth/RBAC, routes requests, and exposes internal endpoints. It never directly calls Google APIs or performs heavy batch processing.
2. **"Entity Cache vs. Job System" Boundary:**
   - **Entity Cache (Postgres/Redis):** What the user *sees*. Fast reads, UI state, filters, pagination.
   - **Job System (Kestra + NestJS Internal):** What the system *does*. Anything that updates state, touches 3rd party APIs, or handles bulk/heavy operations.
3. **Kestra Constraint:** Kestra contains **ZERO business logic**. It only defines:
   - Sequence/order of operations
   - Guardrails: `concurrency`, `retries`, `timeout`
   - Input/output file pathways
4. **File-Driven Pipeline:** For large-scale operations (>10k records), all data passes through the filesystem. Never through HTTP bodies, queues, or in-memory serialization.

---

## 3. Jobs Pipeline Architecture (File-Driven Pattern)

This pattern eliminates memory limits, body-size crashes, and race conditions at enterprise scale.

### Directory Structure (Kestea Volume Mount)
```
/jobs
  /inbox        ← Init job files written by NestJS
  /work         ← Chunks written by NestJS chunker
  /out          ← Batch results written by workers
  /archive      ← Completed job files moved here forever
```

### Execution Phases

#### Phase 1: Ingestion (Client → NestJS)
- **Client:** Angular uses Server-Side-Row-Model to let admin select entities (e.g., 300k devices). Selection is computed server-side.
- **Payload:** `POST /api/jobs/trigger`
  ```json
  { "flowId": "bulk_update_devices", "selectionHash": "sha256:abc..." }
  ```
- **NestJS:** 
  1. Validates RBAC against the hash.
  2. Writes `init-job.json` to `/jobs/inbox/`. Contains: `entityType`, `action`, `targetHash`, `triggeredBy`, `timestamp`.
  3. Triggers Kestra flow with the file path.

#### Phase 2: Orchestration (Kestra → NestJS)
- Kestra reads `init-job.json`.
- Triggers `/api/internal/chunk` endpoint with the file path.
- **NestJS Chunker:**
  1. Reads entities from Postgres/cache using the hash.
  2. Splits into fixed-size batch files (e.g., 1000 records each).
  3. Writes `chunk-000.json`, `chunk-001.json`, etc. to `/jobs/work/`.
  4. Returns list of chunk paths to Kestra.

#### Phase 3: Execution (Kestra Parallel Loop)
- Kestra uses `parallel` task with `concurrency: 10`.
- Spawns 10 NestJS worker tasks simultaneously, each receiving a `chunk-XXX.json` path.
- **NestJS Worker:**
  1. Reads 1000 records into memory.
  2. Applies business logic (Google API calls, DB updates).
  3. Writes `chunk-XXX-result.json` to `/jobs/out/`. Format: `{"success": 998, "failed": 2, "errors": [...]}`}.
  4. Exits with HTTP 200.

#### Phase 4: Consolidation & Audit
- Kestra parallel tasks complete. Kestra triggers `consolidation` task.
- **NestJS Auditor:**
  1. Reads all files in `/jobs/out/`.
  2. Aggregates success/fail metrics.
  3. Writes atomic consolidated record to `audit_logs` table in Postgres.
  4. Files are moved/marked for archival.
- **Result:** Every execution is permanently logged with exact inputs, outputs, durations, and errors. Kestra's dashboard provides real-time visibility.

---

## 4. Scaling Strategy & Constraints

| Parameter | Value | Reason |
|---|---|---|
| **Chunk Size** | 1000 records | Fits easily in NestJS memory. Matches Google API batch limits. |
| **Concurrent Workers** | 10 (configurable per flow in YAML) | Prevents 429/quota-exceeded from Google. Matches NestJS worker threads. |
| **Retries** | 2-3 per chunk (Kestra `retries: { limit: 2, delay: 30s }`) | Handles transient Google API failures without full flow restart. |
| **Timeout** | Custom per flow (e.g., 300s) | Kestra kills stalled flows and logs exact failure point. |
| **Audit Retention** | Forever | File trail + Postgres logs. Compliance/forensic requirement. |
| **Body Limits** | Never used for bulk | All entity data lives in `/jobs/` directory. API payloads only contain hashes/references. |

---

## 5. Monorepo & Deployment Structure

```
nx-workspace/
  apps/
    frontend/          ← Angular 20 (Material + Tailwind)
    api/               ← NestJS (Auth, RBAC, Internal Job Endpoints)
  libs/
    shared/            ← TS interfaces, DTOs, entity schemas
    kestra/            ← YAML flow definitions (deployed to Kestra volume)
  docker-compose.yml   ← NestJS, Angular(Nginx), Kesta, Postgres, Redis
```

**Deployment Notes:**
- Kestra volume: `/data/jobs` mounted to Docker host. Persists across restarts.
- Nx shares exact TS types for every API contract. Frontend breaks at compile time if API changes.
- Single `docker compose up` spins up the complete self-hosted instance.

---

## 6. Key Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-22 | Frontend = Angular 20 | AI safety, structured patterns, native Signals/RxJS for entity state |
| 2026-07-22 | Kestra = Orchestration only | Declarative YAML, visual dashboard, zero business logic, handles retries/concurrency natively |
| 2026-07-22 | File-driven pipeline for jobs | Handles 500k+ records. Eliminates memory/body crashes. Provides permanent audit trail |
| 2026-07-22 | Postgres/Redis = Entity Cache | Fast UI reads. Jobs only write/audit. Clean separation of concerns |
| 2026-07-22 | NestJS = Strict API Gateway | Validates everything. Exposes internal endpoints for Kesta. No direct Google API calls from routes |
| 2026-08-29 | Grid = ag-grid-community + LibreGrid (`@libregrid/*`) | Enterprise feature set (SSRM, server-side selection, filters, Excel export, charts) as MIT-licensed modules. Matches the server-side selection design for 300k-row grids. Package mapping in planning checklist decision 17.17 |

---

**Next Steps:** 
1. Scaffold Nx monorepo with `apps/frontend`, `apps/api`, `libs/shared/kestra`
2. Draft initial Kestra YAML flows (`bootstrap_sync`, `bulk_update_devices`)
3. Implement NestJS internal job endpoints (`/internal/chunk`, `/internal/worker`, `/internal/audit`)
4. Establish Kestra → NestJS API protocol (auth, payload format, error handling)

*Preserve this document as the single source of truth. Do not branch on technical decisions not recorded here.*
