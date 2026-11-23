// @vitest-environment jsdom
// Chat UI tests (M1-10): empty state, message styles, streaming indicator,
// error with retry, and the cap-reached notice. The chat hook is mocked so
// no network is involved; the route's 429 is represented by a real
// APICallError with statusCode 429, exactly what the transport throws.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import Chat from "@/components/chat";
import { QuickAskProvider } from "@/components/quick-ask";

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

afterEach(() => {
  cleanup();
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

  it("shows the cap-reached notice for a 429 and offers no Retry", () => {
    chatState.current.error = new APICallError({
      message: "cap reached",
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
    expect(alert.textContent).toContain("Daily limit reached");
    expect(within(document.body).queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});
