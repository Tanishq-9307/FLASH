// GET /api/health (M1-6): a cheap status check for the top-bar status chip.
// Verifies auth with getUser(), reads today's model-call usage for that
// user, and reports the configured cap. It never calls the model, so it
// costs no quota. A failed fetch is treated as Offline by the chip.
//
// The usage read uses the user-scoped server client, not the admin client:
// the api_usage RLS policy lets an authenticated user SELECT their own row,
// so no service-role privilege is needed here.
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { modelCallCap, usageDateToday } from "@/lib/config";

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

  return NextResponse.json(
    { status: usage >= cap ? "limit_reached" : "online", usage, cap },
    { headers: { "Cache-Control": "no-store" } },
  );
}
