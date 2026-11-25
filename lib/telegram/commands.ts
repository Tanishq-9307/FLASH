// Telegram commands (Phase 3, 2026-11-25). Pure parsing and formatting:
// no network, no database, no model — the webhook route does the work
// and this file only decides what a message means and how a reply reads.
//
// Commands:
//   /start, /help — what FLASH can do over Telegram.
//   /tasks        — pending tasks with due dates, from the real task list.
//   /usage        — today's model usage and this month's search usage as
//                   percentages of their limits (same meters as the web UI).
//   /stop         — turn proactive nudges off.
//   /resume       — turn proactive nudges back on.
// Anything else that is not a command is a chat message for the model.
// A state-changing tool the model proposes over Telegram is never
// executed there: it becomes a pending approval, and the owner approves
// or rejects it in the FLASH web app (see lib/telegram/run-chat.ts).
import { timestampToDueDay, type Task } from "@/lib/tasks";
import { usagePercent } from "@/lib/usage";

export const TELEGRAM_COMMANDS = [
  "/start",
  "/help",
  "/tasks",
  "/usage",
  "/stop",
  "/resume",
] as const;
export type TelegramCommand = (typeof TELEGRAM_COMMANDS)[number];

export const TELEGRAM_HELP_TEXT = [
  "FLASH on Telegram — I answer here just like in the web app.",
  "",
  "Commands:",
  "/tasks — your pending tasks",
  "/usage — today's model usage and this month's search usage",
  "/stop — turn proactive nudges off",
  "/resume — turn proactive nudges back on",
  "/help — this list",
  "",
  "Anything else is a message for me. If I propose a task or a memory, approve it in the FLASH web app — I can't approve actions from Telegram.",
].join("\n");

export function isTelegramCommand(
  command: string,
): command is TelegramCommand {
  return (TELEGRAM_COMMANDS as readonly string[]).includes(command);
}

/** Parse a leading /command (with an optional @BotName suffix, which
 * Telegram adds in groups) into its command and the rest of the line
 * as arguments. Returns null when the text is not a command. */
export function parseTelegramCommand(text: string): {
  command: string;
  args: string;
} | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const firstSpace = trimmed.search(/\s/);
  const rawCommand =
    firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const args =
    firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  // "/tasks@FlashBot" → "/tasks".
  const command = rawCommand.split("@")[0] ?? rawCommand;
  return { command, args };
}

/** Pending tasks as a Telegram reply: at most 10, oldest due first,
 * with the due day in the owner's time zone. An empty list says so
 * plainly instead of inventing tasks. */
export function formatTaskList(tasks: Task[]): string {
  const pending = tasks.filter((t) => t.status === "pending");
  if (pending.length === 0) return "No pending tasks.";
  const shown = pending.slice(0, 10);
  const lines = shown.map((t) => {
    const due = timestampToDueDay(t.due_date);
    return `• ${t.title}${due !== "" ? ` (due ${due})` : ""}`;
  });
  const more =
    pending.length > shown.length
      ? `\n…and ${pending.length - shown.length} more.`
      : "";
  return `Pending tasks:\n${lines.join("\n")}${more}`;
}

/** Usage as a Telegram reply: today's model calls and this month's
 * searches as percentages of their limits — the same numbers the web
 * Usage panel shows. A limit that is not a positive number shows no
 * percentage instead of a divide-by-zero. */
export function formatUsage(
  modelUsage: number,
  modelCap: number,
  searchUsage: number,
  searchCap: number,
): string {
  const model = usagePercent(modelUsage, modelCap);
  const search = usagePercent(searchUsage, searchCap);
  const modelLine =
    model === null
      ? `Model today: ${modelUsage} calls`
      : `Model today: ${modelUsage}/${modelCap} calls (${model}%)`;
  const searchLine =
    search === null
      ? `Web search this month: ${searchUsage} searches`
      : `Web search this month: ${searchUsage}/${searchCap} searches (${search}%)`;
  return `${modelLine}\n${searchLine}`;
}
