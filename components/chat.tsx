// Chat UI (M1-10, DESIGN.md §5.4/§8). The AI SDK chat hook sends the full
// history with each request (M1 only; M2-6 replaces this with
// server-authoritative history).
//
// States: empty (no messages yet), loading/submitted, streaming (blinking
// block cursor), error (with Retry), and cap-reached (the route's explicit
// 429 surfaces as an APICallError with statusCode 429 — the notice is the
// system line from DESIGN.md §5.4, and there is no Retry: the cap resets
// tomorrow). The message list is aria-live polite; the error and cap
// notices are aria-live assertive.
"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { APICallError, DefaultChatTransport } from "ai";
import SafeMarkdown from "./markdown";
import { useQuickAsk } from "./quick-ask";

function textOf(message: { parts?: unknown }): string {
  const parts = (message.parts ?? []) as Array<{ type?: string; text?: string }>;
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export default function Chat() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error, stop, regenerate } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  // A message submitted from the header quick-ask bar arrives in client
  // state (never in the URL). Consume it once on mount and send it through
  // the normal composer path — same route, same Model Gate. The consumed
  // flag stops React 19 StrictMode's double effect run (dev only) from
  // sending it twice; it resets when there is nothing pending, so a later
  // quick-ask is still delivered.
  const { pending, clear } = useQuickAsk();
  const consumedRef = useRef(false);
  useEffect(() => {
    if (!pending) {
      consumedRef.current = false;
      return;
    }
    if (consumedRef.current) return;
    consumedRef.current = true;
    const text = pending;
    clear();
    void sendMessage({ text });
  }, [pending, clear, sendMessage]);

  const isStreaming = status === "streaming" || status === "submitted";
  const isCapReached =
    error != null && APICallError.isInstance(error) && error.statusCode === 429;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    void sendMessage({ text });
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col px-4 py-6">
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <h1 className="font-display text-2xl font-semibold">Chat</h1>
          <p className="text-text-secondary">No messages yet. Ask FLASH anything…</p>
        </div>
      ) : (
        <div aria-live="polite" className="flex flex-1 flex-col gap-4">
          {messages.map((message) => {
            const text = textOf(message);
            if (message.role === "user") {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-md bg-surface-raised px-4 py-2 whitespace-pre-wrap">
                    {text}
                  </div>
                </div>
              );
            }
            if (message.role === "system") {
              return (
                <div key={message.id} className="flex justify-center">
                  <p className="font-mono text-xs text-text-secondary">{text}</p>
                </div>
              );
            }
            return (
              <div key={message.id} className="flex justify-start">
                <div className="max-w-[90%] text-text-primary">
                  <SafeMarkdown text={text} />
                  {isStreaming &&
                    message.id === messages[messages.length - 1]?.id && (
                      <span aria-hidden="true" className="ml-1 inline-block h-4 w-2 animate-pulse bg-accent-cyan" />
                    )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isCapReached && (
        <div
          role="alert"
          aria-live="assertive"
          className="mt-4 flex justify-center"
        >
          <p className="font-mono text-xs text-text-secondary">
            Daily limit reached, no model reply is available. Try again tomorrow.
          </p>
        </div>
      )}

      {error && !isCapReached && (
        <div role="alert" aria-live="assertive" className="mt-4 flex flex-col items-center gap-2">
          <p className="text-sm text-danger">The reply failed. Your message was not lost.</p>
          <button
            type="button"
            onClick={() => void regenerate()}
            className="flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm text-text-primary"
          >
            Retry
          </button>
        </div>
      )}

      <form onSubmit={submit} className="mt-6 flex gap-2">
        <label htmlFor="chat-composer" className="sr-only">
          Message FLASH
        </label>
        <textarea
          id="chat-composer"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
          }}
          rows={1}
          placeholder="Ask FLASH anything…"
          className="min-h-11 flex-1 rounded-md border border-border-strong bg-surface px-3 py-2 text-text-primary placeholder:text-text-muted"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={() => stop()}
            className="flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm text-text-primary"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={input.trim() === ""}
            className="flex min-h-11 items-center rounded-md bg-accent-cyan px-4 text-sm font-semibold text-on-accent disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}
