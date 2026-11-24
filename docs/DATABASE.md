# DATABASE.md

**Project:** FLASH (private, single-user personal AI assistant)
**Status:** Final candidate for approval.
**Source of truth for behaviour:** the current ARCHITECTURE.md. If the two files ever conflict, ARCHITECTURE.md wins and the conflict must be reported before any code is written.
**Labels:** [DECIDED] settled. [PROPOSED] recommended, change only with a stated reason. [OPEN] unverified, check before relying on it.

---

## 1. Principles

1. **RLS on every table.** Row Level Security is enabled on every table in `public`. The `anon` role has no access to anything.
2. **Ownership.** Every `user_id` defaults to `auth.uid()` and references `auth.users(id) ON DELETE CASCADE`. Consequence: deleting the user account deletes all of that user's data, including audit rows. For a single-user system this is a full reset; export anything worth keeping first.
3. **Composite foreign keys.** Child rows reference parents by `(parent_id, user_id)`, so a row can never be attached to another user's parent. Parents therefore need `UNIQUE (id, user_id)`.
4. **Explicit privileges.** Supabase grants broad default privileges on new tables and functions, so RLS must not be the only barrier. Client privileges are revoked and re-granted explicitly (Section 4).
5. **Security tables are read-only for clients.** `api_usage`, `tool_approvals`, and `action_logs` allow the client `SELECT` only. All writes go through functions (Section 5).
6. **Trustworthy history.** The model reads conversation history, so history must not be forgeable. A client may insert only plain user messages (`role = 'user'`, `parts IS NULL`, `tool_call_id IS NULL`) and may never update a message. Assistant, system, and tool messages are written only by `append_message` or by the approval functions.
7. **Audit persistence.** Deleting a conversation or a task never deletes `tool_approvals` or `action_logs`.
8. Postgres 15 or later is required. The FLASH build validates SQL locally with PGlite; its PostgreSQL version is 17.5 (recorded in M2-0, 2026-11-23). Any production project is checked with `SELECT version()` when it is created.

---

## 2. Migration Plan

Raw SQL migrations via the Supabase CLI, applied in order, with generated TypeScript types after each migration. Every migration is explained in plain language in its file header.

- **M1:** `set_updated_at` helper, `settings`, `api_usage`, `reserve_api_call`, `refund_api_call`, grants block and default-privilege rules.
- **M2:** `conversations`, `messages`, `tasks`, `notes`, `append_message`, `updated_at` triggers.
- **M5:** `documents`, `document_pages`, the private `documents` Storage bucket and its policies, `save_document_extraction` (Sections 3.10 to 3.12).
- **M6:** `search_usage`, `reserve_search`, `refund_search` (Section 3.13).
- **M3:** `memories`, `tool_approvals`, `action_logs`, the conversation-delete guard (it needs `tool_approvals`, so it cannot come earlier), the immutability triggers, and the nine approval and audit functions.

---

## 3. Tables

All policies use `(SELECT auth.uid())` for performance and are granted `TO authenticated` only.

### 3.1 `settings` (M1)
- Columns: `user_id uuid PRIMARY KEY DEFAULT auth.uid()` (FK to `auth.users`, cascade), `memory_enabled boolean NOT NULL DEFAULT true`.
- [DECIDED] Treat a missing row as defaults. The app upserts on the first settings change. This avoids a trigger on the internal `auth.users` table that could block signups if it errors.
- RLS: SELECT, INSERT, UPDATE where `user_id` matches, with `WITH CHECK`. No DELETE.

### 3.2 `api_usage` (M1)
- Columns: `user_id uuid NOT NULL DEFAULT auth.uid()` (FK, cascade), `usage_date date NOT NULL`, `model_calls int NOT NULL DEFAULT 0 CHECK (model_calls >= 0)`.
- Primary key `(user_id, usage_date)`.
- RLS: SELECT only. Writes only through `record_api_call` and `refund_api_call` (since 2026-11-24; `reserve_api_call` is left in the database unused).

### 3.2a `search_usage` (M6)
- Columns: `user_id uuid NOT NULL DEFAULT auth.uid()` (FK, cascade), `usage_date date NOT NULL`, `searches int NOT NULL DEFAULT 0 CHECK (searches >= 0)`.
- Primary key `(user_id, usage_date)`.
- RLS: SELECT only. Writes only through `record_search` and `refund_search` (DATABASE.md §5.1; since 2026-11-24 — `reserve_search` is left in the database unused). The old reserve INSERT was conditional on the cap being at least 1, so a cap of 0 failed closed on a fresh day (M3-27 lesson, built in from the start).

### 3.3 `conversations` (M2)
- Columns: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id` (FK, cascade), `title text NOT NULL CHECK (char_length(title) <= 255)`, `created_at`, `updated_at` (both `timestamptz NOT NULL DEFAULT now()`).
- Constraints: `UNIQUE (id, user_id)`.
- Triggers: `set_updated_at` before update. **M3:** a delete guard (SECURITY DEFINER, fixed `search_path`) that refuses to delete a conversation while it has an approval in `pending` or `approved` status that has not expired (error `conversation_has_open_approval`). The user must cancel it first. An overdue one cannot run (approve and execute require `expires_at > now()`), so it does not block. Account deletion is allowed: the guard skips when the `auth.users` row is already gone (M3-1b, 2026-11-07).
- RLS: SELECT, INSERT, UPDATE, DELETE.

### 3.4 `messages` (M2)
- Columns: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `conversation_id uuid NOT NULL`, `user_id` (FK, cascade), `role text NOT NULL CHECK (role IN ('user','assistant','system','tool'))`, `content text NOT NULL CHECK (char_length(content) <= 100000)`, `parts jsonb` (tool-call and tool-result parts), `tool_call_id text`, `created_at timestamptz NOT NULL DEFAULT now()`.
- `parts` shapes (M3-17/18, implemented 2026-11-07): an assistant row may hold `{ incomplete?: true, tool_calls?: [{ id, name, input, output?, provider_options? }] }`. `output` is the result the model saw (read-only, invalid or refused calls); a state-changing proposal has no `output`, and its real outcome is the `tool` row with the same `tool_call_id`. `provider_options` is opaque provider data (for example Gemini's thought signature) and is never shown. Tool rows hold `{ approval_id, tool_name, outcome, result }`.
- Constraints: `FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) ON DELETE CASCADE`.
- Index: `(conversation_id, created_at)`.
- RLS: SELECT where owner. INSERT with check `user_id = auth.uid() AND role = 'user' AND parts IS NULL AND tool_call_id IS NULL`. No UPDATE. No client DELETE: messages are removed only by the cascade when a conversation is deleted (referential actions do not need client delete privilege). This also avoids broken tool-call sequences in history.

### 3.5 `tasks` (M2)
- Columns: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id` (FK, cascade), `title text NOT NULL CHECK (char_length(title) <= 255)`, `due_date timestamptz`, `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed'))`, `created_at`, `updated_at`.
- Constraints: `UNIQUE (id, user_id)`. Trigger: `set_updated_at`. Index: `(user_id, status)`.
- RLS: SELECT, INSERT, UPDATE, DELETE.

### 3.6 `notes` (M2)
- Columns: `id`, `user_id` (FK, cascade), `title text NOT NULL CHECK (char_length(title) <= 255)`, `content text NOT NULL CHECK (char_length(content) <= 100000)`, `created_at`, `updated_at`.
- Constraints: `UNIQUE (id, user_id)`. Trigger: `set_updated_at`.
- Search column (owner decision 2026-11-07, M2-8b): `search tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED`. Postgres fills it; nobody can write it. Reason: the Data API can filter a column, not an expression, so this keeps search on the indexed expression without adding a database function.
- Index: GIN full-text index on `search` (the expression above). Queries search `search` with the `'english'` configuration (`websearch_to_tsquery`).
- RLS: SELECT, INSERT, UPDATE, DELETE.

### 3.7 `memories` (M3)
- Columns: `id`, `user_id` (FK, cascade), `fact text NOT NULL CHECK (char_length(btrim(fact)) BETWEEN 1 AND 10000)` (M3-1a: empty facts refused too), `created_at`, `updated_at`. Trigger: `set_updated_at`. Index: `(user_id)`.
- RLS: SELECT, INSERT, UPDATE, DELETE (this powers the user's own memory screen; the model can only add memories through the approval-gated `save_memory` tool).

### 3.8 `tool_approvals` (M3)
- Columns: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id` (FK, cascade), `conversation_id uuid` (nullable), `tool_call_id text NOT NULL`, `tool_name text NOT NULL`, `parameters jsonb NOT NULL`, `parameters_hash text NOT NULL`, `status text NOT NULL DEFAULT 'pending'`, `retry_count int NOT NULL DEFAULT 0`, `expires_at timestamptz NOT NULL`, `approved_at`, `consumed_at`, `outcome_delivered_at` (all nullable `timestamptz`), `created_at timestamptz NOT NULL DEFAULT now()`.
- CHECKs: status in (`pending`,`approved`,`consumed`,`rejected`,`expired`,`failed`); `retry_count BETWEEN 0 AND 3`; length limits on `tool_name` (64) and `tool_call_id` (128); `pg_column_size(parameters) <= 16384` [PROPOSED]; `status <> 'consumed' OR consumed_at IS NOT NULL`.
- Constraints: `UNIQUE (id, user_id)`; `FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) ON DELETE SET NULL (conversation_id)` (Postgres 15+; verified on dev, PGlite 17.5, in M2-0).
- Indexes: `(user_id, status)`; partial unique `idx_one_open_approval ON (conversation_id) WHERE status IN ('pending','approved')`.
- **Immutability trigger (BEFORE UPDATE):** `user_id`, `tool_name`, `tool_call_id`, `parameters`, `parameters_hash`, `expires_at`, `created_at` can never change. `conversation_id` may change only to NULL, because the foreign-key action on conversation delete performs that update and must not be blocked. Added in M3-1b: a final status (`consumed`, `rejected`, `expired`, `failed`) never changes again, and `outcome_delivered_at` is set once.
- RLS: SELECT only.

### 3.9 `action_logs` (M3)
- Columns: `id`, `user_id` (FK, cascade), `conversation_id uuid` (nullable), `approval_id uuid` (nullable), `tool_call_id text NOT NULL`, `tool_name text NOT NULL`, `parameters jsonb NOT NULL`, `execution_status text NOT NULL`, `result_payload jsonb`, `created_at timestamptz NOT NULL DEFAULT now()`.
- CHECKs: `execution_status IN ('pending','succeeded','failed','unknown','not_executed')`; `pg_column_size(result_payload) <= 32768` [PROPOSED].
- Foreign keys: `(conversation_id, user_id)` to conversations `ON DELETE SET NULL (conversation_id)`; `(approval_id, user_id)` to `tool_approvals (id, user_id)` with **`ON DELETE NO ACTION`**. Reason: `RESTRICT` is checked immediately and can block the cascade when the user account is deleted (both tables cascade from the same user), whereas `NO ACTION` checks at the end of the statement and still blocks a direct delete of an approval that has logs. [x] Confirmed by the user-deletion test in M3-1b (2026-11-23): deleting the user succeeds and removes all of their rows.
- Immutability trigger: `user_id`, `tool_call_id`, `tool_name`, `parameters`, `approval_id`, `created_at` never change; `conversation_id` may change only to NULL. Only `execution_status` and `result_payload` are updated, and only by the functions.
- Claim failures are stored as `not_executed` rows with `reason` and `tamper` fields inside `result_payload`.
- RLS: SELECT only.

---

### 3.10 `documents` (M5) [DECIDED, M5-0 2026-11-07, owner approved]
- Columns: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id` (default `auth.uid()`, FK to `auth.users`, cascade), `title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255)`, `storage_path text NOT NULL UNIQUE CHECK (storage_path = user_id::text || '/' || id::text || '.pdf')`, `size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304)`, `status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','no_text','failed'))`, `page_count integer CHECK (page_count BETWEEN 1 AND 300)`, `error_code text CHECK (char_length(error_code) <= 64)`, `created_at`, `updated_at`.
- Constraints: `UNIQUE (id, user_id)` (parent of `document_pages`). Trigger: `set_updated_at`.
- Why 4 MB: Vercel Functions refuse request bodies over 4.5 MB (413 `FUNCTION_PAYLOAD_TOO_LARGE`, vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions, read 2026-11-07), and the upload passes through our route so the server can check the bytes first.
- The storage path is fixed by a CHECK, so a row can only point at its own owner's file.
- RLS: SELECT and DELETE for the owner. INSERT for the owner only `WITH CHECK (user_id = (SELECT auth.uid()) AND status = 'processing' AND page_count IS NULL AND error_code IS NULL)`, so a client cannot mark its own document as extracted. No client UPDATE: status, page count and error are set only by `save_document_extraction` (Section 5.1). Renaming is not in scope.
- Delete: the server removes the Storage object first, then the row (pages cascade). If the file removal fails the row stays and the UI says so, so a row never claims a file that is gone or vice versa.

### 3.11 `document_pages` (M5) [DECIDED, M5-0 2026-11-07, owner approved]
- Columns: `document_id uuid NOT NULL`, `user_id uuid NOT NULL DEFAULT auth.uid()`, `page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 300)`, `content text NOT NULL CHECK (char_length(content) <= 20000)`, `search tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`.
- Keys: `PRIMARY KEY (document_id, page_number)`; FK `(document_id, user_id)` to `documents (id, user_id) ON DELETE CASCADE`.
- Index: GIN on `search` (`document_pages_search_idx`), same pattern as `notes` (M2-8b decision), for the M5-4 retrieval.
- RLS: SELECT for the owner only. **No client INSERT, UPDATE or DELETE.** Page text is what citations point at, so only the server's extraction step writes it, through `save_document_extraction`. Deleting the document deletes its pages.
- Long pages: text beyond 20,000 characters on one page is cut and the cut is recorded in the document's `error_code` (`page_truncated`), never hidden.

### 3.12 Storage bucket `documents` (M5) [DECIDED, M5-0 2026-11-07, owner approved]
- Private bucket (`public = false`), `file_size_limit = 4194304`, `allowed_mime_types = '{application/pdf}'`. Files are never served by public URL; there is no download feature in M5.
- Object names are `<user_id>/<document_id>.pdf`. Policies on `storage.objects`, all `TO authenticated`, all requiring `bucket_id = 'documents' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text`:
  - SELECT (needed to read the file for extraction and to remove it), INSERT, DELETE. **No UPDATE**, so an uploaded file cannot be swapped after its text was extracted.
- `anon` has no policy on this bucket.

### 3.13 `search_usage` (M6) [DECIDED, M6-1 2026-11-07]
- Mirrors `api_usage`: `user_id` (default `auth.uid()`, FK `auth.users` cascade), `usage_date date`, `searches int >= 0`, primary key `(user_id, usage_date)`.
- RLS: SELECT own rows only. Writes only through `record_search(p_user_id)` and `refund_search(p_user_id, p_usage_date)`, both service_role only, same single-statement design as `record_api_call` (Section 5). Since 2026-11-24 there is no cap: the monthly limit (1,000 Tavily credits, env `MONTHLY_SEARCH_CAP`) is a display limit only.

## 4. Grants Block

Run after the tables exist, and keep it in the migration history:

```sql
REVOKE ALL ON public.settings, public.api_usage, public.conversations, public.messages,
  public.tasks, public.notes, public.memories, public.tool_approvals, public.action_logs
  FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations, public.tasks,
  public.notes, public.memories TO authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;
GRANT SELECT ON public.api_usage, public.tool_approvals, public.action_logs TO authenticated;
-- M5 [DECIDED]
GRANT SELECT, INSERT, DELETE ON public.documents TO authenticated;
GRANT SELECT ON public.document_pages TO authenticated;

-- Stop future objects from regressing to broad defaults
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
```

Each table's grants are applied in the migration that creates it (the list above is the end state). Add grants for `service_role` only where a function needs them; functions run as `SECURITY DEFINER`.

---

## 5. Functions

**Global rules:** every function is `SECURITY DEFINER` with `SET search_path = public, pg_temp`; has `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` followed by an explicit `GRANT`; authenticated functions take no user ID and use `auth.uid()`; service-role functions take `p_user_id` supplied by the server from `getUser()`. Signatures below are [PROPOSED]; if one changes, update its grant statement.

### 5.1 Contracts

| Function | Caller | Returns | Behaviour |
|---|---|---|---|
| `reserve_api_call(p_user_id uuid, p_cap int)` | service_role | `model_calls` and `usage_date`, or no row when capped | Upsert from ARCHITECTURE.md Section 6. `usage_date` is returned so a refund always targets the original reservation day (added in M1-4). Left in the database unused since 2026-11-24 (caps removed). |
| `record_api_call(p_user_id uuid)` | service_role | `model_calls` and `usage_date` | Unconditional upsert (2026-11-24): increments today's count by one, no cap check. The write path for chat since the caps were removed. |
| `refund_api_call(p_user_id uuid, p_usage_date date)` | service_role | void | `GREATEST(0, model_calls - 1)` on that date only. |
| `reserve_search(p_user_id uuid, p_cap int)` / `refund_search(p_user_id uuid, p_usage_date date)` [DECIDED, M6] | service_role | `(searches, usage_date)` or no row / void | Same as the model-call pair, on `search_usage`. `reserve_search` left in the database unused since 2026-11-24 (caps removed). |
| `record_search(p_user_id uuid)` | service_role | `searches` and `usage_date` | Unconditional upsert (2026-11-24): increments today's count by one, no cap check. The write path for search since the caps were removed. |
| `create_pending_approval(p_user_id, p_conversation_id, p_tool_call_id, p_tool, p_params jsonb, p_ttl_seconds int)` | service_role | `approval_id`, `log_id`, or code `open_approval_exists` | Steps in 5.2. |
| `log_read_only_action(p_user_id, p_conversation_id, p_tool_call_id, p_tool, p_params, p_status, p_result)` | service_role | log id | `p_status` must be `succeeded` or `failed`. `approval_id` stays NULL. Refuses state-changing tool names. (M3-3: `p_tool_call_id` added because `action_logs.tool_call_id` is NOT NULL.) |
| `record_execution_failure(p_approval_id, p_user_id, p_error jsonb)` | service_role | `retry_count`, `failed` flag | Only for an `approved` approval owned by the user. Increments `retry_count`, appends the sanitised error to the log. At 3: status `failed`, log `failed`, tool message appended, flag true so the server resumes. |
| `record_claim_failure(p_approval_id, p_user_id, p_reason text, p_is_tamper boolean)` | service_role | log id, resume flag | Always inserts a `not_executed` audit row with the reason. For `hash_mismatch` (tamper) it is also terminal: sets the approval `failed`, settles the original pending log as `not_executed` with the tamper flag, appends the tool message, and returns a resume flag. Other reasons add only the audit row (expiry and exhaustion are settled by their own functions). |
| `expire_stale_approval(p_user_id, p_approval_id)` | service_role | row or none | The expiry update from ARCHITECTURE.md 5.4; on success marks the log `not_executed` and appends the tool message. |
| `mark_outcome_delivered(p_user_id, p_approval_id)` | service_role | row or none | Sets `outcome_delivered_at` once, only for `consumed`, `rejected`, `expired`, `failed`. |
| `append_message(p_user_id, p_conversation_id, p_role, p_content, p_parts jsonb, p_tool_call_id)` | service_role | message id | `p_role` must be `assistant` or `system`. Tool-call and tool-result parts for read-only and invalid calls live in the assistant message's `parts`. `tool` role rows are written only by the approval functions. |
| `save_document_extraction(p_user_id uuid, p_document_id uuid, p_status text, p_pages jsonb, p_error_code text)` [DECIDED, M5] | service_role | void, or raises | Only for a document owned by `p_user_id` with status `processing`. `p_status` must be `ready`, `no_text` or `failed`. For `ready`, `p_pages` is a JSON array of `{page, text}` (1 to 300 entries, pages 1..n, text at most 20,000 characters each); the pages are inserted and `page_count` set in the same transaction. For `no_text` and `failed` no pages are stored. Never builds SQL from the input. |
| `approve_action(p_approval_id uuid)` | authenticated | row or none | Atomic update from ARCHITECTURE.md 5.4. |
| `reject_action(p_approval_id uuid)` | authenticated | row or none | Atomic Cancel update; marks the log `not_executed`; appends the tool message. |
| `execute_approved_action(p_approval_id uuid)` | authenticated | result code, result payload | Steps in 5.3. |

### 5.2 `create_pending_approval` steps
1. Look up any open (`pending` or `approved`) approval for the conversation owned by `p_user_id`.
2. If one exists and is overdue, expire it using the same logic as `expire_stale_approval` (including the log update and tool message). If it is not overdue, return `open_approval_exists`.
3. Compute `expires_at = now() + make_interval(secs => p_ttl_seconds)`.
4. Insert the approval; compute `parameters_hash = encode(sha256(convert_to(parameters::text, 'UTF8')), 'hex')` from the stored JSONB.
5. Insert the `pending` action log.
6. Steps 4 and 5 run in one transaction. Catch `unique_violation` from the partial index (two simultaneous proposals) and return `open_approval_exists`.

### 5.3 `execute_approved_action` steps
1. Inside one `BEGIN ... EXCEPTION` block: run the claim update from ARCHITECTURE.md 5.4.
2. If the claim returns no row, read the approval to classify the reason (`replay`, `expired`, `hash_mismatch`, `exhausted`, `not_approved`) and return that code. No writes happen. The classification read is never an authorization check.
3. Dispatch on `tool_name` through a hardcoded branch per tool (`create_task`, `save_memory`). Unknown tool raises an exception. No SQL is ever built from stored parameter text.
4. Update the log to `succeeded` with the result, and append the tool message.
5. Return `claimed`.
6. `EXCEPTION WHEN OTHERS`: the block's writes, including the claim, roll back; return `tool_error` with a sanitised error for server-side logging only. The server then calls `record_execution_failure`.

### 5.4 Grant statements

```sql
-- Service-role only
REVOKE EXECUTE ON FUNCTION public.reserve_api_call(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reserve_api_call(uuid, int) TO service_role;
-- Repeat the same two-line pattern for:
--   refund_api_call(uuid, date)
--   create_pending_approval(uuid, uuid, text, text, jsonb, int)
--   log_read_only_action(uuid, uuid, text, text, jsonb, text, jsonb)
--   record_execution_failure(uuid, uuid, jsonb)
--   record_claim_failure(uuid, uuid, text, boolean)
--   expire_stale_approval(uuid, uuid)
--   mark_outcome_delivered(uuid, uuid)
--   append_message(uuid, uuid, text, text, jsonb, text)
--   save_document_extraction(uuid, uuid, text, jsonb, text)   [M5, DECIDED]

-- Authenticated only
REVOKE EXECUTE ON FUNCTION public.approve_action(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_action(uuid) TO authenticated;
-- Repeat for reject_action(uuid) and execute_approved_action(uuid).
```

Any internal helper (for example the shared expiry logic) is not granted to any API role. Implemented helpers (M3, 2026-11-07): `m3_is_approval_tool` (allowlist: `create_task`, `save_memory`), `m3_params_hash`, `m3_settle` (settles the pending log and writes the tool message), `m3_expire`. `create_pending_approval` refuses tool names outside the allowlist and TTLs outside 1 to 3600 seconds. `record_claim_failure` decides tamper itself by recomputing the hash; the caller's flag is only recorded.

---

## 6. Test Checklist

**Isolation and privileges**
- [ ] As user A, query user B's row IDs (all tables): 0 rows.
- [ ] As A, insert a task with `user_id` = B: blocked. Update a task to change `user_id`: blocked.
- [ ] As A, insert a message into B's conversation: blocked.
- [ ] Catalog query: RLS enabled on every table in `public`; `anon` holds no table privileges.
- [ ] `anon` and `authenticated` both get "permission denied" calling each of the nine service-role functions directly. `anon` cannot call the three authenticated functions.
- [ ] Authenticated client INSERT/UPDATE on `tool_approvals`, `action_logs`, `api_usage`: blocked.
- [ ] Create a throwaway new table: confirm default privileges do not grant it to `anon` or `authenticated`.

**Message integrity**
- [ ] Client inserts `role = 'assistant'` or `'tool'`: blocked. Client inserts a `user` message with `parts` or `tool_call_id` set: blocked. Client UPDATE or DELETE of a message: blocked.
- [ ] `append_message` rejects `user` and `tool` roles.

**Approval lifecycle**
- [ ] Parallel claim: five simultaneous `execute_approved_action` calls on one approval. Exactly one returns `claimed`; the other four return `replay`.
- [ ] Executing a `pending` approval returns `not_approved`. Executing a `consumed` approval returns `replay`.
- [ ] Tamper: edit stored `parameters` as the superuser (the immutability trigger must be disabled for this test only, and re-enabled after). Execution returns `hash_mismatch` and `record_claim_failure` flags tamper. Separately confirm that, with the trigger enabled, `service_role` cannot change `parameters`, `parameters_hash`, `tool_name`, or `user_id`.
- [ ] A `hash_mismatch` claim failure sets the approval `failed`, settles the original pending log as `not_executed` with the tamper flag, and appends the tool message.
- [ ] Short-TTL expiry: TTL of 2 seconds, wait 3. `approve_action` fails. `expire_stale_approval` then marks it `expired`, marks the log `not_executed`, and appends the tool message.
- [ ] Retry exhaustion: force the tool write to fail three times. `retry_count` reaches 3, `record_execution_failure` sets `failed` and returns the resume flag, and further execution is refused.
- [ ] A failed tool write rolls back the claim: status stays `approved`, `retry_count` unchanged until `record_execution_failure` runs.
- [ ] One open approval: a second `create_pending_approval` in the same conversation returns `open_approval_exists`, including when two calls race.
- [ ] `reject_action` works from `pending` and from `approved`, and not on an expired approval.

**Concurrency and limits**
- [ ] Parallel `reserve_api_call` calls never exceed the cap. `refund_api_call` never goes below 0.
- [ ] Parallel `mark_outcome_delivered` on one approval succeeds exactly once, and only for final states.

**Deletion and retention**
- [ ] Deleting a conversation with no open approval keeps its `tool_approvals` and `action_logs` rows with `conversation_id = NULL`, and deletes its messages.
- [ ] Deleting a conversation with an open approval is blocked until cancelled.
- [ ] Deleting the user account succeeds and removes all rows (confirms the `NO ACTION` choice).

**Other**
- [ ] `updated_at` changes on update for conversations, tasks, notes, memories.
- [ ] Missing `settings` row behaves as defaults; first settings change upserts.

---

## 7. Open Items and Citations

- Postgres 15 or later is required for `ON DELETE SET NULL (column)`. Source for the syntax: PostgreSQL 15.0 release notes, E.20.3.3: "Allow foreign key ON DELETE SET actions to affect only specified columns" (postgresql.org/docs/release/15.0, read 2026-11-07). The FLASH build validates SQL with PGlite; its version is 17.5 (recorded in M2-0, 2026-11-23). Production: confirm with `SELECT version()` when a production project is created.
- Verified (M0-4, 2026-10-18): the Supabase free-plan database size limit is 500 MB per project. Above it the project goes read-only. Keep action-log volume well under it. Sources: supabase.com/pricing and supabase.com/docs/guides/platform/database-size.
- [x] Supabase JWT expiry: default 3600 seconds (M1-0, TECH_STACK.md 3.2).
- Resolved in M0-0: Next.js 16.4.1, interception file `proxy.ts` (TECH_STACK.md Section 2).
- [x] Groq model `llama-3.3-70b-versatile` and free-tier limits recorded in M1-0, switched from Gemini 2026-11-24 (TECH_STACK.md 3.3).
- [x] Privacy decision (M3-0, owner 2026-11-07; resolved in the FLASH build 2026-11-23): free-tier prompts, so only non-sensitive facts go into memories and chats. Provider is Groq since 2026-11-24 (was Gemini); Groq's agreement bars training on inputs/outputs, with a permanent warning on the Memory screen (PRD.md §9, TECH_STACK.md §3.3, ARCHITECTURE.md §13).
- [PROPOSED] Size limits (16 KB parameters, 32 KB log result, 100,000 characters for messages and notes) and the `NO ACTION` choice for the log-to-approval foreign key.

