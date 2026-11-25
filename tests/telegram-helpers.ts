// Shared fake Supabase admin client for Telegram tests (Phase 3).
// NOT a test file: an in-memory stand-in for the small slice of the
// supabase-js API the Telegram modules use (from/select/insert/upsert
// with eq/gte/order/limit/single/maybeSingle, rpc, auth.admin
// listUsers). It keeps rows in plain arrays so tests can assert what
// was written — conversations, messages, nudge rows, activity rows —
// without a database or a network.
import { randomUUID } from "node:crypto";

export const FAKE_OWNER_ID = "00000000-0000-4000-8000-000000000001";
export const FAKE_OWNER_EMAIL = "tanishq.jshinde@gmail.com";

export type FakeRow = Record<string, unknown>;

export interface FakeDb {
  users: { id: string; email: string }[];
  conversations: FakeRow[];
  messages: FakeRow[];
  tasks: FakeRow[];
  settings: FakeRow[];
  api_usage: FakeRow[];
  search_usage: FakeRow[];
  telegram_nudges: FakeRow[];
  action_logs: FakeRow[];
  memories: FakeRow[];
}

export function createFakeDb(partial: Partial<FakeDb> = {}): FakeDb {
  return {
    users: [{ id: FAKE_OWNER_ID, email: FAKE_OWNER_EMAIL }],
    conversations: [],
    messages: [],
    tasks: [],
    settings: [],
    api_usage: [],
    search_usage: [],
    telegram_nudges: [],
    action_logs: [],
    memories: [],
    ...partial,
  };
}

export interface FakeAdminOpts {
  /** "unavailable" makes record_api_call return no row (gate fails). */
  recordApiCall?: "ok" | "unavailable";
  /** "open_approval_exists" makes create_pending_approval refuse. */
  approval?: "created" | "open_approval_exists";
}

type Filter = { col: string; op: "eq" | "gte"; value: unknown };

class FakeQuery {
  private op: "select" | "insert" | "upsert" = "select";
  private insertValues: FakeRow | FakeRow[] | null = null;
  private upsertConflict: string | null = null;
  private filters: Filter[] = [];
  private orderings: { col: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private singleRow = false;
  private maybeSingleRow = false;
  private selectAfterWrite = false;

  constructor(
    private db: FakeDb,
    private table: keyof FakeDb,
    private opts: FakeAdminOpts,
  ) {}

  select(): this {
    if (this.op !== "select") this.selectAfterWrite = true;
    return this;
  }

  insert(values: FakeRow | FakeRow[]): this {
    this.op = "insert";
    this.insertValues = values;
    return this;
  }

  upsert(values: FakeRow, options?: { onConflict?: string }): this {
    this.op = "upsert";
    this.insertValues = values;
    this.upsertConflict = options?.onConflict ?? null;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ col, op: "eq", value });
    return this;
  }

  gte(col: string, value: unknown): this {
    this.filters.push({ col, op: "gte", value });
    return this;
  }

  order(col: string, options?: { ascending?: boolean }): this {
    this.orderings.push({ col, ascending: options?.ascending ?? true });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  single(): this {
    this.singleRow = true;
    return this;
  }

  maybeSingle(): this {
    this.maybeSingleRow = true;
    return this;
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private rows(): FakeRow[] {
    const table = this.db[this.table] as FakeRow[];
    let rows = table.filter((row) =>
      this.filters.every((f) =>
        f.op === "eq" ? row[f.col] === f.value : (row[f.col] as string) >= (f.value as string),
      ),
    );
    for (const o of [...this.orderings].reverse()) {
      rows = [...rows].sort((a, b) => {
        const av = String(a[o.col] ?? "");
        const bv = String(b[o.col] ?? "");
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (o.ascending ? 1 : -1);
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private async execute(): Promise<{ data: unknown; error: unknown }> {
    const table = this.db[this.table] as FakeRow[];
    if (this.op === "insert" || this.op === "upsert") {
      const values = Array.isArray(this.insertValues)
        ? this.insertValues
        : [this.insertValues as FakeRow];
      const written: FakeRow[] = [];
      for (const value of values) {
        const row: FakeRow = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...value,
        };
        if (this.op === "upsert" && this.upsertConflict) {
          const idx = table.findIndex(
            (r) => r[this.upsertConflict as string] === value[this.upsertConflict as string],
          );
          if (idx !== -1) {
            table[idx] = { ...table[idx], ...value };
            written.push(table[idx]);
            continue;
          }
        }
        table.push(row);
        written.push(row);
      }
      if (!this.selectAfterWrite) return { data: [], error: null };
      if (this.singleRow) return { data: written[0] ?? null, error: null };
      return { data: written, error: null };
    }
    const rows = this.rows();
    if (this.singleRow) {
      if (rows.length !== 1) {
        return { data: null, error: { message: "single row expected" } };
      }
      return { data: rows[0], error: null };
    }
    if (this.maybeSingleRow) {
      if (rows.length > 1) {
        return { data: null, error: { message: "multiple rows" } };
      }
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

export function createFakeAdmin(db: FakeDb, opts: FakeAdminOpts = {}): unknown {
  return {
    auth: {
      admin: {
        listUsers: async () => ({
          data: { users: db.users },
          error: null,
        }),
      },
    },
    from: (table: keyof FakeDb) => new FakeQuery(db, table, opts),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      switch (fn) {
        case "record_api_call":
          if (opts.recordApiCall === "unavailable") {
            return { data: [], error: null };
          }
          return {
            data: [{ model_calls: 1, usage_date: today }],
            error: null,
          };
        case "refund_api_call":
        case "refund_search":
          return { data: null, error: null };
        case "record_search":
          return { data: [{ usage_date: today }], error: null };
        case "append_message": {
          const id = randomUUID();
          db.messages.push({
            id,
            conversation_id: args.p_conversation_id,
            user_id: args.p_user_id,
            role: args.p_role,
            content: args.p_content,
            parts: args.p_parts,
            tool_call_id: args.p_tool_call_id,
            created_at: new Date().toISOString(),
          });
          return { data: id, error: null };
        }
        case "create_pending_approval":
          if (opts.approval === "open_approval_exists") {
            return {
              data: [{ result_code: "open_approval_exists", approval_id: null }],
              error: null,
            };
          }
          return {
            data: [{ result_code: "created", approval_id: randomUUID() }],
            error: null,
          };
        case "log_read_only_action":
          db.action_logs.push({
            id: randomUUID(),
            user_id: args.p_user_id,
            conversation_id: args.p_conversation_id,
            approval_id: null,
            tool_call_id: args.p_tool_call_id,
            tool_name: args.p_tool,
            parameters: args.p_params,
            execution_status: args.p_status,
            result_payload: args.p_result,
            created_at: new Date().toISOString(),
          });
          return { data: [{ id: randomUUID() }], error: null };
        default:
          throw new Error(`unexpected rpc ${fn}`);
      }
    },
  };
}
