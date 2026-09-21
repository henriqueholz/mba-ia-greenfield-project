# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/9 completed

### SI-03.1 — Infra: object storage, fila e worker no Docker Compose
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - MinIO images pulled from `quay.io/minio/minio` + `quay.io/minio/mc` — Docker Hub `minio/minio` returned "pull access denied" (MinIO's canonical registry is now quay.io).
  - `video-worker` service inherits the image CMD (`tail -f /dev/null`) for now; its actual worker start command is wired in SI-03.7, keeping SI-03.1 self-contained and matching nestjs-api's exec-based convention.
  - Bucket `streamtube` bootstrapped by a one-shot `createbuckets` service (`mc mb --ignore-existing`, idempotent) + `minio-data` named volume added.

### SI-03.2 — Config: storage e queue configs + validação de env
- **Status:** completed
- **Tests:** 11 passing (env.validation.integration-spec.ts)
- **Observations:**
  - Storage/queue ports + region got Joi defaults (mirroring `DB_PORT`); endpoint/access-key/secret-key/bucket/redis-host are `required`. Expanded the existing test's `requiredEnv` so the pre-existing SWAGGER cases still pass.
  - Registered `storageConfig` + `queueConfig` in `AppModule`'s `ConfigModule.forRoot` load array.

### SI-03.3 — Entidade Video + migration
- **Status:** completed
- **Tests:** 10 passing (video.entity.integration-spec.ts: 6; migrations.integration-spec.ts: 4, incl. 2 new CreateVideos cases)
- **Observations:**
  - `Video.channel` is a unidirectional `@ManyToOne(onDelete: 'CASCADE')` — the reverse `@OneToMany` on `Channel` was intentionally NOT added (keeps the phase-02 `Channel` entity untouched; cascade is enforced at the DB FK).
  - `size_bytes` is `bigint` → typed `string | null` (pg driver returns bigint as string to avoid precision loss).
  - Added a self-contained `CreateVideos migration (integration)` describe block rather than extending the existing phase-02 block (which would break its "revert last migration" assertion); its `beforeAll` also drops leftover enum types for robustness against synchronize-based suites.

### SI-03.4 — Módulo de object storage (adapter MinIO/S3)
- **Status:** completed
- **Tests:** 5 passing (storage.service.integration-spec.ts: 4 real-MinIO; storage.module.spec.ts: 1 compile)
- **Observations:**
  - Installed `@aws-sdk/client-s3@^3.1133.0` + `@aws-sdk/s3-request-presigner@^3.1133.0`. `S3Client` uses `forcePathStyle` + `http://minio:9000` endpoint.
  - `ensureBucket` is idempotent (HeadBucket → CreateBucket, swallowing `BucketAlreadyOwnedByYou`/`Exists`) and runs on `OnModuleInit`; module compile test uses `.compile()` (no init) so it needs no MinIO.
  - `getObject(key, range)` returns `{ body: Readable, contentLength, contentType, contentRange }` for the SI-03.8 Range streaming; integration test verifies a full presigned-multipart round-trip and a `bytes=0-4` range read.

### SI-03.5 — Módulo de fila (BullMQ)
- **Status:** completed
- **Tests:** 1 passing (queue.module.integration-spec.ts — real Redis enqueue)
- **Observations:**
  - Pinned `@nestjs/bullmq@^11.0.5` (NOT ^12): v12 is ESM-only and breaks Jest's CommonJS loader; v11.0.5 is CJS and peers bullmq ^6 + Nest ^11. `library-refs.md` corrected.
  - Pinned `ioredis@^5.4.1` (NOT ^6): typeorm's `peerOptional ioredis@^5.0.4` conflicts with v6 (ERESOLVE); bullmq requires ioredis installed explicitly (peerOptional). `library-refs.md` corrected.
  - Test is `integration-spec` (real Redis connection), not a unit `spec`, per the project's test-type rule (BullMQ opens a Redis connection). Queue name/job constants in `src/queue/queue.constants.ts`.

### SI-03.6 — Endpoints de upload (initiate / complete / delete)
- **Status:** completed
- **Tests:** 15 passing (videos.service.spec.ts: 5 unit; videos.service.integration-spec.ts: 3; videos-upload.e2e-spec.ts: 7)
- **Observations:**
  - Added `ChannelsService.findByUserId` (SRP: channel lookup stays in the channels domain rather than VideosService querying the Channel repo directly).
  - `public_id` via `nanoid@3` `customAlphabet` (11 chars). Part size 100 MiB (≤~103 parts at 10 GiB).
  - VideosModule compilation is asserted inside `videos.service.integration-spec.ts` (a pure unit `.spec.ts` can't compile the module — it needs real TypeORM + BullMQ), rather than a misclassified module spec.
  - Size >10 GiB throws the domain `VIDEO_UPLOAD_TOO_LARGE` (400) in the service, not a generic validation error.

### SI-03.7 — Worker de vídeo (processamento FFmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoints de streaming, download, thumbnail e metadados
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Backstop: limpeza de rascunhos abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
