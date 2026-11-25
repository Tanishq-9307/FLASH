// @vitest-environment jsdom
// Chat UI tests (M1-10): empty state, message styles, streaming indicator,
// error with retry. The chat hook is mocked so no network is involved; a
// transport failure is represented by a real APICallError, exactly what
// the transport throws. (There is no cap-reached notice any more —
// owner decision 2026-11-24.)
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import Chat from "@/components/chat";
import { QuickAskProvider } from "@/components/quick-ask";
import { CHAT_LATENCY_KEY } from "@/lib/telemetry";
import { CODING_MODEL_ID, PRIMARY_MODEL_ID } from "@/lib/ai/models";

type ChatState = {
  messages: Array<{
    id: string;
    role: string;
    parts: Array<{
      type: string;
      text?: string;
      data?: { sources?: Array<{ title: string; url: string }> };
    }>;
  }>;
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

function researchedAssistantMessage(
  id: string,
  text: string,
  sources: Array<{ title: string; url: string }>,
) {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text },
      { type: "data-researched", data: { sources } },
    ],
  };
}

// Clipboard (Phase 1): jsdom has no navigator.clipboard, so paste
// tests install a fake for one test and remove it after.
function installClipboard(readText: () => Promise<string>) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { readText },
    configurable: true,
  });
}

function uninstallClipboard() {
  // Navigator declares clipboard as required in lib.dom, so the cast
  // goes through unknown to make the property optional for delete.
  delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
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

  // Coding mode (2026-11-24): the toggle is a labelled switch, off
  // by default, and the header shows the model that will be used.
  it("coding mode toggle is off by default and shows the default model", () => {
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    const toggle = screen.getByRole("switch", { name: "Coding mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(`Model: ${PRIMARY_MODEL_ID}`)).toBeDefined();
  });

  it("flipping the toggle shows the coding model; flipping back restores the default", () => {
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    const toggle = screen.getByRole("switch", { name: "Coding mode" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(`Model: ${CODING_MODEL_ID}`)).toBeDefined();
    expect(screen.queryByText(`Model: ${PRIMARY_MODEL_ID}`)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(`Model: ${PRIMARY_MODEL_ID}`)).toBeDefined();
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

  // Clipboard paste (Phase 1, 2026-11-25): the button reads only on
  // tap and inserts the text as ordinary composer input — nothing is
  // sent until the user presses Send.
  it("paste from clipboard fills the composer and sends nothing until Send", async () => {
    installClipboard(async () => "pasted hello");
    try {
      render(
        <QuickAskProvider>
          <Chat />
        </QuickAskProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      const input = screen.getByLabelText("Message FLASH") as HTMLTextAreaElement;
      await waitFor(() => expect(input.value).toBe("pasted hello"));
      expect(chatState.current.sendMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Send/ }));
      expect(chatState.current.sendMessage).toHaveBeenCalledWith({
        text: "pasted hello",
      });
      expect(input.value).toBe("");
    } finally {
      uninstallClipboard();
    }
  });

  it("denied clipboard permission shows a message and leaves the composer alone", async () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";
    installClipboard(async () => {
      throw error;
    });
    try {
      render(
        <QuickAskProvider>
          <Chat />
        </QuickAskProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "Clipboard access was blocked",
        ),
      );
      expect(
        (screen.getByLabelText("Message FLASH") as HTMLTextAreaElement).value,
      ).toBe("");
      expect(chatState.current.sendMessage).not.toHaveBeenCalled();
    } finally {
      uninstallClipboard();
    }
  });

  it("no clipboard API shows the unavailable message with the keyboard fallback", async () => {
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "isn't available in this browser",
      ),
    );
    expect(screen.getByRole("status").textContent).toContain("Ctrl+V");
    expect(chatState.current.sendMessage).not.toHaveBeenCalled();
  });

  it("paste button is disabled while streaming", () => {
    chatState.current.status = "streaming";
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(
      screen
        .getByRole("button", { name: "Paste from clipboard" })
        .hasAttribute("disabled"),
    ).toBe(true);
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

  // Silent web research (2026-11-24): a reply whose message carries
  // a data-researched part shows a small "researched the web"
  // indicator with the real sources as links; an unresearched reply
  // shows nothing.
  it("shows the researched indicator with real source links on a researched reply", () => {
    chatState.current.messages = [
      userMessage("u1", "latest ISRO news"),
      researchedAssistantMessage("a1", "Hello", [
        { title: "ISRO launches", url: "https://example.com/isro" },
        { title: "Second report", url: "https://example.com/second" },
      ]),
    ];
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(screen.getByText(/Researched the web/)).toBeDefined();
    const link = screen.getByRole("link", { name: "ISRO launches" });
    expect(link.getAttribute("href")).toBe("https://example.com/isro");
    expect(
      screen.getByRole("link", { name: "Second report" }),
    ).toBeDefined();
  });

  it("shows no researched indicator on an unresearched reply", () => {
    chatState.current.messages = [
      userMessage("u1", "hello"),
      assistantMessage("a1", "Hello"),
    ];
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(screen.queryByText(/Researched the web/)).toBeNull();
  });

  it("shows the source domain when a researched source has no title", () => {
    chatState.current.messages = [
      researchedAssistantMessage("a1", "Hello", [
        { title: "", url: "https://example.com/untitled" },
      ]),
    ];
    render(
      <QuickAskProvider>
        <Chat />
      </QuickAskProvider>,
    );
    expect(screen.getByText(/Researched the web/)).toBeDefined();
    expect(
      screen.getByRole("link", { name: "example.com" }),
    ).toBeDefined();
  });
});
