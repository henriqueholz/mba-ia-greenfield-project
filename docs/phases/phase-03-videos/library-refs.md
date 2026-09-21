---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1133.0"
    context7_id: "unavailable — sourced from npm registry (context7 not configured in .mcp.json)"
    fetched_at: "2026-09-16T11:33:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1133.0"
    context7_id: "unavailable — sourced from npm registry"
    fetched_at: "2026-09-16T11:33:00"
  bullmq:
    version: "^6.3.6"
    context7_id: "unavailable — sourced from npm registry"
    fetched_at: "2026-09-16T11:33:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "unavailable — sourced from npm registry"
    fetched_at: "2026-09-16T11:33:00"
    note: "Pinned to v11 (not v12) at implementation time — v12 is ESM-only (\"type\": \"module\") and breaks Jest's CommonJS loader in this CJS project. v11.0.5 is CJS and peers bullmq ^6 + @nestjs/core ^11."
  ioredis:
    version: "^5.4.1"
    context7_id: "unavailable — sourced from npm registry"
    fetched_at: "2026-09-16T11:33:00"
    note: "Pinned to v5 (not v6) — typeorm's peerOptional is ioredis@^5.0.4; v6 caused ERESOLVE. bullmq needs ioredis installed explicitly (peerOptional). ioredis@5.11.1 satisfies both."
  nanoid:
    version: "^3.3.19"
    context7_id: "unavailable — sourced from npm registry"
    fetched_at: "2026-09-16T11:33:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-16T11:30:15"
---

# phase-03-videos — Library References

> **Sourcing note:** the CLAUDE.md mandates library verification via the **context7** MCP, but `.mcp.json` currently wires only `postgres` (the example file has `figma`, not context7). Versions and compatibility below were verified against the **npm registry** (`npm view`) and official docs on 2026-09-16 as a documented fallback. Before `/implement`, add context7 to `.mcp.json` and re-run `/plan-resolve 03` to replace these entries with context7-fetched docs, OR proceed with these npm-pinned versions.

## Compatibility summary (against installed stack: NestJS 11, TypeScript 5.9, Node 25, CommonJS runtime)

| Library | Pinned | Why this version |
|---------|--------|------------------|
| `@aws-sdk/client-s3` | `^3.1133.0` | AWS SDK v3 modular client; works against MinIO (S3-compatible) and prod S3 unchanged. |
| `@aws-sdk/s3-request-presigner` | `^3.1133.0` | Same v3 line as the client (must match major/minor family). Provides `getSignedUrl`. |
| `bullmq` | `^6.3.6` | Latest BullMQ; satisfied by `@nestjs/bullmq@12` peer range `^3\|\|^4\|\|^5\|\|^6`. |
| `@nestjs/bullmq` | `^12.0.0` | Peer deps: `@nestjs/core/common ^10\|\|^11\|\|^12` → **compatible with NestJS 11** ✓; `bullmq ^6`. |
| `ioredis` | `^6.0.0` | Redis client used as the BullMQ connection (host = Compose service `redis`). |
| `nanoid` | `^3.3.19` | **v3 (CommonJS)** deliberately — nanoid v5/v6 are **ESM-only** and break `require()` in this CJS NestJS runtime (`ERR_REQUIRE_ESM`). Pin the last CJS line. |

**FFmpeg / ffprobe (TD-05):** NOT npm packages — installed as **system binaries** in the worker image (`apt-get install -y ffmpeg`, which provides both `ffmpeg` and `ffprobe`). Invoked via `child_process`. `fluent-ffmpeg` is intentionally NOT used (archived/unmaintained since May 2025).

---

## @aws-sdk/client-s3 (`^3.1133.0`)

**Usage in this phase (TD-01, TD-03, TD-07):** S3-compatible object storage client for MinIO (dev) / S3 (prod).

- **Client config for MinIO** (host = Compose service `minio`, per Docker networking rule — never `localhost`):
  ```ts
  new S3Client({
    endpoint: `http://${cfg.endpoint}:${cfg.port}`, // e.g. http://minio:9000
    region: cfg.region ?? 'us-east-1',
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: true, // REQUIRED for MinIO (path-style, not virtual-host)
  });
  ```
- **Multipart upload (TD-03):** `CreateMultipartUploadCommand` → returns `UploadId`; per part `UploadPartCommand` (presigned, see presigner); `CompleteMultipartUploadCommand` with `{ MultipartUpload: { Parts: [{ ETag, PartNumber }] } }`; `AbortMultipartUploadCommand` on cleanup.
- **Range streaming (TD-07):** `GetObjectCommand` with `Range: 'bytes=start-end'` → response `Body` is a Node `Readable` (`.transformToWebStream()` or pipe); read `ContentLength`, `ContentRange`.
- **Thumbnail upload / object ops:** `PutObjectCommand`, `HeadObjectCommand`.
- **Bucket bootstrap:** `HeadBucketCommand` / `CreateBucketCommand` on startup (idempotent ensure-bucket).

## @aws-sdk/s3-request-presigner (`^3.1133.0`)

**Usage (TD-03):** generate short-lived presigned URLs so the client uploads parts **directly** to storage.

- `getSignedUrl(s3Client, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 900 })` → one URL per part (5–15 min expiry). Client PUTs each part to its URL and collects the returned `ETag` header.
- Also usable for presigned `GetObjectCommand` if the streaming strategy ever switches to presigned-direct (TD-07 Option B, noted as future scale path).

## bullmq (`^6.3.6`)

**Usage (TD-02, TD-04, TD-05, TD-08):** Redis-backed job queue; producer in the API, consumer in the worker.

- **Connection:** `{ connection: { host: 'redis', port: 6379 } }` (Compose service name).
- **Enqueue (producer):** `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false })`. `jobId: videoId` gives idempotency (TD-08).
- **Consume (worker):** `new Worker('video-processing', async (job) => {...}, { connection, concurrency: N })`; throw to trigger retry; after `attempts` exhausted the job is `failed` → map to video `status=failed` + `failure_reason` via the `failed` event.
- **Events:** `worker.on('failed', (job, err) => ...)`, `'completed'`.

## @nestjs/bullmq (`^12.0.0`)

**Usage (TD-02):** NestJS DI wrapper around BullMQ.

- **Root:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })` — follow the phase-01 namespaced-config convention (`src/config/queue.config.ts`).
- **Register queue:** `BullModule.registerQueue({ name: 'video-processing' })` in `VideosModule` (and the worker module).
- **Producer inject:** `@InjectQueue('video-processing') private queue: Queue`.
- **Consumer:** `@Processor('video-processing') export class VideoProcessor extends WorkerHost { async process(job: Job) {...} }`.
- **Peer compat:** requires `@nestjs/core`/`@nestjs/common` ^11 (installed) and `bullmq` ^6 (pinned) ✓.

## ioredis (`^6.0.0`)

**Usage (TD-02):** the Redis client backing the BullMQ connection. Usually passed as connection options `{ host, port }` (BullMQ constructs the ioredis client), or an explicit `new Redis(...)` shared instance. Host = Compose service `redis`. For BullMQ, ensure `maxRetriesPerRequest: null` when passing a manual connection.

## nanoid (`^3.3.19`)

**Usage (TD-06):** generate the short, opaque, non-enumerable public video id.

- **CommonJS import (this runtime):** `const { nanoid, customAlphabet } = require('nanoid')` / `import { nanoid, customAlphabet } from 'nanoid'` compiled to CJS. **Pin v3** — v5/v6 are ESM-only and fail under `require()`.
- **Default:** `nanoid()` → 21-char URL-safe id; or `customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 11)()` → 11-char YouTube-style code.
- Store in a `public_id` column with a **unique index**; on the astronomically-rare insert conflict, regenerate and retry.
