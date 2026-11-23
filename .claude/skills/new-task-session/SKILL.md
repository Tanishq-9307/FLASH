---
name: new-task-session
description: The before-and-after routine for every FLASH task — read only what the task cites, plan first, implement, then run the checkpoint routine (checks, status, log, commit).
---

# new-task-session

Use at the start and end of every task in `TASKS.md`.

## Before: start the task

1. Read the task block in `TASKS.md` and **only the document sections it cites**. Do not read every document every session. `CLAUDE.md` is always loaded; `docs/ARCHITECTURE.md` wins on behaviour if documents conflict.
2. Inspect the existing code the task touches. Propose a short plan first and wait for approval before editing anything.
3. Check the decision gates: do not start a task that depends on an unresolved `[OPEN]` item. Gates are resolved with sources, not guessed.
4. One task per session (30–45 minutes). If a task will take longer, stop and split it.

## Rules while working

- Change only what the task needs. Add no dependency without a one-line justification in the plan.
- Before writing framework, SDK, or Supabase code, read the current official docs for the pinned version in `docs/TECH_STACK.md`. Do not rely on memory of older versions.
- **Secrets:** never paste keys into any chat, document, or commit. Keys live only in `.env.local` and the Vercel dashboard.
- **Documents are frozen** once they exist, with two exceptions: decision-gate tasks (the `-0` tasks) record verified facts and clear `[OPEN]` tags, and M5-0 / M6-0 / M6-1 extend the schema. Otherwise change a document only when code reveals a real mismatch, as a separate `docs:` commit noted in `PROGRESS.md`.
- **One migration per task.** Every migration file starts with a plain-language header explaining what it does and why.
- **Never touch production data from tests.** Database tests run only against the dev database (PGlite validation locally; see `TASKS.md` §0.3).
- If a task fails: diagnose from the real error and the specific code. Never regenerate large sections, delete files to start over, or change a test to make it pass without saying so.

## After: the checkpoint routine

1. Run lint, type check, and the tests relevant to the task; report the real output.
2. Set this task's status in `TASKS.md` (`[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked).
3. Append one dated line to `PROGRESS.md` (what changed, what was verified, what is open).
4. Commit with the task's commit message. Do not push secrets.
5. Answer the task's **concept check** in your own words.
