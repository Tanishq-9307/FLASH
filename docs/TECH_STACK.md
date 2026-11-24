# TECH_STACK.md

**Project:** FLASH (private, single-user personal AI assistant)
**Status:** Final candidate for approval. Supersedes the earlier draft. Task M0-0 updates this file with exact pinned versions.
**Labels:** [DECIDED] settled. [PROPOSED] recommended, change only with a stated reason. [OPEN] unverified, check before relying on it. "Verified" means a source was read; third-party sources are marked and should be confirmed against official documentation in the milestone shown.

**Rule:** never rely on memory for versions, prices, limits, or model names. Verify, cite the source, and record the date. Pin exact versions in `package.json` and record them in the table in Section 2 during M0-0.

---

## 1. Stack Summary

| Layer | Choice | Status |
|---|---|---|
| Framework | Next.js (App Router), TypeScript strict mode | [DECIDED]; pinned in Section 2 (Next.js 16.4.1) |
| Styling | Tailwind CSS, shadcn/ui | [DECIDED]; Tailwind v4 (4.3.3) verified in M0-0 |
| Backend | Next.js Route Handlers (streaming) and Server Actions (mutations) | [DECIDED] |
| Database, auth, storage | Supabase (PostgreSQL, Auth, Storage) | [DECIDED] |
| Migrations | Supabase CLI with raw SQL migrations and generated TypeScript types; no ORM | [DECIDED] |
| AI SDK | Vercel AI SDK with the Groq provider | [PROPOSED]; major version 7 verified in M0-0 (Section 2) |
| Model | Groq API behind a provider adapter | [DECIDED]; model chosen in M1 from the Groq model list, switched from Gemini 2026-11-24 |
| Hosting | Vercel Hobby with Fluid compute | [DECIDED] |
| Speech (M4) | Browser-native speech, behind a provider interface | [PROPOSED] |
| PDF extraction (M5) | `unpdf` 1.9.1 (MIT), page-by-page text from a serverless build of PDF.js | [DECIDED] M5-0 (owner approved 2026-11-07) |
| Web search (M6) | Tavily free plan (1,000 credits/month), basic search, own cap 10/day | [DECIDED] M6-0 |
| Testing | Vitest (unit, integration, route tests with the model mocked) | [PROPOSED] |
| Source control | Git, private GitHub repository | [DECIDED] |

**Not used, and not to be added without a demonstrated need:** Redis, vector database, ORM, microservices, agent frameworks, Kubernetes.

---

## 2. Version Pins (filled in during M0-0)

All facts below were read on 2026-10-16. **Pinning rule:** exact versions in `package.json` (no `^` or `~`), and `package-lock.json` is committed. Upgrades are deliberate, one at a time, with this table updated.

| Item | Pinned version | Source and date |
|---|---|---|
| Node.js | **24.x** (Active LTS "Krypton"; current release 24.22.0). `package.json` `engines.node: "24.x"`, `.nvmrc`: `24` | nodejs.org/dist/index.json and github.com/nodejs/Release `schedule.json` (24 is LTS until 2028-04-30; maintenance from 2026-10-20). vercel.com/docs/functions/runtimes/node-js/node-js-versions (offers only 24.x (default) and 22.x). Read 2026-10-16 |
| Next.js | **16.4.1** | npm registry (released 2026-10-14); nextjs.org/docs/app/getting-started/installation (minimum Node 20.9). Read 2026-10-16 |
| React, react-dom | **19.3.1** | npm registry (released 2026-10-14); `next@16.4.1` peer `^19.0.0`. Read 2026-10-16 |
| TypeScript | **6.0.3** (not 7.x) | npm registry. `typescript-eslint` 8.71.2 (used by `eslint-config-next/typescript`) declares peer `typescript >=4.8.4 <6.1.0`, so TypeScript 7 breaks linting. Next.js minimum is 5.1. Read 2026-10-16 |
| ESLint, `eslint-config-next` | **eslint 9.39.5**, **eslint-config-next 16.4.1** | nextjs.org/docs/app/api-reference/config/eslint (lastUpdated 2026-10-05). It supports ESLint 9 and 10, but some bundled plugins do not list ESLint 10 as a peer yet, so npm installs may fail. Read 2026-10-16 |
| Tailwind CSS | **tailwindcss 4.3.3**, **@tailwindcss/postcss 4.3.3** | tailwindcss.com/docs/installation/framework-guides/nextjs (docs v4.3); npm registry. Read 2026-10-16 |
| Vercel AI SDK | **ai 7.0.142**, **@ai-sdk/groq 4.0.60**, **@openrouter/ai-sdk-provider 3.1.0**, **@ai-sdk/react 4.0.146** | ai-sdk.dev/docs/migration-guides/migration-guide-7-0; npm registry (all declare `node >=22`); console.groq.com/docs/ai-sdk (groq('llama-3.3-70b-versatile'), `GROQ_API_KEY`). Groq provider read 2026-11-24; OpenRouter provider (createOpenRouter, `@openrouter/ai-sdk-provider` 3.1.0, supports ai ^7) read 2026-11-24 |
| Supabase | **CLI `supabase` 2.121.0** (npm devDependency, run with `npx supabase`), **@supabase/supabase-js 2.118.0**, **@supabase/ssr 0.12.7** | npm registry (supabase-js declares `node >=22.0.0`; ssr peer `supabase-js ^2.114.0`); supabase.com/docs/guides/local-development/cli/getting-started. Read 2026-10-16 |
| Vitest | **5.0.5** | npm registry (`node ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`). Read 2026-10-16 |
| `@types/node` | **24.19.2** (matches the Node major) | npm registry. Read 2026-10-16 |
| `@types/react`, `@types/react-dom` | **19.3.0** (match React 19.3) | npm registry (latest 19.3.0). Added in M0-2: the scaffold needs them and M0-0 had not pinned them. Read 2026-10-17 |
| PGlite (`@electric-sql/pglite`) | **0.3.9** | npm registry. In-process PostgreSQL for local migration validation and type generation (no remote project, no Docker). Decided in M0-4. Read 2026-11-23 |

**Minimum Node, and why 24:** Next.js 16 needs Node 20.9 or later. AI SDK 7, supabase-js 2.118 and Vitest 5 need Node 22 or later. Node 24 is the newest LTS that Vercel offers, and it satisfies all of them. Node 26 becomes LTS on 2026-10-28, but Vercel does not offer it yet. This machine currently has Node 22.23.3, and nvm is installed: run `nvm install 24` before M0-2.

Facts confirmed in official documentation (read 2026-10-16):
- **Request-interception file: `proxy.ts`** at the project root, exporting a function named `proxy` (or a default export). Next.js v16.0.0 deprecated `middleware` and renamed it to Proxy. Proxy runs on the Node.js runtime by default, and setting `runtime` in it throws an error. Source: nextjs.org/docs/app/api-reference/file-conventions/proxy (lastUpdated 2026-09-04).
- **Lint command:** `next lint` was removed in Next.js v16.0.0, and `next build` no longer runs the linter. Use the ESLint CLI directly: `"lint": "eslint"` in `package.json`, with a flat config `eslint.config.mjs` that spreads `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`. Source: nextjs.org/docs/app/api-reference/config/eslint (lastUpdated 2026-10-05) and nextjs.org/docs/app/getting-started/installation (lastUpdated 2026-10-02).
- **Tailwind v4.3:** there is no `tailwind.config` file. Setup is `postcss.config.mjs` with the `@tailwindcss/postcss` plugin, plus `@import "tailwindcss";` in `app/globals.css`. Design tokens are CSS theme variables in an `@theme { ... }` block. Source: tailwindcss.com/docs/installation/framework-guides/nextjs and tailwindcss.com/docs/theme.
- **Vercel AI SDK 7:** requires Node.js 22 or later, and all packages are ESM-only. The v6 tool option `needsApproval` is replaced by a `toolApproval` setting on the call or agent. Source: ai-sdk.dev/docs/migration-guides/migration-guide-7-0. Our approval enforcement is our own server code regardless of SDK features (ARCHITECTURE.md Section 5), so we do not use `toolApproval` for security. Coding agents may write code for older SDK versions: instruct them to read the current docs before writing SDK code.
- **Groq key name: `GROQ_API_KEY`**, server-only and never prefixed `NEXT_PUBLIC_`. The `@ai-sdk/groq` provider reads it by default. Source: console.groq.com/docs/ai-sdk (read 2026-11-24). The old Gemini key (`GOOGLE_GENERATIVE_AI_API_KEY`, `@ai-sdk/google`) was removed with the provider switch on 2026-11-24.
- **Supabase API keys:** Supabase now issues a **publishable key** (`sb_publishable_...`), which is safe in the browser, and a **secret key** (`sb_secret_...`), which is server-only. Supabase rejects a secret key sent from a browser with HTTP 401. Neither is a JWT. The legacy `anon` and `service_role` keys are long JWTs starting with `eyJ`, and Supabase is deprecating them by the end of 2026. Environment variable names, as recommended by Supabase:
  - Browser: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - Server only: `SUPABASE_SECRET_KEY`

  "Service-role key" in our documents means `SUPABASE_SECRET_KEY` (see Section 4). The M0-1 hooks match the `sb_secret_` prefix and legacy `eyJ...` JWTs. Source: supabase.com/docs/guides/api/api-keys.
- **Docker: not available.** On this machine `docker` and `supabase` return "command not found", and total RAM is 3 GB. Checked 2026-10-16.

### 2.1 Dev database workflow [DECIDED in M0-0, adapted for the FLASH build]

**Choice:** local PGlite validation, not a remote Supabase project and not local Docker.
- SQL migrations are validated locally with PGlite (PostgreSQL compiled to WebAssembly, run in-process by Vitest). Every migration is applied to a fresh PGlite database and the task's checks run against it. No remote Supabase project is created by this build, and no production database exists yet.
- The Supabase CLI is a project devDependency, run with `npx supabase`. It is used for `migration new`, `migration list`, and type generation (see M0-4). It is never linked to a remote project during this build.
- Type generation: `npm run gen:types` runs `scripts/gen-types.mjs` (decided in M0-4): it starts an in-process PGlite database (@electric-sql/pglite 0.3.9), applies every migration in `supabase/migrations/` in order, and introspects the schema to emit `types/supabase.ts` in the supabase-js format. PGlite has no TCP server, so the CLI's `gen types --db-url` cannot be used. PGlite has no `auth` schema, so the script creates minimal stand-ins (`auth.users` table, `auth.uid()` stub) before applying migrations. From M5-1 it also creates storage stand-ins (`storage.buckets` / `storage.objects` tables, `storage.foldername()`), kept in sync with `tests/db/helpers.ts` by hand. Verified in M0-4: generates a valid empty `Database` type with zero migrations, and correct table/enum/function types from a sample migration (see `tests/gen-types.test.ts`).
- Test guard (TASKS.md Section 0.3): database tests refuse to run unless `APP_ENV=dev` is set **and** no production project ref is configured.

**Rules:**
- Never put a database password on the command line or in any file. If the owner creates remote projects later, `db push` to production happens only at milestone gates, with the owner's confirmation, and the CLI is relinked to dev in the same session.
- If remote projects are ever created, the suggested names are `flash-dev` (all migrations and tests) and `flash-prod` (milestone gates only). The free plan allows 2 active projects, so that would use both slots (supabase.com/pricing, read 2026-10-16).

**Why not local Docker:** Docker is not installed, installing it is a system change that needs sudo, and the full local stack is heavy. The CLI's no-Docker "native runtime" is marked experimental.

**Why not a second free Supabase project:** this build runs without the owner's dashboard steps; PGlite gives a real PostgreSQL for validation and tests with no account, no network, and no pausing.

**Trade-offs accepted:** PGlite is PostgreSQL in WebAssembly, not the hosted service: Auth (`auth.users`, `auth.uid()`) and Storage do not exist in it, so migrations and tests that touch them use local stand-ins (see the `add-migration` skill). RLS policies and functions are validated as SQL, and the auth-dependent paths are verified against the real service when the owner connects one. PGlite's PostgreSQL version is recorded in M2-0.

---

## 3. Free-Tier Facts and Constraints

### 3.1 Vercel Hobby
- Verified: functions on the Hobby plan can run up to 300 seconds with 2 GB of memory when Fluid compute is enabled. Source: vercel.com/docs/functions/limitations (read October 2026).
- Action: confirm Fluid compute in project settings and set `maxDuration` explicitly on routes that need it (M0-5).

### 3.2 Supabase free plan
- Verified: free projects pause after about a week of low activity and can be resumed from the dashboard. Source: supabase.com/docs/guides/platform/free-project-pausing (read October 2026). Doc pages differ on how long a paused project can be restored, so treat the window as limited and do not rely on it.
- Because my usage is irregular, expect pauses. Mitigation: use the app at least weekly or resume from the dashboard. A keep-alive job is possible but not assumed.
- Verified: the free plan includes 500 MB database size per project. This is the size of the Postgres data, not the 1 GB disk. Above 500 MB the project goes read-only, and writes fail until the data shrinks or the plan is upgraded. Keep action-log and message volume well below it. Sources: supabase.com/pricing and supabase.com/docs/guides/platform/database-size (read 2026-10-18).
- Verified: the free plan allows 2 active projects, counted across all organizations where I am Owner or Administrator. Paused projects do not count. If the owner later creates `flash-dev` and `flash-prod`, they would use both slots. Sources: supabase.com/pricing and supabase.com/docs/guides/platform/billing-on-supabase (read 2026-10-18).
- Recorded (M1-0, 2026-11-07, owner screenshot): after the move to JWT signing keys the dashboard no longer shows an expiry field, so the project uses Supabase's default of 3600 seconds (1 hour). Not verified as configurable on the free plan; the short default is acceptable.
- Postgres 15 or later is needed for `ON DELETE SET NULL (column)` (PostgreSQL 15.0 release notes, E.20.3.3: "Allow foreign key ON DELETE SET actions to affect only specified columns" (postgresql.org/docs/release/15.0, read 2026-11-07)). The FLASH build validates SQL with PGlite; its PostgreSQL version is recorded in M2-0. Check any production project with `SELECT version()` when it is created.

### 3.3 Groq API (switched from Gemini 2026-11-24, owner decision)
- Provider switch (2026-11-24): the owner rejected the Gemini key after 503 errors on 23–24 Nov 2026. Chat now runs on Groq via `@ai-sdk/groq`, model `llama-3.3-70b-versatile`. The old model was `gemini-3.8-flash` (M1-0, 2026-11-07); `@ai-sdk/google` and `GOOGLE_GENERATIVE_AI_API_KEY` are removed from the repo.
- Privacy: Groq's Services Agreement §4.2 bars Groq from using inputs or outputs to train or fine-tune models unless the customer explicitly permits it, and Groq does not retain inference data by default (temporary logs up to 30 days only for troubleshooting or abuse; Zero Data Retention is available in the console). Sources: secondary summaries of Groq's own agreement and Your Data docs, checked 2026-11-24 (freellmapi.co/free-llm-api-data-training, humla.team/blog/groq-data-retention-policy); the owner can confirm the wording in the console. The M3-0 decision (owner, 2026-11-07) still stands and is unchanged by the switch: free tier, non-sensitive memories only, warning on the Memory screen (PRD.md Section 9) — the warning text now names Groq instead of Google.
- Limits: Groq publishes per-model free-tier limits in its rate-limits docs (console.groq.com/docs/rate-limits). For `llama-3.3-70b-versatile` on the free tier: RPM 30, TPM 12,000, RPD 1,000 (requests per day), TPD 100,000 tokens. Recorded 2026-11-24 from Groq's docs as quoted in multiple secondary sources; the exact numbers live in the owner's Groq console (Settings / Limits) and can change, so re-check there if a 429 appears.
- Models: do not hardcode a name in documents. Chosen 2026-11-24: `llama-3.3-70b-versatile`.
- All quotas are enforced by our own daily display limit (PRD.md Section 6) as well, so a bug cannot silently exhaust the free tier — but the display limit never blocks chat; Groq's own limit is the real ceiling.
- Failover / hot-swap (2026-11-24, owner decision; Saruk's Nexus-VII idea, two providers only — the owner confirmed 2026-11-24 that no third provider joins the chain): if a Groq call fails with 429 or 5xx, the same call is retried once on OpenRouter free, model `meta-llama/llama-3.3-70b-instruct:free` (same 70B weights, OpenRouter-hosted). One backup attempt per chat request; the next request always starts on Groq again. If the backup key (`OPENROUTER_API_KEY`, free, no card) is absent, failover is unavailable and the primary error surfaces honestly. The backup model was chosen 2026-11-24 because it has been free for months (listed as a recommended free model since at least April 2026) and matches the primary's model class. Free-account limits for `:free` models: 50 requests/day, 20/minute (a $10 credit purchase raises it to 1,000/day — not bought, not needed for a fallback). Failovers are structured server log lines; no action_logs row (that table audits tool actions, and a provider switch is not one). The Usage panel shows the provider that answered the latest call (via /api/health `provider`). Implementation: `lib/ai/provider.ts` (`wrapLanguageModel` middleware); the SDK's own retries are off (`maxRetries: 0`) so the single hot-swap is the only retry.

### 3.4 Web search: Tavily (M6) [DECIDED, M6-0, owner 2026-11-07]
- Verified on official pages (read 2026-11-07): the free plan gives **1,000 API credits per month, no credit card required**; a basic search costs 1 credit, an advanced search 2 (docs.tavily.com/documentation/api-credits). Development keys allow 100 requests per minute (docs.tavily.com/documentation/rate-limits). API: `POST https://api.tavily.com/search` with `Authorization: Bearer <key>`; results carry `title`, `url`, `content` (a short snippet) and `score` (docs.tavily.com/documentation/api-reference/endpoint/search). The pages say nothing about how queries are stored or used, so search queries are treated like any third-party request: never search for secrets or personal details.
- Alternative checked: Brave Search API (brave.com/search/api, read 2026-11-07). No free plan: paid plans include $5 of monthly credit (about 1,000 searches at $5 per 1,000) but a credit card is required. Rejected: the project runs on free tiers, and a card on file risks charges.
- Choice: Tavily, `search_depth: basic` (1 credit), at most 5 results, snippets only (`include_raw_content: false`, `include_answer: false`, so no third-party model text and less injected text).
- Our own cap: **10 searches per day** (`Asia/Kolkata` day, env `DAILY_SEARCH_CAP`, default 10), at most 300 a month, well under the 1,000 free credits even if a month has extra retries. Each search also costs at least two model calls from the daily cap of 20, so 10 searches is the practical ceiling anyway. *(Removed 2026-11-24, owner decision: the app-level 10/day search cap is gone — search is never blocked at an app level. The monthly limit is now a display limit only: the Usage panel shows this calendar month's searches as a percentage of 1,000 Tavily credits, env `MONTHLY_SEARCH_CAP`, default 1000. `reserve_search` is left in the database unused; `record_search` counts each search unconditionally.)*
- Key: `TAVILY_API_KEY`, server-only (never `NEXT_PUBLIC_`), set by the owner in Vercel (Sensitive) and `.env.local`.
- Re-verified 2026-11-24 (M6-0): Tavily's pricing page still lists the Researcher plan as free — 1,000 API credits/month, no credit card, basic search 1 credit, advanced 2, 100 requests/minute on development keys, credits reset on the 1st of the month. Alternative re-checked: Exa ($10/month free credit on the first team plus a $10 one-time onboarding bonus, verified 13 Nov 2026) — rejected: a smaller free allowance than Tavily's 1,000 credits, and dollar-based billing. The Brave rejection above stands. Choice and cap unchanged.

### 3.5 Speech (M4)
- The browser's built-in speech recognition and synthesis are free. Quality and available voices vary by browser, operating system, and device; a British voice may not exist on every machine. Research and test in M4-0 on the real devices. Speech synthesis exposes no audio stream, so the speaking animation is scripted (DESIGN.md Section 6).
- Keep speech behind a provider interface so a better cloud voice can be swapped in later if free limits allow.
- Decided (owner, 2026-11-07): speech-to-text uses **ElevenLabs Scribe** (`scribe_v2`) through our own server route `POST /api/speech/transcribe`, instead of the browser's speech recognition. Reasons: works in every browser that can record audio (Firefox has no speech recognition), and the owner asked for it. The browser records a short clip with `MediaRecorder` only after the owner presses the microphone button; the server checks `getUser()`, size and type, then calls `https://api.elevenlabs.io/v1/speech-to-text` with `ELEVENLABS_API_KEY` (server-only env var, Sensitive, never `NEXT_PUBLIC_`). Verified: free plan includes about 4 h 30 min of Scribe v2 per month; paid usage is $0.22 per hour. Sources: elevenlabs.io/pricing/api and elevenlabs.io/docs/api-reference/speech-to-text/convert (read 2026-11-07). Zero-retention mode is enterprise-only, so ElevenLabs keeps logs of clips; do not dictate secrets.
- Our limits on each clip: 60 seconds recorded in the browser, 2 MB accepted by the server, minimum 1 KB. No separate daily quota yet; the free plan's monthly hours are the backstop (ElevenLabs refuses when they run out, shown as "Voice limit reached").
- Spoken replies stay on the browser's free `speechSynthesis`. Selection rule (M4-0, `lib/speech/voice-select.ts`): a British (`en-GB`) voice whose name suggests a male voice, then any `en-GB` voice, then any English voice, then the browser default; within a group, prefer local voices. Reported availability (not yet tested on the owner's devices): desktop Chrome ships online voices "Google UK English Male/Female"; Windows offers Microsoft en-GB voices such as George, Hazel or Ryan; macOS and iOS offer Daniel; Android Chrome uses Google's TTS voices, which include en-GB. [OPEN: record results from the owner's laptop and phone with the `/dev/voices` test page.]
- A cloud voice for replies (for example ElevenLabs text-to-speech) is not planned: it would spend the same free credits. Revisit only if the device voices are poor.

---

## 4. Security-Relevant Configuration Summary

| Setting | Where | Rule |
|---|---|---|
| Service-role key (means `SUPABASE_SECRET_KEY`: `sb_secret_...`; legacy `service_role` JWT) | Server environment only; `server-only` admin client | Never prefixed `NEXT_PUBLIC_`; never in the client bundle; the build is checked for it |
| Groq key (`GROQ_API_KEY`) | Server environment only | Never prefixed `NEXT_PUBLIC_`; never in the client or in logs |
| OpenRouter key (`OPENROUTER_API_KEY`) | Server environment only | Optional (failover only); never prefixed `NEXT_PUBLIC_`; never in the client or in logs |
| ElevenLabs key (`ELEVENLABS_API_KEY`) | Server environment only, Vercel "Sensitive" | Read only in `lib/speech/elevenlabs.ts` (`server-only`); never prefixed `NEXT_PUBLIC_`; never in the client or in logs |
| Supabase signups | Disabled in Auth settings | Single account created manually |
| Approval TTL, daily cap, depth limit, retry limit | Server configuration | Values in PRD.md Section 6; never accepted from the client |
| CSP | Request-interception file | Nonce-based; report-only first, then enforced before M3 closes |
| Repository | Private GitHub repository, secret-scanning push protection if available | Hooks block secrets; rotation rule in README.md |

---

## 5. Open Items Checklist

- [x] Exact version pins (M0-0, 2026-10-16; Section 2).
- [x] Next.js interception file name (`proxy.ts`) and lint command (`eslint`) (M0-0, 2026-10-16).
- [x] Supabase key naming and format (M0-0, 2026-10-16; publishable and secret keys).
- [x] Dev database workflow (M0-0, 2026-10-16; second free Supabase project, Section 2.1).
- [x] JWT lifetime; Gemini model and limits (M1-0, 2026-11-07, Section 3.2 and 3.3).
- [x] Postgres version (M2-0, 2026-11-07; 17.11 on dev).
- [OPEN] Free-tier training terms and my privacy decision (M3-0).
- [OPEN] British voices on my devices (M4-0).
- [DECIDED] PDF extraction library (M5-0, owner approved 2026-11-07): `unpdf` 1.9.1. Compared (npm registry and project pages, read 2026-11-07):
  - `unpdf` (unjs, MIT): ships a serverless build of Mozilla PDF.js with the worker inlined, no required dependencies (`@napi-rs/canvas` is an optional peer, only for rendering, which we do not do). `extractText(data, { mergePages: false })` returns one string per page, which is exactly what citations need. Supports Node 22+ and serverless runtimes. Parsing runs on the event loop, so extraction is raced against a timeout. Source: github.com/unjs/unpdf. Pinned to 1.9.1 (19 days old) rather than 2.x (first released 2026-10-28) for stability.
  - `pdfjs-dist` 6.5 (Mozilla, Apache-2.0): the underlying engine; usable directly but needs worker and font setup in a serverless function. `unpdf` packages that setup.
  - `pdf-parse` 2.4.5 (Apache-2.0): last published 2025-10-29 and depends on `@napi-rs/canvas`, a native module, which adds size and native-binary risk on Vercel.
  - Memory: a 4 MB, 300-page cap keeps one extraction well inside the 2 GB Hobby function memory (Section 3.1).

