// Chat UI (M1-10, DESIGN.md §5.4/§8; M2-6 server-authoritative history).
// The hook sends only the latest message plus the conversation ID — the
// server loads history from the database, so the browser can no longer
// forge, drop, or reorder turns. The conversation ID arrives as a data
// part at the start of the stream; when the stream finishes, the URL moves
// to /chat?id=<id> so a refresh reloads the conversation.
//
// States: empty (no messages yet), loading/submitted, streaming (blinking
// block cursor), error (with Retry), and cap-reached (the route's explicit
// 429 surfaces as an APICallError with statusCode 429 — the notice is the
// system line from DESIGN.md §5.4, and there is no Retry: the cap resets
// tomorrow). The message list is aria-live polite; the error and cap
// notices are aria-live assertive.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { APICallError, DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import SafeMarkdown from "./markdown";
import { useQuickAsk } from "./quick-ask";
import { useRefreshConversations } from "./conversations-context";

function textOf(message: { parts?: unknown }): string {
  const parts = (message.parts ?? []) as Array<{ type?: string; text?: string }>;
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export default function Chat({
  initialMessages,
  conversationId,
}: {
  initialMessages?: UIMessage[];
  conversationId?: string | null;
}) {
  const [input, setInput] = useState("");
  const router = useRouter();
  // The conversation ID the transport sends with each request. Starts as
  // the ID the page loaded (if any); a new conversation's ID arrives in
  // the data part at the start of the first stream and lands here via
  // onData. State, not a ref: useChat re-reads the latest transport on
  // every send, so a new transport each render always carries the
  // current ID.
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(
    conversationId ?? null,
  );
  // A new conversation or a finished reply changes the list (a new row,
  // or updated_at moving the row to the top) — re-list from the server.
  const refreshConversations = useRefreshConversations();

  const { messages, sendMessage, status, error, stop, regenerate } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages: all, trigger }) => {
        if (trigger === "regenerate-message") {
          return {
            body: { conversationId: currentConversationId, regenerate: true },
          };
        }
        // Only the latest message travels: the server owns the history.
        const last = all[all.length - 1];
        return {
          body: { conversationId: currentConversationId, message: last },
        };
      },
    }),
    onData: (part) => {
      if (part.type === "data-conversation") {
        const data = part.data as { conversationId?: unknown };
        if (typeof data.conversationId === "string") {
          setCurrentConversationId(data.conversationId);
          refreshConversations();
        }
      }
    },
    onFinish: () => {
      refreshConversations();
      // A new conversation now has an ID: move to its URL so a refresh
      // reloads it from the database instead of starting over.
      if (currentConversationId && currentConversationId !== conversationId) {
        router.replace(`/chat?id=${currentConversationId}`);
      }
    },
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
