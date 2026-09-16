---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-16T09:59:03"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-16T11:13:16"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-16T09:59:03"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-16T09:59:03"
  docs/phases/phase-02-auth/context.md: "2026-09-16T09:59:03"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-16T09:59:03"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-16T09:59:03"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Phase brief scopes this as a **backend** phase — the video frontend (upload widget, player page) is deferred to Phase 04/05.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project` — video module (upload initiate/complete, streaming, download), object-storage integration, processing queue (producer), and the video worker (queue consumer running FFmpeg). New infrastructure (object storage, queue broker, worker) added to `nestjs-project/compose.yaml`.

**Deferred subprojects:** `next-frontend` — video UI deferred; where a decision is a client↔server contract (upload handshake, streaming) it is defined backend-side so a future FE phase consumes it without reopening.

**Sequencing notes:** Depende de: Fase 01, Fase 02. Videos belong to a channel via the existing 1:1 user→channel relation (phase 02).

**Neighbors (for boundary detection only):**

- **Phase 2:** Cadastro, Login e Gerenciamento de Conta — account lifecycle, JWT auth, channel auto-creation.
- **Phase 4:** Gerenciamento de Vídeos e Canal — edição de vídeo, rascunho/publicação, painel do canal, página pública (consumes Phase 03's video entity/status).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object-storage organization and access | pending | — | — |
| phase-03-videos/TD-02 | phase | Backend | Background-processing queue technology | pending | — | — |
| phase-03-videos/TD-03 | phase | Backend | 10GB upload strategy (async / direct-to-storage) | pending | — | — |
| phase-03-videos/TD-04 | phase | Backend | Upload-completion → processing trigger | pending | — | — |
| phase-03-videos/TD-05 | phase | Backend | Video worker execution model + media processing (FFmpeg) | pending | — | — |
| phase-03-videos/TD-06 | phase | Backend | Unique public video URL / identifier strategy | pending | — | — |
| phase-03-videos/TD-07 | phase | Backend | Streaming and download delivery | pending | — | — |
| phase-03-videos/TD-08 | phase | Backend | Video status lifecycle and failure handling | pending | — | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

_No decided TDs yet — all 8 TDs of this phase are `pending` (see Decisions Index). Their `**Recommendation:**` prose lives in `docs/decisions/technical-decisions-phase-03-videos.md`; each is locked into a `**Decision:**` by `/plan-resolve`. `/plan-validate` will flag the pending decisions as `MD` (missing decision) issues → status dirty until resolved._

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion. New env keys (storage, Redis, FFmpeg) validate here.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped configs with `registerAs` — one file per domain in `src/config/` (e.g. add `storage.config.ts`, `queue.config.ts`), typed injection via `ConfigType<typeof xxxConfig>`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared `registerAs` factory — `data-source.ts` imports the factory, calls `dotenv.config()`, then the factory. Zero duplication.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — the documented NestJS approach; video DTOs (initiate/complete/query) use it with the global `ValidationPipe`.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — machine-readable error codes in `{ statusCode, error, message }`. Video domain errors (not found, not owner, invalid state) throw domain exceptions mapped by this filter.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — module-scoped rate limiting via `APP_GUARD` with `@SkipThrottle()` exemptions; applies to write-heavy video endpoints (initiate/complete).
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation with DB-stored tokens; the global JWT guard + public-route opt-out is the auth baseline. Video watch/stream/download are anonymous (public); upload/manage require auth + channel ownership.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` + CLI plugin (`classValidatorShim: true`) — video controllers/DTOs are documented via the same decorator-driven Swagger tooling; no manual authoring.
**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Both — runtime Swagger UI + exported `openapi.json` (npm script). New video endpoints appear in both; the exported artifact stays in sync.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Swagger UI exposed only in dev/staging via env flag; the committed `openapi.json` is the consultable spec in prod. Video endpoints inherit this exposure policy.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for the TypeORM CLI. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports config factories and calls them as plain functions. _(from phase 01)_
- Database connection parameters come from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 01)_
- Domain services throw domain exceptions (never NestJS HTTP exceptions); the domain-exception filter maps them to `{ statusCode, error, message }`. _(from phase 02)_
- Migrations are versioned and explicit (no `synchronize`); entities discovered via `src/**/*.entity.ts`; uuid PKs with `uuid_generate_v4()`. _(from phase 01/02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` not initialized in that phase; UI surfaces start later. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` not initialized in that phase. |
| "Confirmação de conta via e-mail com link de ativação" (UI landing) | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; BE side unchanged. |
| "Logout" (UI) | deferred | phase-02-auth-frontend | Button lives in authenticated chrome (Phase 04); BFF route ready. |
| "Recuperação de senha (set-new-password screen)" | deferred | phase-02-auth-frontend | Reset destination screen absent from Figma → deferred. |

_Informational only — these are prior-phase frontend deferrals and do not bind this backend phase._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) — e.g. `video.entity.ts` | Integration (real DB): constraints, defaults, unique indexes (public id), status enum default, FK to channel |
| Service with branching + DB (`video.service.ts`) | Unit (branch logic, mock repo) + Integration (DB contract: queries, ownership, status transitions) |
| Service with side-effect dep (storage adapter) | Integration with the real MinIO adapter running in Compose (do not mock storage that can be exercised for real) |
| Service publishing to queue (producer) | Integration: real queue (`BullModule.registerQueue`) enqueues the job |
| Worker / queue consumer (FFmpeg processing) | Integration: real queue + real storage + FFmpeg exercise metadata/thumbnail extraction |
| Module with configured imports (`videos.module.ts`) | Unit: compilation test (`TypeOrmModule.forFeature` + `BullModule.registerQueue` wiring) |
| Controller (`videos.controller.ts`) | E2E only (supertest): status codes, auth enforcement, streaming 206/Range, download headers |
| DTO (`*.dto.ts`) | E2E: one `ValidationPipe` wiring test per endpoint |
| Guard (ownership, if custom logic) | E2E + Unit if internal logic is non-trivial |

_Notes:_ integration/e2e suites share one test DB and MUST run `--runInBand`. Do not mock the DB, storage, or queue when the Compose stack can exercise them for real (`references/external-systems.md`). Reproduce `main.ts` global config (ValidationPipe, filters, guards) in E2E setup.
