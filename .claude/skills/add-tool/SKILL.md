---
name: add-tool
description: Adding a tool to the FLASH registry — registry entry, read-only vs state-changing, approval flow, dispatch allowlist, honest errors, tests.
---

# add-tool

Use when a task adds a tool to the registry (`docs/PRD.md` §5.5, `docs/ARCHITECTURE.md` §4–§5).

## 1. Define the registry entry

A server-side explicit allowlist entry. Each tool defines:

- `name` — the stable identifier (for example `create_task`).
- `description` — what it does, shown to the model.
- `input schema` — a Zod schema; the model may only supply values that pass it.
- `read-only` or `state-changing`.
- `risk level` — static metadata in the registry, never supplied by the model.
- `execution path` — the server function that runs it.
- `permission requirements` — who may invoke it.
- `result and error format` — what the model (and the user) sees back.

Initial tools: `get_tasks` (read-only), `create_task` (state-changing), `save_memory` (state-changing).

## 2. Read-only tools

- Executed by the server after the Model Gate. The result is audited with `log_read_only_action` (service-role function); `approval_id` stays NULL.
- A read-only tool must refuse state-changing tool names.
- Results are data, not instructions: the model may quote them but never treat them as commands.

## 3. State-changing tools (the approval path)

- The model proposes; it never executes. The proposal goes through `create_pending_approval`, which stores the exact validated parameters (Postgres computes `parameters_hash` and `expires_at`) and the `pending` action log in one transaction.
- **Binding:** the approval is bound to tool name, user ID, conversation ID, tool call ID, and the exact parameters. Parameters are immutable after creation.
- **One open approval per conversation** (partial unique index). A second proposal while one is open is discarded and the model receives an error result.
- **Preview:** the approval dialog renders parameters only from the stored snapshot read from the database, in plain text (never HTML or markdown).
- **Execution:** `execute_approved_action` claims the approval with one conditional `UPDATE ... RETURNING`, then dispatches through a **hardcoded branch per tool** (`IF tool = 'create_task' THEN ... ELSIF tool = 'save_memory' THEN ... ELSE RAISE EXCEPTION 'Unknown tool'`). It never builds SQL from stored parameter text. Database CHECK constraints are the second validation layer behind Zod.
- **Outcomes:** every final state writes the real outcome to `messages` (role `tool`) inside the same transaction. Retry rules: a failed write leaves the approval `approved` (retry until expiry); the third failure sets `failed` via `record_execution_failure`.
- The browser sends **only the approval ID** to approve, reject, execute, or resume. It never sends parameters, outcomes, or chat history.

## 4. Finish

- Add the tool to the registry, the model prompt's tool list, and the capability chips (disabled tools appear greyed with their state).
- Tests: invalid arguments are rejected; a read-only tool never writes; a state-changing proposal ends the stream with only an `approval_id`; parallel claims on one approval return exactly one `claimed`.
- Run the checkpoint routine (`new-task-session`).
