// Approval Server Actions (M3-19): the browser's only path to
// approving, rejecting, and executing an approval.
//
// Plain language: the browser sends only the approval ID — never
// parameters, never an outcome. The parameters the action runs are
// the ones the database stored when the proposal was created, and
// the outcome is whatever the database reports after the run. That
// way a tampered client cannot change what runs or lie about what
// happened.
//
// rejectAction(approvalId): getUser(), Zod-validate the ID, then
// reject_action through the user-scoped client (the function itself
// enforces ownership: only a pending or approved approval owned by
// the caller can be rejected, and only before expiry).
//
// executeAction(approvalId): getUser(), Zod-validate the ID, then
// approve_action and execute_approved_action through the user-scoped
// client. A refused claim is audited with record_claim_failure
// (service role); a tool_error is counted with
// record_execution_failure (service role). The result tells the
// browser whether to resume (a final state was reached).
//
// Every error the browser sees is generic: the caller is never told
// whether the approval exists, who owns it, or why the database
// refused — only whether to retry, and whether to resume.
"use server";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

const approvalIdSchema = z.string().uuid();

/** The stored approval snapshot the dialog renders, with the server's
 * clock at read time so the countdown can be corrected for a wrong
 * browser clock (DESIGN.md §5.5). */
export type ApprovalSnapshot = {
  id: string;
  toolName: string;
  parameters: unknown;
  status: string;
  retryCount: number;
  expiresAt: string;
  serverNow: string;
};

export type ApprovalSnapshotResult =
  | { ok: true; data: ApprovalSnapshot }
  | {
      ok: false;
      error: "unauthenticated" | "invalid" | "not_found" | "unavailable";
    };

const SNAPSHOT_COLUMNS = "id, tool_name, parameters, status, retry_count, expires_at";

/** Load the stored snapshot for one approval (M3-21b). User-scoped
 * select: the row is filtered by the caller's user_id as well as the
 * id, and RLS allows SELECT only, so a foreign id is indistinguishable
 * from one that does not exist. */
export async function getApprovalSnapshot(
  approvalId: string,
): Promise<ApprovalSnapshotResult> {
  const parsed = approvalIdSchema.safeParse(approvalId);
  if (!parsed.success) {
    return { ok: false, error: "invalid" };
  }
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (userId === null) {
    return { ok: false, error: "unauthenticated" };
  }
  const { data, error } = await supabase
    .from("tool_approvals")
    .select(SNAPSHOT_COLUMNS)
    .eq("id", parsed.data)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null) {
    console.error("getApprovalSnapshot failed", error);
    return { ok: false, error: "unavailable" };
  }
  if (data === null) {
    return { ok: false, error: "not_found" };
  }
  return {
    ok: true,
    data: {
      id: data.id,
      toolName: data.tool_name,
      parameters: data.parameters,
      status: data.status,
      retryCount: data.retry_count,
      expiresAt: data.expires_at,
      serverNow: new Date().toISOString(),
    },
  };
}

export type ApprovalActionResult =
  | {
      ok: true;
      /** The final state the action reached. */
      status: "rejected" | "succeeded" | "failed";
      /** True when a final state was reached: the browser triggers Resume. */
      resume: boolean;
    }
  | {
      ok: false;
      /** Generic error: never leaks existence, ownership, or the database reason. */
      error:
        | "unauthenticated"
        | "invalid"
        | "not_found"
        | "action_failed"
        | "tool_error";
      /** True when a final state was reached: the browser triggers Resume. */
      resume: boolean;
      /** Retries used so far, only for a retryable tool_error. */
      retryCount?: number;
    };

/** The claim codes execute_approved_action can return for a refused
 * claim (ARCHITECTURE.md §5.5). Each one is audited with
 * record_claim_failure, with the code as the reason. */
const CLAIM_REFUSED_CODES = [
  "replay",
  "expired",
  "hash_mismatch",
  "exhausted",
  "not_approved",
] as const;

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function rejectAction(
  approvalId: string,
): Promise<ApprovalActionResult> {
  const parsed = approvalIdSchema.safeParse(approvalId);
  if (!parsed.success) {
    return { ok: false, error: "invalid", resume: false };
  }
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (userId === null) {
    return { ok: false, error: "unauthenticated", resume: false };
  }

  const { data, error } = await supabase.rpc("reject_action", {
    p_approval_id: parsed.data,
  });
  if (error !== null) {
    console.error("reject_action failed", error);
    return { ok: false, error: "action_failed", resume: false };
  }
  if (data === null || data.length !== 1) {
    // No row: the approval does not exist, is not open, is not
    // owned by the caller, or is already expired. Every one of those
    // is final or overdue, so the browser resumes — the resume route
    // delivers the real outcome, or does nothing if there is none.
    return { ok: false, error: "not_found", resume: true };
  }
  return { ok: true, status: "rejected", resume: true };
}

export async function executeAction(
  approvalId: string,
): Promise<ApprovalActionResult> {
  const parsed = approvalIdSchema.safeParse(approvalId);
  if (!parsed.success) {
    return { ok: false, error: "invalid", resume: false };
  }
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (userId === null) {
    return { ok: false, error: "unauthenticated", resume: false };
  }
  const id = parsed.data;

  const admin = createAdminClient();

  // Step 1: approve. A refused approve means the approval is no
  // longer pending, unexpired, and owned by the caller. The attempt
  // is audited as a refused claim (reason "not_approved": the
  // execution was refused because the approval was not in an
  // approved state) and the browser resumes — the approval is final
  // or overdue, and the resume route delivers the real outcome.
  const approved = await supabase.rpc("approve_action", { p_approval_id: id });
  if (approved.error !== null) {
    console.error("approve_action failed", approved.error);
    return { ok: false, error: "action_failed", resume: false };
  }
  if (approved.data === null || approved.data.length !== 1) {
    try {
      await admin.rpc("record_claim_failure", {
        p_approval_id: id,
        p_user_id: userId,
        p_reason: "not_approved",
        p_is_tamper: false,
      });
    } catch (auditErr) {
      console.error("record_claim_failure failed", auditErr);
    }
    return { ok: false, error: "not_found", resume: true };
  }

  // Step 2: execute. The claim and the tool write run inside one
  // database function, so a failed write rolls the claim back too.
  const executed = await supabase.rpc("execute_approved_action", {
    p_approval_id: id,
  });
  if (executed.error !== null) {
    console.error("execute_approved_action failed", executed.error);
    return { ok: false, error: "action_failed", resume: false };
  }
  if (executed.data === null || executed.data.length !== 1) {
    console.error("execute_approved_action returned no row");
    return { ok: false, error: "action_failed", resume: false };
  }
  const code = executed.data[0].result_code;

  if (code === "claimed") {
    return { ok: true, status: "succeeded", resume: true };
  }

  if (code === "tool_error") {
    // The write rolled back and the approval is still approved, so
    // the user may retry until expiry. The counter lives in a
    // separate call because anything counted inside the rolled-back
    // transaction would vanish with it.
    try {
      const { data, error } = await admin.rpc("record_execution_failure", {
        p_approval_id: id,
        p_user_id: userId,
        p_error: { error: "tool_error" },
      });
      if (error !== null || data === null || data.length !== 1) {
        console.error(
          "record_execution_failure failed",
          error ?? "no row returned",
        );
        return { ok: false, error: "action_failed", resume: false };
      }
      if (data[0].failed) {
        // Third failure: the approval is now failed (final).
        return { ok: true, status: "failed", resume: true };
      }
      return {
        ok: false,
        error: "tool_error",
        resume: false,
        retryCount: data[0].retry_count,
      };
    } catch (err) {
      console.error("record_execution_failure failed", err);
      return { ok: false, error: "action_failed", resume: false };
    }
  }

  if (
    (CLAIM_REFUSED_CODES as readonly string[]).includes(code)
  ) {
    // A refused claim: nothing ran. Audit it (the database decides
    // tamper itself by recomputing the hash; the caller's flag is
    // only recorded) and let the browser resume — the approval is
    // final or overdue in every refused case, and the resume route
    // delivers the real outcome (or does nothing if there is none).
    try {
      await admin.rpc("record_claim_failure", {
        p_approval_id: id,
        p_user_id: userId,
        p_reason: code,
        p_is_tamper: code === "hash_mismatch",
      });
    } catch (auditErr) {
      console.error("record_claim_failure failed", auditErr);
    }
    return { ok: false, error: "action_failed", resume: true };
  }

  console.error(`execute_approved_action returned unknown code: ${code}`);
  return { ok: false, error: "action_failed", resume: false };
}
