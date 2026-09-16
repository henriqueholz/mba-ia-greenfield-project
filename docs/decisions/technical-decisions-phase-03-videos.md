---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-16
scope_description: "Backend foundation for video upload and processing: object-storage organization, background-job queue technology, 10GB async/direct upload strategy, processing trigger, video worker + FFmpeg metadata/thumbnail extraction, unique public URL, streaming (HTTP Range/206) and download delivery, and the video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (upload initiation, completion, streaming, download), the object-storage integration, the processing queue (producer in the API), and the video worker (queue consumer running FFmpeg). New infrastructure (object storage, queue broker, worker) is added to `nestjs-project/compose.yaml`.
- `next-frontend/` — Frontend deferred: the video UI (upload widget, player page) is out of scope for Phase 03 per the phase brief (this is a backend phase). Where a decision is a client↔server contract (upload handshake, streaming), the contract is defined here so a future frontend phase can consume it without reopening the decision. No open frontend decision in this document.

> **Inherited (not reopened):** ConfigModule + Joi env validation and namespaced configs (`phase-01-configuracao-base/TD-*`); TypeORM Data Mapper + migrations + shared data-source (phase 01); global JWT guard with a public-route opt-out, domain-exception filter, global ValidationPipe, and `@nestjs/throttler` rate limiting (`phase-02-auth/TD-*`); videos belong to a channel via the existing 1:1 user→channel relation. Video endpoints reuse all of the above. Object storage is **fixed** by the project plan to S3-compatible (MinIO locally, S3 in prod) — the storage *engine* is not an open decision; how it is organized and accessed (TD-01) is.
>
> **Tooling note (context7):** the CLAUDE.md mandates library verification via the context7 MCP, but `.mcp.json` currently wires only `postgres`. Library facts below were verified via primary sources / web research (Sept 2026). Version pinning of the newly-chosen libraries is deferred to `/plan-resolve` (`library-refs.md`), which needs context7 added to `.mcp.json` (or a documented web-source fallback).

---

## TD-01: Object-storage organization and access

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Every other decision (upload, worker, streaming) reads or writes storage objects, so the SDK, bucket layout, and key scheme are a cross-component contract shared by the API and the worker. The storage engine is fixed (MinIO/S3); the open choice is the client library and the bucket/key organization.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), single bucket, prefixed opaque keys
- Use the official AWS SDK v3 against the MinIO endpoint; one bucket (e.g. `streamtube`) with key prefixes `videos/<id>/original` and `thumbnails/<id>.jpg`; keys derived from an opaque id, never the filename.
- **Pros:** Same code path for MinIO and real S3 (only endpoint/credentials change); first-class presigned **multipart** support (needed by TD-03); modular tree-shakeable packages; portable to prod S3 with zero code change.
- **Cons:** Verbose command API; must configure `forcePathStyle: true` for MinIO.

### Option B: MinIO SDK (`minio` npm package)
- Use MinIO's own client; helper methods like `presignedPutObject`, `presignedGetObject`, `fPutObject`.
- **Pros:** Ergonomic helpers; built for MinIO; simple presigned single-object URLs.
- **Cons:** Ties code to the MinIO client even though prod is AWS S3; multipart-presigned-per-part flow is less first-class than AWS SDK v3; a second migration cost later.

### Option C: Separate buckets per asset type (videos vs thumbnails), AWS SDK v3
- Two buckets (`streamtube-videos`, `streamtube-thumbnails`) instead of prefixes.
- **Pros:** Coarse-grained lifecycle/policy separation per asset type.
- **Cons:** More buckets to provision/bootstrap in Compose; no real benefit at this scale; prefixes already give logical separation.

**Recommendation:** Option A — AWS SDK v3 keeps a single portable code path from MinIO (dev) to S3 (prod), and its presigned-multipart support is a prerequisite for the 10GB upload in TD-03; one bucket with `videos/`/`thumbnails/` prefixes and opaque id-based keys avoids name collisions and enumeration.

**Decision:** A (AWS SDK v3, single bucket + prefixed opaque keys)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Background-processing queue technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** This is the phase's principal stack decision — the project plan and architecture diagram leave the queue explicitly **TBD**. The API (producer) enqueues a job when an upload completes; a separate worker (consumer) processes it. The choice drives new Compose infrastructure, the retry/concurrency model, and the API↔worker contract.

**Options:**

### Option A: BullMQ + Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue (successor to Bull); first-class NestJS module (`@nestjs/bullmq`) with `@Processor`/`WorkerHost`; built-in retries with backoff, concurrency, delayed/repeatable jobs, events, and dashboards (Bull Board).
- **Pros:** Purpose-built for background jobs; NestJS-native DI integration; robust retry/backoff/concurrency ideal for long video jobs; clean API↔worker decoupling; large ecosystem.
- **Cons:** Adds Redis as a new Compose service and a runtime dependency.

### Option B: pg-boss (PostgreSQL-backed queue)
- Uses the existing Postgres via `SKIP LOCKED`; ACID job state; supports retries, scheduling, archiving.
- **Pros:** **No new infrastructure** — reuses the DB already in the stack; ACID guarantees; transactional enqueue alongside the video row.
- **Cons:** No official NestJS module (manual integration); throughput bounded by Postgres (fine for video volume, but fewer job-processing ergonomics); worker concurrency/events less rich than BullMQ.

### Option C: RabbitMQ (`amqplib` / `@nestjs/microservices`)
- Dedicated AMQP broker; NestJS microservice transport.
- **Pros:** Mature broker; flexible routing; strong delivery guarantees.
- **Cons:** Heaviest operationally (broker + management); routing/exchange complexity is overkill for a single video-processing queue; retry/backoff needs more manual wiring than BullMQ.

**Recommendation:** Option A — BullMQ's NestJS-native integration, retry/backoff, and worker concurrency fit a long-running video pipeline better than the alternatives, and cleanly separate the API from the worker; Redis is a small, standard Compose addition. Option B (pg-boss) is the strong runner-up if avoiding new infrastructure is prioritized over job-processing ergonomics.

**Decision:** A (BullMQ + Redis)
**Libraries:** bullmq, @nestjs/bullmq, ioredis

---

## TD-03: 10GB upload strategy (async / direct-to-storage)

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A 10GB file must never stream through the API process (memory/latency/timeout — the "sem travar" requirement). A single presigned `PUT` is capped at **5GB** by S3/MinIO, so 10GB forces a multipart strategy. This is the client↔API↔storage contract, and it must also pre-register the video as a draft when the upload starts.

**Options:**

### Option A: Presigned **multipart** upload direct to storage
- API `initiate` creates the video row (`status=draft`) + `CreateMultipartUpload`, returns `uploadId` + presigned `UploadPart` URLs; the client uploads parts (5MB–5GB each, ≤10,000 parts) **directly to MinIO**; client then calls `complete` with the part ETags; API runs `CompleteMultipartUpload`.
- **Pros:** Bytes never touch the API (true "sem travar"); native S3/MinIO support >5GB; per-part retry/resume; parallel part uploads; draft row created at initiate.
- **Cons:** Multi-step handshake (initiate → parts → complete); client must track part ETags.

### Option B: tus resumable upload protocol (`@tus/server`)
- Run a tus endpoint; client uploads in resumable chunks over the tus protocol; a storage adapter persists to S3/MinIO.
- **Pros:** Robust resumability/pause across network drops; single well-defined protocol.
- **Cons:** Adds a protocol + server dependency to maintain; the tus endpoint (if hosted in the API) can still put load on the API tier unless carefully offloaded; heavier than needed given S3 multipart already provides resumable parts.

### Option C: Proxy multipart/form-data streamed through the API to storage
- Client uploads to the API; API streams the request body straight into a storage multipart upload.
- **Pros:** Simplest single-request client contract; no presigned-URL handshake.
- **Cons:** **Violates the requirement** — 10GB flows through the API (connection held open for the whole transfer, timeout/backpressure/scaling risk). Rejected for the 10GB target; acceptable only for tiny files.

**Recommendation:** Option A — presigned multipart is the only option that keeps a 10GB transfer entirely off the API while natively exceeding the 5GB single-PUT ceiling and giving per-part retry; the `initiate` step is where the draft row is pre-created. tus (B) is a reasonable resumability upgrade later but adds a protocol dependency for a guarantee S3 multipart already provides; C is disqualified by the "sem travar" rule.

**Decision:** A (presigned multipart, direct-to-storage)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-04: Upload-completion → processing trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After the direct-to-storage upload finishes, something must transition the video to `processing` and enqueue the worker job. How that trigger fires is a contract between the client, the API, storage, and the queue (TD-02). Depends on TD-03.

**Options:**

### Option A: Explicit `complete` endpoint enqueues the job
- Client calls `POST /videos/:id/complete` with the part ETags; the API runs `CompleteMultipartUpload`, sets `status=processing`, and enqueues the BullMQ job in the same request.
- **Pros:** Deterministic and synchronous with the handshake; no extra storage wiring; enqueue can be transactional with the status change; easy to test end-to-end.
- **Cons:** Relies on the client calling `complete` (mitigated by orphan-cleanup of stale drafts).

### Option B: Storage bucket notifications (MinIO events) trigger the API
- MinIO emits an `s3:ObjectCreated:*` event (webhook/AMQP) on final object; the API receives it and enqueues.
- **Pros:** Fires even if the client never calls back; decoupled from the client.
- **Cons:** Requires configuring MinIO event targets (extra infra + a receiver endpoint); harder to test locally; the multipart `complete` step is still client-driven, so the event mostly duplicates A.

### Option C: Periodic reconciliation poller
- A scheduled job scans drafts whose objects exist and enqueues them.
- **Pros:** Resilient backstop; no client dependency.
- **Cons:** Latency (poll interval); wasteful scanning; poor as the primary path (good only as a cleanup backstop).

**Recommendation:** Option A — an explicit `complete` endpoint is the simplest deterministic trigger, needs no MinIO event wiring, and lets the status transition + enqueue happen together; a lightweight scheduled cleanup of stale `draft` rows (C as a backstop) covers abandoned uploads.

**Decision:** A (explicit `complete` endpoint enqueues the job; scheduled cleanup of stale drafts as backstop)

---

## TD-05: Video worker execution model and media processing (FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The queue consumer must run outside the API request path, extract duration/metadata, and generate a thumbnail from a frame. Two coupled choices: where the worker runs, and how it invokes FFmpeg. Depends on TD-01 and TD-02.

**Options:**

### Option A: Separate worker container + direct `child_process` spawn of `ffmpeg`/`ffprobe`
- A dedicated Compose service (reusing the same codebase/image, different entry command) boots a Nest standalone app hosting the BullMQ `WorkerHost`; it downloads the object (or reads via presigned URL), runs `ffprobe -print_format json -show_format -show_streams` for duration/metadata and `ffmpeg -ss <t> -frames:v 1` for the thumbnail, then uploads the thumbnail and updates the row.
- **Pros:** Full isolation from the API (CPU-heavy FFmpeg never blocks HTTP); horizontally scalable independently; `ffprobe`/`ffmpeg` binaries are the canonical, fully-supported interface; reuses Nest DI/config/repositories.
- **Cons:** Worker image must bundle the FFmpeg binaries; must manage temp files / streaming and process lifecycle manually.

### Option B: `fluent-ffmpeg` wrapper in the worker
- Use the `fluent-ffmpeg` fluent API instead of raw spawns.
- **Pros:** Higher-level chainable API; familiar in tutorials.
- **Cons:** **Archived (read-only) since May 2025**, unmaintained, and documented as not working reliably with recent FFmpeg — a dead dependency for new code. Rejected.

### Option C: `ffmpeg.wasm` (in-process WebAssembly) in the API or worker
- Run FFmpeg compiled to WASM in Node, no system binary.
- **Pros:** No native binary to install; pure-JS deploy.
- **Cons:** Far slower and memory-heavy; impractical for multi-GB inputs; unsuitable for a 10GB pipeline. Rejected.

**Recommendation:** Option A — a separate worker container running the same image with an FFmpeg install, invoking `ffprobe`/`ffmpeg` via `child_process`, keeps heavy processing off the API, scales independently, and uses the canonical FFmpeg interface; `fluent-ffmpeg` is disqualified by its archival and `ffmpeg.wasm` by performance.

**Decision:** A (separate worker container + `child_process` ffmpeg/ffprobe; ffmpeg installed in the worker image)
**Libraries:** ffmpeg (system binary, apt), ffprobe (system binary, apt)

---

## TD-06: Unique public video URL / identifier strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, non-conflicting public identifier used in its URL (watch/stream/download). The choice affects the data model (TD's Data Model in plan-build), enumerability, and URL aesthetics.

**Options:**

### Option A: UUID v4 primary key used directly as the public id
- The internal `uuid` PK is also the public URL segment (`/videos/<uuid>`).
- **Pros:** Zero extra work; uniqueness guaranteed by the PK; non-sequential (not enumerable); consistent with existing entities (users/channels use uuid PKs).
- **Cons:** Long, opaque, un-YouTube-like URLs (36 chars).

### Option B: Dedicated short public code (`nanoid`) alongside the uuid PK
- Keep the uuid PK internal; add a unique `public_id` column, an ~11-char URL-safe `nanoid`, used in all public URLs.
- **Pros:** Short, opaque, YouTube-style URLs; non-enumerable; collision probability negligible with a unique index + retry-on-conflict; internal PK stays stable for FKs.
- **Cons:** A second identifier to generate and index; must handle the (astronomically rare) unique-collision on insert.

### Option C: Hashids/obfuscated sequential id
- A numeric sequential id encoded via a reversible hash for the URL.
- **Pros:** Compact.
- **Cons:** Reversible/enumerable if the salt leaks; introduces a sequential id where the project otherwise uses uuids — inconsistent; weakest privacy.

**Recommendation:** Option B — a dedicated `nanoid` public code gives short, opaque, YouTube-like non-enumerable URLs while keeping the stable uuid PK for internal FKs, with a unique index guaranteeing no conflict. Option A is the zero-cost, equally-correct fallback if URL aesthetics are not valued; C is rejected for enumerability/inconsistency.

**Decision:** B (`nanoid` public code + uuid PK)
**Libraries:** nanoid

---

## TD-07: Streaming and download delivery

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must stream without a full download (seek support), and users must be able to download the file. Both read from storage; the question is whether the API mediates the byte transfer or hands the client a direct storage URL. This is the watch/download contract (anonymous access is allowed for watching, per the project plan). Depends on TD-01.

**Options:**

### Option A: API-mediated HTTP Range → 206 Partial Content
- The stream endpoint reads the client `Range` header, calls storage `GetObject` with `Range: bytes=start-end`, and pipes the partial stream back with `206`, `Content-Range`, `Accept-Ranges: bytes`, `Content-Length` (NestJS `StreamableFile`). Download is the same stream with `Content-Disposition: attachment` (or a full-body 200).
- **Pros:** API stays in control (auth/visibility rules, view metrics, hides storage location/credentials); directly matches the assignment's "range / 206" framing; single origin for the client; supports seek natively.
- **Cons:** Video bytes proxy through the API tier (bandwidth/CPU cost at scale).

### Option B: Presigned `GetObject` URL — client streams directly from MinIO
- The endpoint returns (or 302-redirects to) a short-lived presigned URL; MinIO/S3 serves Range/206 and download natively.
- **Pros:** Offloads all bandwidth from the API; storage handles Range/206 and resumable download natively; scales best.
- **Cons:** Temporarily exposes a storage URL; harder to enforce per-request rules or count views; URL expiry/refresh handling on the client.

### Option C: Hybrid — proxy streaming (A) for the player, presigned (B) for download
- Watch goes through the API (control), download hands out a presigned URL (offload).
- **Pros:** Control where it matters (playback) + bandwidth offload for large downloads.
- **Cons:** Two code paths and two contracts to maintain/test.

**Recommendation:** Option A for both streaming and download — API-mediated Range/206 keeps the API in control of access and view accounting, matches the phase's explicit 206 framing, and is simplest to test against the Compose stack; note Option B as the production-scalable evolution if API egress becomes a bottleneck.

**Decision:** A (API-mediated HTTP Range → 206 Partial Content for streaming and download; presigned-direct noted as future scale path)

---

## TD-08: Video status lifecycle and failure handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row moves through distinct states from upload start to playable, and processing can fail. The state set and failure policy are a contract consumed by the API (responses), the worker (transitions), and a future frontend (status display). Depends on TD-02, TD-03, TD-04, TD-05.

**Options:**

### Option A: `draft → processing → ready | failed`, with worker retry + `failure_reason`
- `draft` on initiate; `processing` on `complete`/enqueue; `ready` on worker success; `failed` on terminal error. BullMQ retries (e.g. 3 attempts, exponential backoff) before `failed`; the row records `failure_reason`; jobs keyed by video id for idempotency; a re-process path can requeue a `failed` video.
- **Pros:** Exactly matches the brief's "rascunho → processando → pronto/erro"; small, clear enum; retry/backoff via BullMQ; recoverable failures; idempotent by design.
- **Cons:** Needs a `failure_reason` field and a documented retry policy.

### Option B: Granular states (`uploading, uploaded, processing, ready, failed`)
- Adds `uploading`/`uploaded` around the direct upload.
- **Pros:** Finer progress visibility.
- **Cons:** The `uploading`↔`uploaded` distinction duplicates what the storage multipart state already tracks; more transitions to manage for little gain this phase.

### Option C: Minimal (`processing → ready | failed`), no explicit draft
- Row created already `processing`; no `draft`.
- **Pros:** Fewer states.
- **Cons:** **Contradicts** the explicit "pré-cadastro como rascunho" capability; loses the abandoned-upload distinction. Rejected.

**Recommendation:** Option A — it maps one-to-one to the required lifecycle wording, keeps the enum minimal, and pairs a `failed` terminal state with BullMQ retry/backoff, a stored `failure_reason`, id-keyed idempotency, and a requeue path. Option B can be adopted later if per-step upload progress is surfaced; C is disqualified by the mandated draft state.

**Decision:** A (draft → processing → ready | failed; BullMQ retry + backoff, `failure_reason` stored, job keyed by video id for idempotency, requeue path)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object-storage organization and access | Option A — AWS SDK v3, single bucket, prefixed opaque keys | A |
| TD-02 | Backend | Background-processing queue technology | Option A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-03 | Backend | 10GB upload strategy (async/direct) | Option A — presigned multipart direct to storage | A |
| TD-04 | Backend | Upload-completion → processing trigger | Option A — explicit `complete` endpoint enqueues job | A |
| TD-05 | Backend | Worker execution model + FFmpeg processing | Option A — separate worker container + `child_process` ffmpeg/ffprobe | A |
| TD-06 | Backend | Unique public video URL / identifier | Option B — `nanoid` public code + uuid PK | B |
| TD-07 | Backend | Streaming and download delivery | Option A — API-mediated Range/206 (presigned as future scale path) | A |
| TD-08 | Backend | Video status lifecycle and failure handling | Option A — draft→processing→ready\|failed + retry/failure_reason | A |
