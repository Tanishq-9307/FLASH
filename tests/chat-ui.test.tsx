// @vitest-environment jsdom
// Chat UI tests (M1-10): empty state, message styles, streaming indicator,
// error with retry. The chat hook is mocked so no network is involved; a
// transport failure is represented by a real APICallError, exactly what
// the transport throws. (There is no cap-reached notice any more —
// owner decision 2026-11-24.)
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import Chat from "@/components/chat";
import { QuickAskProvider } from "@/components/quick-ask";
import { CHAT_LATENCY_KEY } from "@/lib/telemetry";

type ChatState = {
  messages: Array<{ id: string; role: string; parts: Array<{ type: string; text: string }> }>;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | undefined;
  sendMessage: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
};

const chatState = vi.hoisted(() => ({
  current: {
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
  } as ChatState,
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => chatState.current,
}));

// The chat now uses useRouter (M2-6: move to /chat?id=<id> when a new
// conversation's first stream finishes). The hook is mocked, so no router
// is involved; the stub only has to exist.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

// The chat renders the approval controller (M3-21b), which calls the
// Server Actions. Those modules import server-only code, so they are
// mocked here; the controller itself is covered in
// tests/approval-controller.test.tsx.
vi.mock("@/app/approvals/actions", () => ({
  getApprovalSnapshot: vi.fn(),
  executeAction: vi.fn(),
  rejectAction: vi.fn(),
}));

vi.mock("@/app/chat/actions", () => ({
  loadConversationMessages: vi.fn(async () => ({ ok: true, data: [] })),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  chatState.current = {
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
  };
});

function userMessage(id: string, text: string) {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string) {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("Chat UI", () => {
  it("shows the empty state with no messages", () => {
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(screen.getByText("No messages yet. Ask FLASH anything…")).toBeDefined();
  });

  it("renders user and assistant messages, markdown for the assistant", () => {
    chatState.current.messages = [
      userMessage("u1", "hello"),
      assistantMessage("a1", "Hi **there**"),
    ];
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByText("there").tagName).toBe("STRONG");
    expect(screen.queryByText("No messages yet. Ask FLASH anything…")).toBeNull();
  });

  it("shows the streaming indicator while streaming", () => {
    chatState.current.messages = [assistantMessage("a1", "Hello")];
    chatState.current.status = "streaming";
    const { container } = render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeDefined();
  });

  it("sends the composer text and clears the input", () => {
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    const input = screen.getByLabelText("Message FLASH");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(chatState.current.sendMessage).toHaveBeenCalledWith({ text: "hello" });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("Stop calls stop while streaming", () => {
    chatState.current.status = "streaming";
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(chatState.current.stop).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with Retry, and Retry regenerates", () => {
    chatState.current.error = new Error("network down");
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(screen.getByRole("alert").textContent).toContain("The reply failed.");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(chatState.current.regenerate).toHaveBeenCalledTimes(1);
  });

  it("a 429 is a generic failure with Retry — there is no cap-reached state any more", () => {
    chatState.current.error = new APICallError({
      message: "rate limited",
      url: "http://localhost/api/chat",
      requestBodyValues: {},
      statusCode: 429,
    });
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The reply failed");
    expect(alert.textContent).not.toContain("Daily limit reached");
    expect(within(document.body).getByRole("button", { name: /Retry/ })).toBeDefined();
  });

  // App telemetry (2026-11-24): the reply is timed send → first token →
  // completion and the sample is kept for the Overview Usage panel. The
  // mocked hook drives the status transitions; the clock is stubbed so
  // the recorded timings are exact.
  it("records the timed reply when a reply completes", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Rerender takes fresh JSX each time: an identical element
    // reference bails out of re-rendering, so the mocked hook's new
    // status would never reach the component.
    const chat = () => (
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>
    );
    const { rerender } = render(chat());
    const input = screen.getByLabelText("Message FLASH");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    now = 2200;
    chatState.current = { ...chatState.current, status: "streaming" };
    rerender(chat());
    now = 5500;
    chatState.current = { ...chatState.current, status: "ready" };
    rerender(chat());
    const stored = JSON.parse(window.localStorage.getItem(CHAT_LATENCY_KEY) ?? "null") as {
      firstTokenMs: number;
      totalMs: number;
      at: string;
    } | null;
    expect(stored).not.toBeNull();
    expect(stored?.firstTokenMs).toBe(1200);
    expect(stored?.totalMs).toBe(4500);
    expect(typeof stored?.at).toBe("string");
  });

  it("a stopped reply records nothing", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const chat = () => (
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>
    );
    const { rerender } = render(chat());
    const input = screen.getByLabelText("Message FLASH");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    now = 1500;
    chatState.current = { ...chatState.current, status: "streaming" };
    rerender(chat());
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    now = 2000;
    chatState.current = { ...chatState.current, status: "ready" };
    rerender(chat());
    expect(window.localStorage.getItem(CHAT_LATENCY_KEY)).toBeNull();
  });
});
