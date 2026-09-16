---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-16T11:32:33"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-16T11:34:44"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-16T11:30:15"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-16T09:59:03"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend for video upload and processing: non-blocking upload of files up to 10GB via presigned S3/MinIO **multipart directly to object storage** with the video pre-registered as a **draft**, automatic **asynchronous processing** (duration/metadata extraction + thumbnail generation) by a **queue-driven FFmpeg worker**, a **unique public URL** per video, and **HTTP Range streaming + download** — with object storage (MinIO), the queue broker (Redis/BullMQ), and the worker all running in Docker Compose alongside the API.

---

## Step Implementations

### SI-03.1 — Infra: object storage, fila e worker no Docker Compose

**Description:** Subir a infraestrutura nova da fase (MinIO, Redis e o container do worker) no `compose.yaml`, e garantir FFmpeg na imagem — pré-requisito de todo o resto.

**Technical actions:**

1. Adicionar o serviço `minio` (portas 9000/9001, credenciais, volume) ao `nestjs-project/compose.yaml` e um passo de bootstrap do bucket `streamtube` (per `phase-03-videos/TD-01`).
2. Adicionar o serviço `redis` (imagem `redis`, porta 6379) ao `compose.yaml` como broker da fila (per `phase-03-videos/TD-02`).
3. Adicionar o serviço `video-worker` ao `compose.yaml` — mesma imagem da API, `command` executando o bootstrap do worker, `depends_on` db/redis/minio (per `phase-03-videos/TD-05`).
4. Instalar `ffmpeg` (que provê `ffmpeg` + `ffprobe`) no `Dockerfile.dev` via `apt-get`, para que o worker tenha os binários (per `phase-03-videos/TD-05`).
5. Estender `.env.example` com as chaves de storage (`STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`) e de fila (`REDIS_HOST`, `REDIS_PORT`), usando os service names do Compose como host (`minio`, `redis`).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `redis`, `nestjs-api` e `video-worker` todos com status `running`.
- `docker compose exec nestjs-api sh -c "ffmpeg -version && ffprobe -version"` retorna versão (binários presentes na imagem).
- O bucket `streamtube` existe no MinIO após o startup (bootstrap idempotente).
- `.env.example` documenta todas as variáveis novas de storage e redis com hosts = service names do Compose.

---

### SI-03.2 — Config: storage e queue configs + validação de env

**Description:** Adicionar os configs namespaced de storage e fila e estender o schema Joi de env, seguindo a convenção herdada (`registerAs` por domínio em `src/config/`).

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint, port, accessKey, secretKey, bucket, region, forcePathStyle: true }))` lendo `STORAGE_*` (per `phase-03-videos/TD-01`; convenção herdada de config namespaced).
2. Criar `src/config/queue.config.ts` — `registerAs('queue', () => ({ host, port }))` lendo `REDIS_*` (per `phase-03-videos/TD-02`).
3. Estender `src/config/env.validation.ts` (schema Joi) com `STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`, `REDIS_HOST`, `REDIS_PORT` — todos `required` (convenção herdada de validação de env).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` | Integration: boot falha quando faltam as vars de storage/redis; passa quando presentes | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Com todas as vars presentes, a aplicação inicializa e `ConfigType<typeof storageConfig>` / `queueConfig` expõem os valores corretos.
- Removendo qualquer var obrigatória de storage ou redis, o boot falha na validação Joi com mensagem citando a chave ausente.

---

### SI-03.3 — Entidade Video + migration

**Description:** Criar a entidade `Video` ligada ao canal e a migration que cria a tabela, o enum de status e os índices.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme o Data Model (uuid PK, `public_id` único, `channel_id` FK → `Channel`, `status` enum default `draft`, chaves de storage, metadados, `failure_reason`, timestamps) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`).
2. Criar migration `src/database/migrations/<timestamp>-CreateVideos.ts` — cria o enum `videos_status_enum`, a tabela `videos`, o índice único em `public_id`, índices em `channel_id` e `status`, e a FK `channel_id → channels(id) ON DELETE CASCADE` (Data Model → Indexes/Enum).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration (real DB): default `status='draft'`, unicidade de `public_id`, FK/cascade para `Channel`, timestamps | `src/videos/entities/video.entity.integration-spec.ts` |
| migration `CreateVideos` | Integration (real DB): `up` cria tabela + enum + índices; `down` reverte | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none _(a tabela `channels` já existe desde a Fase 02)_

**Acceptance criteria:**

- Após `npm run migration:run`, a tabela `videos` existe com o enum `videos_status_enum` e os índices esperados (único em `public_id`, índices em `channel_id` e `status`).
- Inserir dois vídeos com o mesmo `public_id` viola a constraint de unicidade.
- Um `Video` sem `status` explícito persiste com `status='draft'`.
- Remover um `Channel` remove (cascade) os seus vídeos.

---

### SI-03.4 — Módulo de object storage (adapter MinIO/S3)

**Description:** Encapsular o acesso ao MinIO/S3 num `StorageService` com AWS SDK v3: bootstrap de bucket, multipart presignado, leitura por range e upload de thumbnail.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — `S3Client` configurado do `storageConfig` (`forcePathStyle: true`, endpoint = service `minio`) e métodos `ensureBucket`, `createMultipartUpload`, `presignUploadParts`, `completeMultipartUpload`, `abortMultipartUpload`, `getObjectRange`, `putObject`, `deleteObjects` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-07`; libs `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
2. Criar `src/storage/storage.module.ts` — importa `ConfigModule`, provê e exporta `StorageService`; `ensureBucket` no bootstrap (`OnModuleInit`).
3. Registrar `StorageModule` em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (real MinIO): round-trip multipart (create→presign→PUT parts→complete), `getObjectRange` retorna bytes corretos, `ensureBucket` idempotente, `abortMultipartUpload` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação (DI wiring) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 _(usa `storageConfig`)_

**Acceptance criteria:**

- Um upload multipart de um objeto de teste via URLs presignadas e posterior `complete` resulta num objeto íntegro no bucket (bytes idênticos ao original).
- `getObjectRange(key, start, end)` retorna exatamente a fatia de bytes solicitada e o `ContentRange` correspondente.
- `ensureBucket` executado duas vezes não falha (idempotente) e o bucket existe após o boot.

---

### SI-03.5 — Módulo de fila (BullMQ)

**Description:** Configurar o BullMQ sobre Redis e registrar a fila `video-processing`, compartilhada entre produtor (API) e consumidor (worker).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` (connection do `queueConfig`, host = service `redis`) + `BullModule.registerQueue({ name: 'video-processing' })`; exportar para reuso (per `phase-03-videos/TD-02`; libs `bullmq`, `@nestjs/bullmq`, `ioredis`).
2. Registrar `QueueModule` em `AppModule` (e reutilizado pelo módulo do worker em SI-03.7).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação (`forRootAsync` + `registerQueue` wiring) | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.2 _(usa `queueConfig`)_

**Acceptance criteria:**

- `QueueModule` compila com a conexão Redis resolvida do config e a fila `video-processing` registrada e injetável via `@InjectQueue('video-processing')`.
- Um teste de compilação do módulo sobe sem erro de DI.

---

### SI-03.6 — Endpoints de upload (initiate / complete / delete)

**Description:** Implementar o handshake de upload direto: pré-cadastro do vídeo como rascunho + URLs presignadas multipart no initiate, finalização + enfileiramento no complete, e abort/delete.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` — `initiate` (gera `public_id` com `nanoid` per `phase-03-videos/TD-06`, cria row `status=draft`, `createMultipartUpload`, presigna as partes), `complete` (valida dono, `completeMultipartUpload`, transiciona `draft→processing`, enfileira `process-video` com `jobId=videoId` per `phase-03-videos/TD-04`/`TD-08`), `remove` (abort + `deleteObjects` + delete row) (per `phase-03-videos/TD-03`).
2. Criar DTOs `src/videos/dto/initiate-upload.dto.ts` e `complete-upload.dto.ts` conforme `### API Contracts → Validation Rules` (class-validator, convenção herdada).
3. Criar `src/videos/videos.controller.ts` — `POST /videos`, `POST /videos/:publicId/complete`, `DELETE /videos/:publicId` conforme `### API Contracts` e `### Authorization Matrix`; erros de domínio conforme `### Error Catalog` (per `phase-02-auth/TD-07`).
4. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` + `StorageModule` + `QueueModule` (`@InjectQueue('video-processing')`); registrar em `AppModule`.
5. Documentar os endpoints com decorators `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: ramos de dono/estado/tamanho (mock repo+storage+queue) — `VIDEO_NOT_OWNED`, `VIDEO_INVALID_STATE`, `VIDEO_UPLOAD_TOO_LARGE` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (real DB+MinIO+Redis): initiate cria draft + multipart; complete transiciona e enfileira o job | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação (`forFeature` + `StorageModule` + `QueueModule`) | `src/videos/videos.module.spec.ts` |
| `POST /videos`, `/complete`, `DELETE /videos/:publicId` | E2E (supertest): 201 draft, 200 processing, 204; 401 sem token; 403 não-dono; 409 estado inválido; 400 validação/too-large | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` autenticado com corpo válido retorna `201` com `id` (public_id), `uploadId` e a lista de `parts` presignadas, e cria a row com `status=draft`.
- `POST /videos` com `size` > 10 GiB retorna `400` com `error: "VIDEO_UPLOAD_TOO_LARGE"`.
- `POST /videos/:publicId/complete` do dono com as ETags retorna `200` com `status: "processing"` e enfileira exatamente um job `process-video`.
- `POST /videos/:publicId/complete` por um usuário que não é dono retorna `403` com `error: "VIDEO_NOT_OWNED"`.
- `POST /videos` sem token retorna `401`.
- `DELETE /videos/:publicId` do dono retorna `204` e remove row + objetos.

---

### SI-03.7 — Worker de vídeo (processamento FFmpeg)

**Description:** Implementar o consumidor da fila que roda num container separado: extrai duração/metadados com `ffprobe`, gera thumbnail com `ffmpeg`, atualiza o status e trata falhas.

**Technical actions:**

1. Criar `src/worker/media.service.ts` — `spawn` de `ffprobe` (`-print_format json -show_format -show_streams` → duração/width/height/metadata) e de `ffmpeg` (`-ss <t> -frames:v 1` → thumbnail JPEG) via `child_process` (per `phase-03-videos/TD-05`; binários do SI-03.1).
2. Criar `src/worker/video.processor.ts` — `@Processor('video-processing')` `WorkerHost`: lê o objeto do storage, roda `MediaService`, faz upload do thumbnail (`thumbnail_key`), seta `status=ready` + duração/metadados; em falha terminal seta `status=failed` + `failure_reason` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`).
3. Criar `src/worker/worker.module.ts` — `TypeOrmModule.forFeature([Video])` + `StorageModule` + `QueueModule`.
4. Criar `src/main.worker.ts` — bootstrap standalone (`NestFactory.createApplicationContext`) que sobe só o worker (per `phase-03-videos/TD-05`).
5. Adicionar script `start:worker` (e `start:worker:dev`) ao `package.json`, usado pelo `command` do serviço `video-worker`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` | Integration (real ffmpeg/ffprobe): extrai duração/dimensões de um sample e gera um thumbnail JPEG válido | `src/worker/media.service.integration-spec.ts` |
| `VideoProcessor` | Integration (real DB+MinIO+Redis+ffmpeg): job de um sample enviado → `status=ready` + duração + `thumbnail_key`; input inválido → `status=failed` + `failure_reason` | `src/worker/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- Após um upload completo de um vídeo de teste, o worker consome o job e o vídeo fica com `status=ready`, `duration_seconds` > 0 e `thumbnail_key` preenchido, com o objeto de thumbnail presente no storage.
- Um objeto inválido (não-vídeo) leva o job a esgotar as tentativas e o vídeo a `status=failed` com `failure_reason` não-nulo.
- Reprocessar o mesmo `videoId` (mesmo `jobId`) não duplica trabalho (idempotência).

---

### SI-03.8 — Endpoints de streaming, download, thumbnail e metadados

**Description:** Entregar a reprodução via streaming com HTTP Range (206), o download, o thumbnail e os metadados do vídeo, com acesso anônimo para vídeos `ready`.

**Technical actions:**

1. Adicionar ao `videos.service.ts` os métodos de leitura pública: resolver por `public_id`, aplicar visibilidade (`ready` para anônimo / dono vê qualquer estado) e `getObjectRange` do storage; parse/validação do header `Range` (per `phase-03-videos/TD-07`).
2. Adicionar ao `videos.controller.ts` as rotas `GET /videos/:publicId`, `GET /videos/:publicId/stream`, `GET /videos/:publicId/download`, `GET /videos/:publicId/thumbnail` conforme `### API Contracts`: `206` + `Content-Range`/`Accept-Ranges` quando há `Range`, `200` completo caso contrário, `Content-Disposition: attachment` no download, `StreamableFile` (rotas públicas via opt-out do guard global).
3. Mapear `VIDEO_NOT_FOUND` (404), `VIDEO_NOT_READY` (409) e `INVALID_RANGE` (416) via exceções de domínio conforme `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: parse de `Range` + gating de visibilidade `ready`/dono (mock storage/repo) | `src/videos/videos.service.spec.ts` |
| `GET /videos/:publicId(/stream\|/download\|/thumbnail)` | E2E (supertest): `206` com `Content-Range` para request com `Range`; `200` completo sem `Range`; `attachment` no download; acesso anônimo a `ready`; `404`/`409`/`416` nos casos negativos | `test/videos-playback.e2e-spec.ts` |

**Dependencies:** SI-03.6, SI-03.4, SI-03.7

**Acceptance criteria:**

- `GET /videos/:publicId/stream` com `Range: bytes=0-1023` num vídeo `ready` retorna `206`, `Content-Range: bytes 0-1023/<total>`, `Accept-Ranges: bytes` e exatamente 1024 bytes.
- `GET /videos/:publicId/stream` sem `Range` retorna `200` com o corpo completo e `Accept-Ranges: bytes`.
- `GET /videos/:publicId/download` retorna o arquivo com `Content-Disposition: attachment; filename="..."`.
- `GET /videos/:publicId` num vídeo `ready` é acessível anonimamente e retorna os metadados (incluindo `durationSeconds` e `thumbnailUrl`).
- `GET /videos/:publicId/stream` de um vídeo não-`ready` por anônimo retorna `409 VIDEO_NOT_READY`; `publicId` inexistente retorna `404`; `Range` inválido retorna `416`.

---

### SI-03.9 — Backstop: limpeza de rascunhos abandonados

**Description:** Cobrir uploads abandonados (cliente que nunca chama `complete`) com uma tarefa agendada que aborta o multipart e remove drafts expirados — o backstop previsto em `phase-03-videos/TD-04`.

**Technical actions:**

1. Habilitar `@nestjs/schedule` (`ScheduleModule.forRoot()` em `AppModule`).
2. Criar `src/videos/draft-cleanup.service.ts` — `@Cron` que busca vídeos `status=draft` mais antigos que um TTL configurável, aborta o multipart no storage (`abortMultipartUpload`) e remove a row (per `phase-03-videos/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DraftCleanupService` | Integration (real DB+MinIO): draft mais velho que o TTL é abortado e removido; draft recente e vídeos `ready`/`processing` permanecem intactos | `src/videos/draft-cleanup.service.integration-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Um vídeo em `draft` com `created_at` além do TTL é removido do banco e tem seu multipart abortado ao rodar a limpeza.
- Vídeos em `draft` dentro do TTL, e vídeos em `processing`/`ready`/`failed`, não são afetados pela limpeza.

---

## Technical Specifications

### Data Model

#### Video

New entity `Video` (table `videos`), owned by a `Channel` (per phase-02 1:1 user→channel; a channel has many videos). Follows inherited conventions: uuid PK via `uuid_generate_v4()`, `snake_case` columns, explicit migration (no `synchronize`), `created_at`/`updated_at` timestamps.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) — internal identifier / FK target |
| public_id | varchar(16) | unique, not null — public URL code, `nanoid` 11 chars (per phase-03-videos/TD-06) |
| channel_id | uuid | FK → `channels(id)`, not null — owner channel |
| title | varchar(255) | not null — supplied at upload initiate (falls back to original filename) |
| status | enum `videos_status_enum` | not null, default `'draft'` — one of `draft \| processing \| ready \| failed` (per phase-03-videos/TD-08) |
| storage_key | varchar(512) | not null — object key of the original file, `videos/<id>/original` (per phase-03-videos/TD-01) |
| thumbnail_key | varchar(512) | nullable — object key of the generated thumbnail, `thumbnails/<id>.jpg` (per phase-03-videos/TD-05) |
| upload_id | varchar(512) | nullable — S3/MinIO multipart `UploadId` while uploading; cleared after complete/abort (per phase-03-videos/TD-03) |
| original_filename | varchar(255) | nullable — client-supplied filename at initiate |
| content_type | varchar(128) | nullable — declared MIME type at initiate / confirmed from metadata |
| size_bytes | bigint | nullable — final object size (≤ 10 GiB enforced at initiate) |
| duration_seconds | integer | nullable — extracted by `ffprobe` (per phase-03-videos/TD-05) |
| width | integer | nullable — extracted by `ffprobe` |
| height | integer | nullable — extracted by `ffprobe` |
| metadata | jsonb | nullable — raw `ffprobe` extract (format + streams) for auditing/future use |
| failure_reason | text | nullable — populated when `status = failed` (per phase-03-videos/TD-08) |
| created_at | timestamptz | not null, default `now()` |
| updated_at | timestamptz | not null, default `now()` |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id` (`ON DELETE CASCADE` — deleting a channel removes its videos).
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (used by the draft-cleanup backstop query).
**Enum:** `videos_status_enum` = `('draft', 'processing', 'ready', 'failed')`.

### API Contracts

All video endpoints are documented via `@nestjs/swagger` (per openapi-docs-nestjs/TD-01) and appear in the exported `openapi.json` (per openapi-docs-nestjs/TD-02). The public path segment is the `public_id` (per phase-03-videos/TD-06), denoted `:publicId`. Errors use the inherited domain-exception envelope `{ statusCode, error, message }` (per phase-02-auth/TD-07).

#### POST /videos (SI-03.6)

Initiate upload — pre-registers the video as a `draft`, opens a storage multipart upload, and returns presigned per-part PUT URLs so the client uploads **directly to storage** (per phase-03-videos/TD-03).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- filename: string, required — original file name (1–255 chars)
- contentType: string, required — declared MIME type (e.g. `video/mp4`)
- size: integer, required — total size in bytes, 1 .. 10737418240 (10 GiB)
- title: string, optional — defaults to `filename` when omitted

**Response 201:**
- id: string — the `public_id` (used in every later URL)
- uploadId: string — storage multipart `UploadId`
- key: string — object key of the original file
- partSize: integer — bytes per part the client must use
- parts: array of `{ partNumber: integer, url: string }` — presigned PUT URLs (short expiry, ~15 min)

**Error responses:**
- 401 UNAUTHENTICATED: missing or invalid access token
- 400 VIDEO_UPLOAD_TOO_LARGE: `size` exceeds 10 GiB
- 400 validation error: request body fails schema validation

---

#### POST /videos/:publicId/complete (SI-03.6)

Complete the multipart upload with the collected part ETags, transition `draft → processing`, and enqueue the processing job (per phase-03-videos/TD-04).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- uploadId: string, required — the `uploadId` returned by initiate
- parts: array of `{ partNumber: integer, etag: string }`, required — non-empty, one entry per uploaded part

**Response 200:**
- id: string — `public_id`
- status: string — `processing`

**Error responses:**
- 401 UNAUTHENTICATED
- 403 VIDEO_NOT_OWNED: authenticated user does not own the video's channel
- 404 VIDEO_NOT_FOUND: unknown `publicId`
- 409 VIDEO_INVALID_STATE: video is not in `draft` (already completing/processed)
- 400 UPLOAD_COMPLETION_FAILED: storage rejected the part manifest (bad/missing ETags)
- 400 validation error

---

#### DELETE /videos/:publicId (SI-03.6)

Abort an in-progress upload or delete an owned video — aborts the multipart upload (if any), removes the stored objects, and deletes the row.

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 204:** No content.

**Error responses:**
- 401 UNAUTHENTICATED
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId (SI-03.8)

Fetch video metadata. Anonymous for `ready` videos; owner may read own non-ready videos (per Authorization Matrix).

**Response 200:**
- id: string — `public_id`
- title: string
- status: string — `draft | processing | ready | failed`
- durationSeconds: integer | null
- width: integer | null
- height: integer | null
- thumbnailUrl: string | null — URL of `GET /videos/:publicId/thumbnail`
- channelId: string
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or non-`ready` and requester is not the owner

---

#### GET /videos/:publicId/stream (SI-03.8)

Stream the video with HTTP Range support (per phase-03-videos/TD-07). The API reads the `Range` header, fetches the matching byte range from storage, and returns `206 Partial Content`. Anonymous for `ready` videos.

**Request headers:**
- Range: `bytes=start-end` — optional; when present the response is `206`

**Response 206:** Partial content — headers `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes`, `Content-Length` (of the range), `Content-Type` (the video's MIME type); body is the requested byte range.

**Response 200:** Full body with `Accept-Ranges: bytes` and `Content-Length` when no `Range` header is sent.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: video exists but is not `ready` (and requester is not the owner)
- 416 INVALID_RANGE: the `Range` header is unsatisfiable (Requested Range Not Satisfiable)

---

#### GET /videos/:publicId/download (SI-03.8)

Download the original file. Same storage-backed streaming as `/stream` but with `Content-Disposition: attachment`. Range is honored (206) so downloads are resumable.

**Response 200 / 206:** file body — headers `Content-Disposition: attachment; filename="<original_filename>"`, `Content-Type`, `Content-Length` (and `Content-Range` on a ranged request).

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### GET /videos/:publicId/thumbnail (SI-03.8)

Serve the generated thumbnail image.

**Response 200:** `image/jpeg` body (streamed from `thumbnail_key`).

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown video, or thumbnail not yet generated

---

#### Validation Rules — Video endpoints

- `filename`: required, string, 1–255 chars.
- `contentType`: required, string; must be a `video/*` MIME type.
- `size`: required, integer, `1 .. 10737418240` (≤ 10 GiB); over-limit → `VIDEO_UPLOAD_TOO_LARGE`.
- `title`: optional, string, ≤ 255 chars.
- `uploadId`: required, non-empty string.
- `parts`: required, non-empty array; each `{ partNumber: integer ≥ 1, etag: non-empty string }`.
- `Range` header (stream/download): parsed as `bytes=start[-end]`; malformed or out-of-bounds → `416 INVALID_RANGE`.

### Authorization Matrix

Auth uses the inherited global JWT guard with a public-route opt-out (per phase-02-auth/TD-03 baseline). "Owner" = the authenticated user whose channel owns the video. Anonymous watching is allowed for `ready` videos (project plan: acesso anônimo). Non-`ready` videos are visible only to their owner.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:publicId/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ (ready only) | ✓ (ready only) | ✓ (any status) |
| GET /videos/:publicId/stream | ✓ (ready only) | ✓ (ready only) | ✓ (any status) |
| GET /videos/:publicId/download | ✓ (ready only) | ✓ (ready only) | ✓ (any status) |
| GET /videos/:publicId/thumbnail | ✓ (ready only) | ✓ (ready only) | ✓ (any status) |

- Any authenticated user with a channel may **create** a video (`POST /videos`) — it is created under their own channel.
- `complete` / `DELETE` are owner-only; a non-owner receives `403 VIDEO_NOT_OWNED`.
- For read/stream/download/thumbnail, a non-owner requesting a non-`ready` video receives `404 VIDEO_NOT_FOUND` (existence not leaked) or `409 VIDEO_NOT_READY` for the media endpoints.

### Error Catalog

Domain errors are thrown as domain exceptions by the services and mapped to the inherited `{ statusCode, error, message }` envelope by the global domain-exception filter (per phase-02-auth/TD-07). `error` carries the machine-readable code below.

| error | HTTP | Trigger |
|-------|------|---------|
| VIDEO_UPLOAD_TOO_LARGE | 400 | `size` declared at initiate exceeds 10 GiB |
| UPLOAD_COMPLETION_FAILED | 400 | storage rejected the multipart part manifest (bad/missing ETags) on complete |
| VIDEO_NOT_OWNED | 403 | authenticated user is not the owner of the video's channel |
| VIDEO_NOT_FOUND | 404 | unknown `publicId`, or a non-owner requests a non-`ready` video |
| VIDEO_INVALID_STATE | 409 | operation invalid for the current status (e.g. `complete` on a video not in `draft`) |
| VIDEO_NOT_READY | 409 | stream/download/thumbnail requested for a video not yet `ready` (non-owner) |
| INVALID_RANGE | 416 | the `Range` header is present but unsatisfiable |

**Worker-side (non-HTTP) failure:** when processing fails after BullMQ exhausts its retries, the worker sets `status = failed` and stores `failure_reason` on the video row (per phase-03-videos/TD-08) — surfaced to clients through `GET /videos/:publicId` (`status: failed`), not as an HTTP error.

### Events/Messages

Background processing uses a BullMQ queue backed by Redis (per phase-03-videos/TD-02). One queue (`video-processing`) carries one job type.

#### process-video

**Queue:** `video-processing` (BullMQ, Redis connection via Compose service `redis`).

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per phase-03-videos/TD-04) — added on `POST /videos/:publicId/complete`, in the same flow that transitions the video `draft → processing`. Job options: `{ jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` (`jobId = videoId` gives idempotency — a duplicate complete never double-enqueues).

**Consumer:** `VideoProcessor` running in the separate **video-worker** container (per phase-03-videos/TD-05) — a NestJS standalone app hosting a BullMQ `WorkerHost`. It reads the object from storage, runs `ffprobe` (duration + metadata) and `ffmpeg` (thumbnail frame), uploads the thumbnail, and updates the row.

**Trigger:** fires once per successful upload completion.

**Delivery semantics:** at-least-once with bounded retry (3 attempts, exponential backoff). On success the worker sets `status = ready` plus `duration_seconds`, `width`, `height`, `metadata`, `thumbnail_key`. On terminal failure (retries exhausted) it sets `status = failed` and `failure_reason` (per phase-03-videos/TD-08). Idempotent by `jobId = videoId` and by the worker guarding on the current status.

**Related scheduled task (not a queue event):** a periodic cleanup (`@nestjs/schedule` cron) aborts/removes `draft` videos whose upload was abandoned past a TTL — the backstop noted in phase-03-videos/TD-04.

---

## Dependency Map

```
SI-03.1 (root — infra: MinIO + Redis + video-worker + FFmpeg no Compose)
SI-03.3 (root — Video entity + migration)
SI-03.2 (root — config: storage + queue + env validation)
├── SI-03.4 — depends on SI-03.2 (storage module — usa storageConfig)
└── SI-03.5 — depends on SI-03.2 (queue module — usa queueConfig)

SI-03.6 — depends on SI-03.3 + SI-03.4 + SI-03.5 (upload endpoints: initiate/complete/delete)
├── SI-03.8 — depends on SI-03.6 + SI-03.4 + SI-03.7 (streaming/download/thumbnail/metadata)
└── SI-03.9 — depends on SI-03.6 (backstop: limpeza de rascunhos)
SI-03.7 — depends on SI-03.3 + SI-03.4 + SI-03.5 (worker de vídeo — consome os jobs de SI-03.6)
```

Notes:
- SI-03.1 (infra) is a hard prerequisite at runtime for every integration/e2e test in SI-03.4+ (the Compose stack must be up), even though there is no code-level import edge.
- SI-03.8's end-to-end thumbnail/metadata assertions require SI-03.7 (the worker must have produced a `ready` video).

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, fila e worker no Docker Compose
- [ ] SI-03.2 — Config: storage e queue configs + validação de env
- [ ] SI-03.3 — Entidade Video + migration
- [ ] SI-03.4 — Módulo de object storage (adapter MinIO/S3)
- [ ] SI-03.5 — Módulo de fila (BullMQ)
- [ ] SI-03.6 — Endpoints de upload (initiate / complete / delete)
- [ ] SI-03.7 — Worker de vídeo (processamento FFmpeg)
- [ ] SI-03.8 — Endpoints de streaming, download, thumbnail e metadados
- [ ] SI-03.9 — Backstop: limpeza de rascunhos abandonados

**Capability deliverables (project-plan.md → Fase 03):**

- [ ] Upload de até 10GB funcional, sem travar a API (multipart presignado direto ao storage; API não recebe o arquivo)
- [ ] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- [ ] Processamento automático após o upload: duração/metadados extraídos e thumbnail gerado
- [ ] URL única por vídeo (`public_id` via nanoid), sem conflito
- [ ] Streaming funcionando via HTTP Range/206 (sem exigir download completo) e download disponível
- [ ] Ciclo de status refletido no banco (draft → processing → ready | failed)
- [ ] Object storage (MinIO), fila (Redis/BullMQ) e worker sobem via `docker compose`

**Full test suites** _(inside the container, per `nestjs-project/CLAUDE.md`)_:

- [ ] Unit + integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check limpo (`docker compose exec nestjs-api npx tsc --noEmit` — exit 0)
- [ ] Lint limpo (`docker compose exec nestjs-api npm run lint`)
- [ ] `progress.md` da fase atualizado (status + testes por SI)
