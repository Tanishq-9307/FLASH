-- M3-14 fix: explicit EXECUTE revokes on the internal m3_* helpers
-- (TASKS.md M3-14, DATABASE.md §5.4).
--
-- Plain language: the internal helpers (`m3_params_hash`,
-- `m3_is_approval_tool`, `m3_append_tool_message`, `m3_settle`,
-- `m3_expire`) are only ever called from inside the SECURITY DEFINER
-- functions, which run as the table owner — no API role should be
-- able to call them directly. The migrations relied on ALTER DEFAULT
-- PRIVILEGES to keep them closed, and that works on real Postgres,
-- but the M3-14 audit proved it does NOT work in this build's test
-- database: PGlite accepts the statement and then ignores it
-- (`pg_default_acl` stays empty, a fresh function still gets PUBLIC
-- execute, and `anon` could call `m3_settle`). So the protection is
-- now explicit, per function, in this migration: EXECUTE is revoked
-- from PUBLIC and from every API role. The SECURITY DEFINER functions
-- are unaffected — they run as the owner, and the owner keeps
-- EXECUTE. This also protects a future object created before any
-- default-privileges statement runs. The ALTER DEFAULT PRIVILEGES
-- statements stay in the migrations as the second layer for real
-- Postgres; the PGlite limitation is recorded in PROGRESS.md and the
-- live-database proof of default privileges is deferred to the M3-27
-- security review.
-- Safe to run twice: idempotent REVOKE statements.

REVOKE EXECUTE ON FUNCTION public.m3_params_hash(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.m3_is_approval_tool(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.m3_append_tool_message(uuid, uuid, text, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.m3_settle(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.m3_expire(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
