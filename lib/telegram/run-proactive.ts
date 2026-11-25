// Proactive engine — runner (Phase 3, 2026-11-25). The scheduled check:
// load real state, evaluate nudges, send at most a few, dedupe, log.
//
// Order of operations:
// 1. Not configured (no bot token or no owner Telegram id) → inert,
//    no crash, no send.
// 2. Resolve the owner by email (single-account app, M1-0). Unknown
//    owner → nothing is sent.
// 3. Proactive switch off (settings.telegram_proactive_enabled false,
//    via /stop) → nothing is sent. A missing settings row means on.
// 4. Quiet hours (23:00–07:00 IST) → nothing is sent.
// 5. Evaluate nudges from real tasks + usage, drop keys already in
//    telegram_nudges, keep at most MAX_PROACTIVE_NUDGES_PER_RUN.
// 6. Send each nudge over Telegram. A sent nudge is recorded in
//    telegram_nudges (the dedupe record) AND in action_logs (the
//    activity timeline) with tool "telegram_proactive". A failed send
//    is logged as failed in action_logs and gets no nudge row, so the
//    next run retries it instead of silently dropping it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { modelCallCap, usageDateToday } from "@/lib/config";
import { sendTelegramMessage, type TelegramSendResult } from "./client";
import { resolveTelegramOwnerId } from "./owner";
import {
  evaluateProactiveNudges,
  filterUnsentNudges,
  isQuietHours,
  MAX_PROACTIVE_NUDGES_PER_RUN,
  type ProactiveNudge,
} from "./proactive";

export type ProactiveRunStatus =
  | "sent"
  | "none"
  | "disabled"
  | "quiet"
  | "not_configured"
  | "owner_not_found";

export interface ProactiveRunResult {
  status: ProactiveRunStatus;
  /** Keys of the nudges actually sent this run. */
  sent: string[];
  /** Human-readable detail for the route's log line. */
  detail: string;
}

export interface ProactiveRunnerDeps {
  admin: SupabaseClient<Database>;
  token: string | null;
  ownerTelegramId: string | null;
  /** Injectable clock (tests) — defaults to now. */
  now?: () => Date;
  /** Injectable sender (tests) — defaults to the real Bot API call. */
  send?: (
    text: string,
  ) => Promise<TelegramSendResult>;
}

async function logNudge(
  admin: SupabaseClient<Database>,
  userId: string,
  nudge: ProactiveNudge,
  sent: boolean,
): Promise<void> {
  try {
    await admin.from("action_logs").insert({
      user_id: userId,
      conversation_id: null,
      approval_id: null,
      tool_call_id: `telegram-proactive:${nudge.key}`,
      tool_name: "telegram_proactive",
      parameters: { kind: nudge.kind, key: nudge.key },
      execution_status: sent ? "succeeded" : "failed",
      result_payload: sent
        ? { sent: true, text: nudge.text }
        : { sent: false, error: "telegram_send_failed" },
    });
  } catch (err) {
    // Logging must never fail the run or the next nudge.
    console.error("Proactive: failed to log nudge", err);
  }
}

export async function runProactiveCheck(
  deps: ProactiveRunnerDeps,
): Promise<ProactiveRunResult> {
  const { admin, token, ownerTelegramId } = deps;
  const now = deps.now?.() ?? new Date();
  if (!token || !ownerTelegramId) {
    return {
      status: "not_configured",
      sent: [],
      detail: "Telegram bot token or owner id not configured.",
    };
  }

  // The owner is the single account (M1-0), resolved by email.
  const userId = await resolveTelegramOwnerId(admin);
  if (!userId) {
    return {
      status: "owner_not_found",
      sent: [],
      detail: "Owner account could not be resolved.",
    };
  }

  // Proactive switch: a missing settings row means on (default true).
  const { data: settings, error: settingsError } = await admin
    .from("settings")
    .select("telegram_proactive_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (settingsError) {
    console.error("Proactive: settings load failed", settingsError);
  }
  if (settings && settings.telegram_proactive_enabled === false) {
    return { status: "disabled", sent: [], detail: "Proactive nudges off." };
  }

  if (isQuietHours(now)) {
    return {
      status: "quiet",
      sent: [],
      detail: "Quiet hours (23:00–07:00 IST) — no nudge sent.",
    };
  }

  const today = usageDateToday();
  const { data: tasks, error: tasksError } = await admin
    .from("tasks")
    .select("id, title, due_date, status, created_at, updated_at")
    .eq("user_id", userId);
  if (tasksError || !tasks) {
    console.error("Proactive: task load failed", tasksError);
    return {
      status: "none",
      sent: [],
      detail: "Task list could not be loaded — no nudge sent.",
    };
  }

  const { data: usageRow } = await admin
    .from("api_usage")
    .select("model_calls")
    .eq("user_id", userId)
    .eq("usage_date", today)
    .maybeSingle();
  const modelUsage = usageRow?.model_calls ?? 0;

  const evaluated = evaluateProactiveNudges({
    tasks,
    modelUsage,
    modelCap: modelCallCap(),
    today,
  });

  const { data: sentRows } = await admin
    .from("telegram_nudges")
    .select("nudge_key")
    .eq("user_id", userId);
  const sentKeys = new Set(
    (sentRows ?? []).map((r) => r.nudge_key as string),
  );
  const toSend = filterUnsentNudges(evaluated, sentKeys).slice(
    0,
    MAX_PROACTIVE_NUDGES_PER_RUN,
  );
  if (toSend.length === 0) {
    return {
      status: "none",
      sent: [],
      detail: "Nothing due — no nudge sent.",
    };
  }

  const send =
    deps.send ??
    ((text: string) =>
      sendTelegramMessage(token, ownerTelegramId, text));
  const sent: string[] = [];
  for (const nudge of toSend) {
    const result = await send(nudge.text);
    if (result.ok) {
      try {
        await admin.from("telegram_nudges").insert({
          user_id: userId,
          nudge_key: nudge.key,
          kind: nudge.kind,
          message: nudge.text,
        });
      } catch (err) {
        // The nudge went out but the dedupe row failed: log it loudly
        // — the next run may resend it, which is better than silently
        // believing it was recorded.
        console.error("Proactive: failed to record sent nudge", err);
      }
      await logNudge(admin, userId, nudge, true);
      sent.push(nudge.key);
    } else {
      console.error("Proactive: send failed", result.error);
      await logNudge(admin, userId, nudge, false);
    }
  }
  return {
    status: sent.length > 0 ? "sent" : "none",
    sent,
    detail:
      sent.length > 0
        ? `Sent ${sent.length} nudge(s).`
        : "All nudges failed to send.",
  };
}
