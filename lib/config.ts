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
