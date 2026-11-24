// GET /api/health (M1-6): a cheap status check for the top-bar status chip.
// Verifies auth with getUser(), reads today's model-call usage for that
// user, and reports the configured cap. It never calls the model, so it
// costs no quota. A failed fetch is treated as Offline by the chip.
//
// Since the 2026-11-24 owner decision the caps are display limits only:
// there is no "limit_reached" status any more — the response always says
// "online" when the check itself works, and the UI shows usage as a
// percentage of the configured limit. The response also carries this
// calendar month's search count and the monthly search limit (Tavily
// credits), for the search meter in the Overview Usage panel.
//
// The usage reads use the user-scoped server client, not the admin client:
// the api_usage and search_usage RLS policies let an authenticated user
// SELECT their own rows, so no service-role privilege is needed here.
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { modelCallCap, monthlySearchCap, usageDateToday, usageMonthStart } from "@/lib/config";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const cap = modelCallCap();
  const { data } = await supabase
    .from("api_usage")
    .select("model_calls")
    .eq("user_id", user.id)
    .eq("usage_date", usageDateToday())
    .maybeSingle();
  const usage = data?.model_calls ?? 0;

  const searchCap = monthlySearchCap();
  const { data: searchRows } = await supabase
    .from("search_usage")
    .select("searches")
    .eq("user_id", user.id)
    .gte("usage_date", usageMonthStart());
  const searchUsage = (searchRows ?? []).reduce(
    (total, row) => total + (row.searches ?? 0),
    0,
  );

  return NextResponse.json(
    { status: "online", usage, cap, searchUsage, searchCap },
    { headers: { "Cache-Control": "no-store" } },
  );
}
