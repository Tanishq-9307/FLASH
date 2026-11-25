// Telegram remote-chat tests (Phase 3): a Telegram message goes
// through the same pipeline as the web chat — same model (mocked at
// the Groq provider, so no quota is used), same memory/vector/silent
// paths (absent without keys, so they degrade gracefully), same tool
// loop and approvals discipline. The admin client is the in-memory
// fake from tests/telegram-helpers.ts.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import type {
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import {
  createFakeAdmin,
  createFakeDb,
  FAKE_OWNER_ID,
  type FakeDb,
  type FakeAdminOpts,
} from "./telegram-helpers";

// Hoisted model behaviour: vi.mock factories run before imports.
const modelState = vi.hoisted(() => ({
  calls: 0,
  mode: "text" as "text" | "get_tasks" | "create_task" | "error",
  lastPrompt: null as unknown,
}));

function generateResult(
  content: Array<LanguageModelV4Content>,
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: {
      unified: content.some((c) => c.type === "tool-call")
        ? "tool-calls"
        : "stop",
      raw: undefined,
    },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

vi.mock("@ai-sdk/groq", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    groq: () =>
      new MockLanguageModelV4({
        doGenerate: async (options) => {
          modelState.calls += 1;
          modelState.lastPrompt = options.prompt;
          if (modelState.mode === "error") {
            throw new Error("provider 503 overloaded");
          }
          if (modelState.mode === "get_tasks") {
            if (modelState.calls === 1) {
              return generateResult([
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "get_tasks",
                  input: "{}",
                },
              ]);
            }
            return generateResult([
              { type: "text", text: "You have 1 pending task." },
            ]);
          }
          if (modelState.mode === "create_task") {
            return generateResult([
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "create_task",
                input: JSON.stringify({ title: "Buy milk" }),
              },
            ]);
          }
          return generateResult([{ type: "text", text: "Hello from Telegram" }]);
        },
      }),
  };
});

import { runTelegramChat } from "@/lib/telegram/run-chat";

function runChat(db: FakeDb, text: string, opts: FakeAdminOpts = {}) {
  return runTelegramChat(
    createFakeAdmin(db, opts) as unknown as SupabaseClient<Database>,
    FAKE_OWNER_ID,
    text,
  );
}

beforeEach(() => {
  modelState.calls = 0;
  modelState.mode = "text";
  modelState.lastPrompt = null;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runTelegramChat", () => {
  it("replies with the model's text and persists the turn in a Telegram conversation", async () => {
    const db = createFakeDb();
    const result = await runChat(db, "hello");
    expect(result.reply).toBe("Hello from Telegram");
    expect(result.conversationId).not.toBeNull();
    expect(result.approvalId).toBeNull();
    expect(modelState.calls).toBe(1);

    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0].title).toBe("Telegram");
    expect(db.conversations[0].user_id).toBe(FAKE_OWNER_ID);
    const roles = db.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(db.messages[0].content).toBe("hello");
    expect(db.messages[1].content).toBe("Hello from Telegram");
  });

  it("reuses the same Telegram conversation across messages", async () => {
    const db = createFakeDb();
    await runChat(db, "hello");
    const second = await runChat(db, "hello again");
    expect(db.conversations).toHaveLength(1);
    expect(second.conversationId).toBe(db.conversations[0].id);
    expect(db.messages).toHaveLength(4);
  });

  it("runs the model's get_tasks tool call and answers from the real task list", async () => {
    modelState.mode = "get_tasks";
    const db = createFakeDb({
      tasks: [
        {
          id: "t1",
          title: "Pay caution money",
          due_date: null,
          status: "pending",
          created_at: "2026-11-20T00:00:00.000Z",
          updated_at: "2026-11-20T00:00:00.000Z",
          user_id: FAKE_OWNER_ID,
        },
      ],
    });
    const result = await runChat(db, "what are my tasks?");
    expect(result.reply).toBe("You have 1 pending task.");
    expect(modelState.calls).toBe(2);
    // The read-only tool call was logged in the activity log.
    expect(
      db.action_logs.some(
        (r) => r.tool_name === "get_tasks" && r.execution_status === "succeeded",
      ),
    ).toBe(true);
  });

  it("turns a create_task proposal into a pending approval, never an execution", async () => {
    modelState.mode = "create_task";
    const db = createFakeDb();
    const result = await runChat(db, "remind me to buy milk");
    expect(result.approvalId).not.toBeNull();
    expect(result.reply).toContain("Buy milk");
    expect(result.reply).toContain("FLASH web app");
    // Nothing was executed: no task row appeared.
    expect(db.tasks).toHaveLength(0);
  });

  it("answers honestly when the model cannot be reached, without persisting a fake reply", async () => {
    modelState.mode = "error";
    const db = createFakeDb();
    const result = await runChat(db, "hello");
    expect(result.reply).toBe("The model could not be reached. Try again.");
    expect(modelState.calls).toBe(1);
    // The user message stays; no assistant reply was persisted.
    expect(db.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("fails closed when the usage record fails, without calling the model", async () => {
    const db = createFakeDb();
    const result = await runChat(db, "hello", { recordApiCall: "unavailable" });
    expect(result.reply).toContain("usage could not be recorded");
    expect(modelState.calls).toBe(0);
  });
});
