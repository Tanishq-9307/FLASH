// Smart-reminder delivery (Phase 3, 2026-11-25). The scheduled
// check: claim due reminders, send each over Telegram, mark it
// sent — or release it back to pending when the send fails, so the
// next run retries it instead of silently dropping it.
//
// QUIET HOURS DO NOT APPLY HERE — deliberately. The proactive
// engine's quiet hours (23:00–07:00 IST) exist because a nudge the
// owner did not ask for must never wake him. A reminder is the
// opposite: the owner asked for that exact time, so delivering it
// late — or holding it until morning — would break the promise the
// reminder made. A reminder set for 02:00 fires at 02:00. The
// proactive engine (lib/telegram/run-proactive.ts) still applies
// quiet hours to its own nudges; only reminders bypass them.
//
// Order of operations:
// 1. Not configured (no bot token or no owner Telegram id) → inert,
//    no crash, no send.
// 2. Resolve the owner by email (single-account app, M1-0). Unknown
//    owner → nothing is sent.
// 3. Claim due reminders with claim_due_reminders (one atomic
//    UPDATE in the database): pending rows whose time has come, plus
//    `sending` rows abandoned by a run more than 10 minutes ago.
//    Two concurrent runs claim disjoint sets, so a reminder is
//    never sent twice.
// 4. Send each claimed reminder over Telegram. A sent reminder is
//    marked sent (with sent_at) AND logged in action_logs with tool
//    "telegram_reminder". A failed send releases the row back to
//    pending and logs it as failed — the next run retries it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { sendTelegramMessage, type TelegramSendResult } from "./client";
import { resolveTelegramOwnerId } from "./owner";
import {
  formatReminderDelivery,
  type Reminder,
} from "@/lib/reminders/reminders";

export type RemindersRunStatus =
  | "sent"
  | "none"
  | "not_configured"
  | "owner_not_found";

export interface RemindersRunResult {
  status: RemindersRunStatus;
  /** Ids of the reminders actually sent this run. */
  sent: string[];
  /** Human-readable detail for the route's log line. */
  detail: string;
}

export interface RemindersRunnerDeps {
  admin: SupabaseClient<Database>;
  token: string | null;
  ownerTelegramId: string | null;
  /** Injectable clock (tests) — defaults to now. */
  now?: () => Date;
  /** Injectable sender (tests) — defaults to the real Bot API call. */
  send?: (text: string) => Promise<TelegramSendResult>;
}

async function logDelivery(
  admin: SupabaseClient<Database>,
  userId: string,
  reminder: Reminder,
  sent: boolean,
): Promise<void> {
  try {
    await admin.from("action_logs").insert({
      user_id: userId,
      conversation_id: null,
      approval_id: null,
      tool_call_id: `telegram-reminder:${reminder.id}`,
      tool_name: "telegram_reminder",
      parameters: {
        reminder_id: reminder.id,
        message: reminder.message,
        remind_at: reminder.remind_at,
      },
      execution_status: sent ? "succeeded" : "failed",
      result_payload: sent
        ? { sent: true, text: formatReminderDelivery(reminder) }
        : { sent: false, error: "telegram_send_failed" },
    });
  } catch (err) {
    // Logging must never fail the run or the next reminder.
    console.error("Reminders: failed to log delivery", err);
  }
}

async function setReminderStatus(
  admin: SupabaseClient<Database>,
  reminderId: string,
  status: "sent" | "pending",
  sentAt: string | null,
): Promise<void> {
  const { error } = await admin
    .from("reminders")
    .update({ status, sent_at: sentAt })
    .eq("id", reminderId);
  if (error) {
    console.error("Reminders: failed to update reminder status", error);
  }
}

export async function runRemindersCheck(
  deps: RemindersRunnerDeps,
): Promise<RemindersRunResult> {
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

  // Atomic claim: due rows, plus rows abandoned by a dead run.
  // No quiet-hours check here — a reminder fires at its set time.
  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_due_reminders",
    { p_now: now.toISOString() },
  );
  if (claimError || !claimed) {
    console.error("Reminders: claim failed", claimError);
    return {
      status: "none",
      sent: [],
      detail: "Due reminders could not be loaded — nothing sent.",
    };
  }
  const due = claimed as unknown as Reminder[];
  if (due.length === 0) {
    return { status: "none", sent: [], detail: "No reminders due." };
  }

  const send =
    deps.send ??
    ((text: string) => sendTelegramMessage(token, ownerTelegramId, text));
  const sent: string[] = [];
  for (const reminder of due) {
    const result = await send(formatReminderDelivery(reminder));
    if (result.ok) {
      await setReminderStatus(admin, reminder.id, "sent", now.toISOString());
      await logDelivery(admin, userId, reminder, true);
      sent.push(reminder.id);
    } else {
      console.error("Reminders: send failed", result.error);
      // Release it: the next run retries instead of dropping it.
      await setReminderStatus(admin, reminder.id, "pending", null);
      await logDelivery(admin, userId, reminder, false);
    }
  }
  return {
    status: sent.length > 0 ? "sent" : "none",
    sent,
    detail:
      sent.length > 0
        ? `Sent ${sent.length} reminder(s).`
        : "All reminders failed to send.",
  };
}
