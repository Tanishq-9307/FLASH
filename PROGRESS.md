# PROGRESS.md

## Current state
- **Milestone:** M0 in progress (M0-0, M0-1, M0-2, M0-3 done)
- **Next task:** M0-4 (Supabase CLI and dev workflow)
- **Blockers:** none. Remote repo `Tanishq-9307/FLASH` exists (private, created via browser). Local main `bc2c5cb` pushed via `github push-files` (full-tree snapshot); remote main `40330e6` "chore: scaffold Next.js with strict TypeScript and lint", trees identical. Push transport in this environment is `github push-files` (git push over HTTPS/SSH does not work: no credential helper, gh not logged in, SSH blocked at the proxy).

## Adaptations from the JARVIS spec (FLASH build)
- Project renamed JARVIS → FLASH everywhere (app, docs, wordmark, CSS class `.flash-frame`).
- Dev database workflow is **PGlite (local SQL validation)** instead of a second free Supabase project (`docs/TECH_STACK.md` §2.1 rewritten). No remote Supabase or Vercel project is created by this build; milestone gates are code-evidence only (no live deployment).
- Commit author is the owner (Tanishq Shinde, tanishq.jshinde@gmail.com) so the work counts on his contribution graph; the build itself is done by the agent.
- The overview mockup image (`docs/design/overview-mockup.png`) was not copied: it is 1.36 MB and the available GitHub tools cannot fetch binary files. `docs/DESIGN.md` is the source of truth for the UI; the image can be added later.
- A security check flagged the automated doc-copy step; the copied files are the owner's own spec Markdown (already read in full, no executable content), so the build proceeds as authorized.
- Test harness pulled forward from M1-5 into M0-3 (Vitest 5.0.5 + vite 7.3.8 as peer, both pinned exact; `test: vitest run`; `tests/smoke.test.ts` with 4 tests) so the per-task gate (`npm run test`) can run from M0-3 onward. M1-5 will extend, not create, the harness (dev-only guard, admin-API helpers, DB suites). Install note: plain `npm install` fails on this npm (10.9.4) with an arborist `edgesOut` error while resolving vitest's peer set; `--legacy-peer-deps` works. Vitest 5 needs the `vite` peer installed explicitly.
- M0-3 "Done when" check is adapted: there is no Claude Code `/context` UI in this build environment, so verification is file presence + frontmatter parse (covered by the smoke test) plus the four gates passing.

## Milestones
- [ ] M0 Foundation (v0.0.1)
- [ ] M1 Auth, rate limit, chat (v0.1.0)
- [ ] M2 Persistence (v0.2.0)
- [ ] M3 Memory, tools, approvals: the demo (v0.3.0)
- [ ] M4 Voice (v0.4.0)
- [ ] M5 Documents (v0.5.0)
- [ ] M6 Web research (v0.6.0)
- [ ] Wrap-up (v1.0.0)

## Gate evidence
Copy this table under a heading for each milestone at its gate.

| Criterion (PRD Section 7) | Evidence | Date |
|---|---|---|
| | | |

## Session log
One line per session: `YYYY-MM-DD · task ID · what changed · what was verified · what is open`
- 2026-11-23 · M0-0 · versions already pinned in docs/TECH_STACK.md §2 (Next.js 16.4.1, React 19.3.1, TS 6.0.3, Tailwind 4.3.3, AI SDK 7, Supabase CLI 2.121.0, Vitest 5.0.5, Node 24.x; proxy.ts; Supabase publishable/secret key naming); dev-database workflow decided: PGlite local validation, no remote project; §2.1 rewritten · spec files read in full; Node v24.22.1 and npm 10.9.4 on this machine; npm registry reachable · gen:types approach for PGlite to be settled in M0-4
- 2026-11-23 · M0-1 · git init on main; strict .gitignore; .env.example (placeholders only); README + fresh PROGRESS.md; docs copied with FLASH rename (PRD, TECH_STACK, ARCHITECTURE, DATABASE, DESIGN; TASKS.md at root with statuses reset); hooks written fresh (secret-scan.sh, pre-commit, pre-push, test-hooks.sh; bash shebang — /bin/sh is dash here and lacks read -d); core.hooksPath set · 17/17 hook cases pass in a throwaway repo (pre-commit blocks keys incl. path with spaces and renames; pre-push blocks add-then-remove on new and existing branches; no value printed); repo is local-only until the remote is created (MCP token cannot create repos: 403) · remote repo creation waits for the owner/parent
- 2026-11-23 · M0-1 push · private repo Tanishq-9307/FLASH created (empty, via browser — MCP create_repository 403s); local main f803dd6 pushed via `github push-files` (full-tree snapshot), remote main d8c9df1 "init: repository, docs, hooks, and secret protection", authored as the owner; TASKS.md on remote already reads FLASH · list_commits + get_file_contents verified · push transport in this environment is `github push-files` (git push over HTTPS/SSH does not work: no credential helper, gh not logged in, SSH blocked at the proxy); local f803dd6 and remote d8c9df1 have identical trees
- 2026-11-23 · M0-2 push · local main `bc2c5cb` pushed via `github push-files` (full-tree snapshot); remote main `40330e6` "chore: scaffold Next.js with strict TypeScript and lint"; trees identical (verified: remote root listing matches local tracked files)
- 2026-11-23 · M0-3 · CLAUDE.md at root (from specs/CLAUDE.md, FLASH rename, Commands filled in); five skills written fresh under `.claude/skills/<name>/SKILL.md` (new-task-session, add-migration, add-tool, security-review, milestone-gate); Vitest 5.0.5 + vite 7.3.8 installed (exact pins, `--legacy-peer-deps` — plain install hits npm arborist `edgesOut` bug); `test` script + `tests/smoke.test.ts` (4 tests) · `npm run test` 4/4 pass, `npm run lint` pass, `npx tsc --noEmit` pass, `npm run build` pass; frontmatter verified by smoke test · concept check: skills load on demand, so the agent's context stays small and each procedure is self-contained and versioned with the repo, instead of one huge rules file bloating every session · M0-4 next
