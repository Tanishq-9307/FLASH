// @vitest-environment jsdom
// Quick-ask bar tests (M1-10b): submit navigates to /chat with the message in
// client state (never the URL), Ctrl+Space focuses the bar, it is hidden on
// the Chat screen and on mobile, and Chat consumes the pending message.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickAskBar, QuickAskProvider, useQuickAsk } from "@/components/quick-ask";
import Chat from "@/components/chat";

const pathnameMock = vi.hoisted(() => ({ current: "/tasks" }));
const pushMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.current,
  useRouter: () => ({ push: pushMock }),
}));

const chatState = vi.hoisted(() => ({
  current: {
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
  },
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => chatState.current,
}));

afterEach(() => {
  cleanup();
  pathnameMock.current = "/tasks";
  pushMock.mockClear();
  chatState.current = {
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
  };
});

function renderBar() {
  return render(
    <QuickAskProvider>
      <QuickAskBar />
    </QuickAskProvider>,
  );
}

describe("QuickAskBar", () => {
  it("submits the text, navigates to /chat, and never puts the text in the URL", () => {
    renderBar();
    const input = screen.getByLabelText("Ask FLASH anything");
    fireEvent.change(input, { target: { value: "hello flash" } });
    fireEvent.submit(input.closest("form")!);
    expect(pushMock).toHaveBeenCalledWith("/chat");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).not.toContain("hello");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does nothing on an empty submit", () => {
    renderBar();
    fireEvent.submit(screen.getByLabelText("Ask FLASH anything").closest("form")!);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("Ctrl+Space focuses the input", () => {
    renderBar();
    const input = screen.getByLabelText("Ask FLASH anything");
    input.blur();
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: " ", ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("is hidden on the Chat screen", () => {
    pathnameMock.current = "/chat";
    renderBar();
    expect(screen.queryByLabelText("Ask FLASH anything")).toBeNull();
  });

  it("is hidden on mobile (hidden below md)", () => {
    const { container } = renderBar();
    const form = container.querySelector("form");
    expect(form?.className).toContain("hidden");
    expect(form?.className).toContain("md:flex");
  });

  it("hides the shortcut hint on touch devices", () => {
    renderBar();
    const hint = screen.getByText("Ctrl+Space");
    expect(hint.className).toContain("[@media(hover:hover)]:block");
  });
});

describe("QuickAskProvider + Chat", () => {
  it("Chat sends the pending quick-ask message once, through the normal path", () => {
    function AskButton() {
      const { ask } = useQuickAsk();
      return <button onClick={() => ask("hello from the header")}>ask</button>;
    }
    const { rerender } = render(
      <QuickAskProvider>
        <AskButton />
      </QuickAskProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    rerender(
      <QuickAskProvider>
        <AskButton />
        <Chat />
      </QuickAskProvider>,
    );
    expect(chatState.current.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatState.current.sendMessage).toHaveBeenCalledWith({
      text: "hello from the header",
    });
  });
});
