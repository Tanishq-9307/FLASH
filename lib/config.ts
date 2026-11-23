// Server configuration (M1-6). Values come from server environment only —
// never from NEXT_PUBLIC_ variables and never from the client.
//
// Daily model-call cap: PRD.md §6 [DECIDED] and M1-0 fix the cap at 20
// calls per day (matching the Gemini free tier's 20 requests per day), with
// an env override DAILY_MODEL_CALL_CAP. TASKS.md M1-6 still says the
// default is 100; that is stale — 20 is the decided value, and the health
// route reports the same cap the Model Gate enforces (M1-7). A bad override
// fails closed to 0 rather than silently allowing unlimited calls.
export function modelCallCap(): number {
  const raw = process.env.DAILY_MODEL_CALL_CAP;
  if (raw === undefined || raw.trim() === "") return 20;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

// Today's usage date on the Asia/Kolkata day boundary, matching
// reserve_api_call in the database. Returned as YYYY-MM-DD.
export function usageDateToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Maximum model calls per request (ARCHITECTURE.md §6, PRD.md §6
// [PROPOSED]): a chat request or a resume request may make at most
// this many model calls. A fourth attempt aborts the request with a
// "Maximum reasoning depth reached" system message. The counter
// resets on each new user message or resume request.
export const MAX_MODEL_CALLS_PER_REQUEST = 3;

// Approval lifetime in seconds (PRD.md §6 [PROPOSED]: 5 minutes,
// configurable). The database refuses TTLs outside 1–3600 seconds, so
// an override is clamped into that range instead of failing the
// proposal; a non-numeric override falls back to the default.
export function approvalTtlSeconds(): number {
  const raw = process.env.APPROVAL_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") return 300;
  const value = Number(raw);
  if (!Number.isInteger(value)) return 300;
  return Math.min(3600, Math.max(1, value));
}
