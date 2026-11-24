// Read-only tool execution (M3-17): the get_tasks query.
//
// Plain language: this is the one read-only tool the model can call.
// It only reads the owner's own tasks, through the user-scoped
// client, so RLS proves ownership — another user's tasks look
// absent. It never writes anything, so it never needs an approval;
// the loop logs the call via log_read_only_action instead (see
// execute-tool-call.ts). The result is capped so one call cannot
// flood the prompt with the whole task list.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

/** At most this many tasks come back in one get_tasks result. */
export const GET_TASKS_RESULT_LIMIT = 50;

export interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
}

/**
 * List the owner's tasks, optionally filtered by status. Throws on a
 * database error — the caller logs the failure and returns an honest
 * error result to the model instead of inventing tasks.
 */
export async function executeGetTasks(
  supabase: SupabaseClient<Database>,
  userId: string,
  args: { status?: "pending" | "completed" },
): Promise<{ tasks: TaskRow[] }> {
  const query = supabase
    .from("tasks")
    .select("id, title, due_date, status")
    .eq("user_id", userId);
  const filtered =
    args.status !== undefined
      ? query.eq("status", args.status)
      : query;
  const { data, error } = await filtered
    .order("created_at", { ascending: true })
    .limit(GET_TASKS_RESULT_LIMIT);
  if (error || !data) {
    throw new Error(
      `Task list failed: ${error?.message ?? "no data returned"}`,
    );
  }
  return { tasks: data as TaskRow[] };
}

/** Delimiters marking untrusted web text in a tool result
 * (ARCHITECTURE.md §9). The model must treat everything between
 * them as data from the web, never as instructions. */
export const UNTRUSTED_DATA_START = "=== UNTRUSTED DATA START ===";
export const UNTRUSTED_DATA_END = "=== UNTRUSTED DATA END ===";

export interface WebSearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface WebSearchOutput {
  /** Sources for the UI (M6-3): title + URL only, no snippet text. */
  sources: Array<{ title: string; url: string }>;
  /** The results as one delimited untrusted-data block. This is what
   * the model reads; the delimiters are the only thing separating
   * web text from instructions. */
  content: string;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown source";
  }
}

/** Format search results as a delimited untrusted-data block, one
 * numbered entry per result with its source domain. A result with no
 * snippet still appears (with an empty body) so the numbering matches
 * the sources list and the model cannot mistake one result for
 * another. */
export function formatSearchResultsAsUntrusted(
  results: WebSearchResultItem[],
): string {
  if (results.length === 0) {
    return `${UNTRUSTED_DATA_START}\nNo results found.\n${UNTRUSTED_DATA_END}`;
  }
  const entries = results.map((r, i) => {
    const title = r.title === "" ? "(untitled)" : r.title;
    return `[${i + 1}] ${title} — ${domainOf(r.url)}\n${r.content}`;
  });
  return `${UNTRUSTED_DATA_START}\n${entries.join("\n\n")}\n${UNTRUSTED_DATA_END}`;
}

/**
 * Run one web search through the provider and format the results.
 * Throws the provider's TavilyError on failure — the caller decides
 * whether the reservation is refunded (only a pre-dispatch abort,
 * i.e. a missing key, is refunded; a provider failure after dispatch
 * is not). Returns the sources list plus the delimited block; an
 * empty result list is a valid outcome, not an error.
 */
export async function executeWebSearch(
  query: string,
  provider: (
    query: string,
  ) => Promise<{ results: WebSearchResultItem[] }>,
): Promise<WebSearchOutput> {
  const { results } = await provider(query);
  return {
    sources: results.map((r) => ({ title: r.title, url: r.url })),
    content: formatSearchResultsAsUntrusted(results),
  };
}
