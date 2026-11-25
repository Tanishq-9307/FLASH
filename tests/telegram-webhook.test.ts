// Telegram webhook route tests (Phase 3): secret verification,
// owner lock, command handling, chat relay, and the inert
// missing-token case. The admin client, the chat pipeline, and the
// Bot API send are all mocked; the route's own checks are real.
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
import {
  createFakeAdmin,
  createFakeDb,
  FAKE_OWNER_ID,
  type FakeDb,
} from "./telegram-helpers";

const state = vi.hoisted(() => ({
  db: null as FakeDb | null,
  sendCalls: [] as { chatId: unknown; text: string }[],
  chatCalls: [] as string[],
  chatReply: "Hello from Telegram",
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () =>
    createFakeAdmin(state.db!) as unknown as SupabaseClient<Database>,
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: vi.fn(
    async (_token: string, chatId: unknown, text: string) => {
      state.sendCalls.push({ chatId, text });
      return { ok: true, chunks: 1 };
    },
  ),
}));

vi.mock("@/lib/telegram/run-chat", () => ({
  runTelegramChat: vi.fn(async (_admin: unknown, _userId: string, text: string) => {
    state.chatCalls.push(text);
    return {
      reply: state.chatReply,
      conversationId: "conv-1",
      approvalId: null,
    };
  }),
}));

import { POST } from "@/app/api/telegram/webhook/route";

const OWNER_ID = 123456789;
const SECRET = "s3cr3t";

function webhookRequest(
  update: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
      ...headers,
    },
    body: JSON.stringify(update),
  });
}

function messageUpdate(text: string | undefined, fromId: number = OWNER_ID) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: fromId, is_bot: false, first_name: "Tanishq" },
      chat: { id: fromId, type: "private" },
      date: 1764020000,
      ...(text === undefined ? {} : { text }),
    },
  };
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "token-123";
  process.env.TELEGRAM_USER_ID = String(OWNER_ID);
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  state.db = createFakeDb({
    tasks: [
      {
        id: "t1",
        title: "Pay caution money",
        due_date: "2026-11-30T00:00:00+05:30",
        status: "pending",
        created_at: "2026-11-20T00:00:00.000Z",
        updated_at: "2026-11-20T00:00:00.000Z",
        user_id: FAKE_OWNER_ID,
      },
    ],
    api_usage: [
      { user_id: FAKE_OWNER_ID, usage_date: "2026-11-25", model_calls: 250 },
    ],
  });
  state.sendCalls = [];
  state.chatCalls = [];
  state.chatReply = "Hello from Telegram";
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_USER_ID;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  vi.unstubAllEnvs();
});

describe("POST /api/telegram/webhook", () => {
  it("rejects a wrong webhook secret with 403 and sends nothing", async () => {
    const res = await POST(
      webhookRequest(messageUpdate("hello"), {
        "x-telegram-bot-api-secret-token": "wrong",
      }),
    );
    expect(res.status).toBe(403);
    expect(state.sendCalls).toHaveLength(0);
    expect(state.chatCalls).toHaveLength(0);
  });

  it("rejects a missing webhook secret with 403", async () => {
    const req = new Request("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageUpdate("hello")),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("gives a non-owner nothing: 200, no reply, no chat call", async () => {
    const res = await POST(webhookRequest(messageUpdate("hello", 999)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.sendCalls).toHaveLength(0);
    expect(state.chatCalls).toHaveLength(0);
  });

  it("answers /help with the command list", async () => {
    const res = await POST(webhookRequest(messageUpdate("/help")));
    expect(res.status).toBe(200);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].text).toContain("/tasks");
    expect(state.chatCalls).toHaveLength(0);
  });

  it("answers /tasks from the real task list", async () => {
    const res = await POST(webhookRequest(messageUpdate("/tasks")));
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("Pay caution money");
    expect(state.sendCalls[0].text).toContain("2026-11-30");
  });

  it("answers /usage with the real usage percentages", async () => {
    const res = await POST(webhookRequest(messageUpdate("/usage")));
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("Model today: 250/1000 calls (25%)");
  });

  it("answers /stop by turning proactive nudges off", async () => {
    const res = await POST(webhookRequest(messageUpdate("/stop")));
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("Proactive nudges are off");
    expect(state.db!.settings).toHaveLength(1);
    expect(state.db!.settings[0].telegram_proactive_enabled).toBe(false);
  });

  it("answers /resume by turning proactive nudges back on", async () => {
    await POST(webhookRequest(messageUpdate("/stop")));
    const res = await POST(webhookRequest(messageUpdate("/resume")));
    expect(res.status).toBe(200);
    expect(state.sendCalls[1].text).toContain("back on");
    expect(state.db!.settings[0].telegram_proactive_enabled).toBe(true);
  });

  it("answers /remind by creating the reminder at once", async () => {
    const res = await POST(
      webhookRequest(messageUpdate("/remind tomorrow 9am submit the form")),
    );
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain('Reminder set: "submit the form"');
    expect(state.sendCalls[0].text).toContain("9:00 am");
    expect(state.chatCalls).toHaveLength(0);
    expect(state.db!.reminders).toHaveLength(1);
    expect(state.db!.reminders[0].message).toBe("submit the form");
    expect(state.db!.reminders[0].source).toBe("telegram");
    expect(state.db!.reminders[0].status).toBe("pending");
  });

  it("answers /remind with a clarification instead of guessing the time", async () => {
    const res = await POST(
      webhookRequest(messageUpdate("/remind submit the form")),
    );
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("When should I remind you?");
    expect(state.chatCalls).toHaveLength(0);
    expect(state.db!.reminders).toHaveLength(0);
  });

  it("answers /remind with a clarification when the message is missing", async () => {
    const res = await POST(
      webhookRequest(messageUpdate("/remind tomorrow at 9am")),
    );
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("What should I remind you about?");
    expect(state.db!.reminders).toHaveLength(0);
  });

  it("answers /reminders from the real reminder list", async () => {
    state.db!.reminders = [
      {
        id: "r1",
        user_id: FAKE_OWNER_ID,
        message: "Submit the form",
        remind_at: "2026-11-26T03:30:00.000Z",
        status: "pending",
        source: "telegram",
        sent_at: null,
        created_at: "2026-11-25T03:00:00.000Z",
        updated_at: "2026-11-25T03:00:00.000Z",
      },
    ];
    const res = await POST(webhookRequest(messageUpdate("/reminders")));
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("Submit the form");
    expect(state.sendCalls[0].text).toContain("26 Nov 2026, 9:00 am");
    expect(state.chatCalls).toHaveLength(0);
  });

  it("rejects an unknown command without calling the chat pipeline", async () => {
    const res = await POST(webhookRequest(messageUpdate("/dance")));
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("Unknown command /dance");
    expect(state.chatCalls).toHaveLength(0);
  });

  it("relays plain text through the chat pipeline and sends the reply", async () => {
    const res = await POST(webhookRequest(messageUpdate("what is 2+2?")));
    expect(res.status).toBe(200);
    expect(state.chatCalls).toEqual(["what is 2+2?"]);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]).toEqual({
      chatId: OWNER_ID,
      text: "Hello from Telegram",
    });
  });

  it("answers a non-text message with a text-only note", async () => {
    const res = await POST(webhookRequest(messageUpdate(undefined)));
    expect(res.status).toBe(200);
    expect(state.sendCalls[0].text).toContain("only read text messages");
    expect(state.chatCalls).toHaveLength(0);
  });

  it("is inert with 503 when the bot token is missing (no crash, no send)", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = await POST(webhookRequest(messageUpdate("hello")));
    expect(res.status).toBe(503);
    expect(state.sendCalls).toHaveLength(0);
    expect(state.chatCalls).toHaveLength(0);
  });
});
