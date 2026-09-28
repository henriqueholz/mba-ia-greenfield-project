# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7, port `6379` — BullMQ broker for video processing (Phase 03)
- `minio` — S3-compatible object storage, API `9000` / console `9001`, user/password `streamtube` (Phase 03)
- `createbuckets` — one-shot init that creates the `streamtube` bucket in MinIO, then exits
- `video-worker` — separate NestJS process (same image) that consumes the `video-processing` queue and runs FFmpeg; started by its Compose `command` (`npm run start:worker:dev`)
- `mailpit` — SMTP capture for local email, SMTP `1025` / UI `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Video Module (Phase 03)

Upload, processing, streaming and download of videos. A video belongs to a `Channel` (phase 02, 1:1 with `User`).

### Structure

- `src/videos/` — `VideosModule`, `VideosService`, `VideosController`, `Video` entity (`videos` table), DTOs, domain exceptions, `DraftCleanupService`, and `OptionalJwtGuard` (public read routes that still identify an authenticated owner).
- `src/storage/` — `StorageService` (AWS SDK v3 S3 client against MinIO/S3): bucket bootstrap (`OnModuleInit`), presigned **multipart** upload, byte-range `getObject`, `putObject`, delete. Single bucket (`STORAGE_BUCKET`), keys `videos/<publicId>/original` and `thumbnails/<publicId>.jpg`.
- `src/queue/` — `QueueModule` (BullMQ over Redis) registering the `video-processing` queue; job name `process-video`, payload `{ videoId }`.
- `src/worker/` — `WorkerModule` + `main.worker.ts` (standalone process, run as the `video-worker` container). `VideoProcessor` (BullMQ `WorkerHost`) downloads the object, runs `ffprobe` (duration/metadata) + `ffmpeg` (thumbnail) via `child_process`, uploads the thumbnail and sets `status=ready`; on retry exhaustion it sets `status=failed` + `failure_reason`. `MediaService` wraps the FFmpeg binaries (installed in the image).

### Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/videos` | owner (auth) | Initiate: pre-registers a `draft` + returns presigned multipart part URLs |
| POST | `/videos/:publicId/complete` | owner | Finalizes multipart, `draft→processing`, enqueues `process-video` |
| DELETE | `/videos/:publicId` | owner | Aborts multipart + removes objects + row |
| GET | `/videos/:publicId` | public* | Metadata (JSON) |
| GET | `/videos/:publicId/stream` | public* | HTTP `Range` → `206 Partial Content` (else `200`) |
| GET | `/videos/:publicId/download` | public* | `Content-Disposition: attachment` |
| GET | `/videos/:publicId/thumbnail` | public* | `image/jpeg` |

*Public read routes serve `ready` videos to anyone; the owner (optional Bearer token) additionally sees their own non-ready videos. Non-ready for others → `404` (metadata) / `409 VIDEO_NOT_READY` (media); bad `Range` → `416 INVALID_RANGE`.

### Status lifecycle

`draft` (initiate) → `processing` (complete/enqueue) → `ready` (worker success) | `failed` (retries exhausted). The public id is a `nanoid` (11 chars) stored in `public_id`.

### 10GB upload strategy

The file never passes through the API: the client uploads parts **directly to storage** via presigned URLs (S3 multipart, part size 100 MiB, ≤ 10 GiB), then calls `complete` with the part ETags. See `docs/phases/phase-03-videos/` for the full plan and decisions.

### Running the worker

The `video-worker` container auto-runs `npm run start:worker:dev`. To run it manually: `docker compose exec video-worker npm run start:worker:dev` (or `npm run start:worker` / `start:worker:prod`).

### New env vars

`STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`, `REDIS_HOST`, `REDIS_PORT` — see `.env.example` (Compose service names as hosts: `minio`, `redis`).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
