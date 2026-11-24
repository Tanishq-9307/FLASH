// Chat UI (M1-10, DESIGN.md §5.4/§8; M2-6 server-authoritative history).
// The hook sends only the latest message plus the conversation ID — the
// server loads history from the database, so the browser can no longer
// forge, drop, or reorder turns. The conversation ID arrives as a data
// part at the start of the stream; when the stream finishes, the URL moves
// to /chat?id=<id> so a refresh reloads the conversation.
//
// States: empty (no messages yet), loading/submitted, streaming (blinking
// block cursor), error (with Retry). There is no cap-reached state any
// more (owner decision 2026-11-24): the route never returns 429 for a
// cap, so every failure is the generic error with Retry. The message
// list is aria-live polite; the error notice is aria-live assertive.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import SafeMarkdown from "./markdown";
import { useQuickAsk } from "./quick-ask";
import { useRefreshConversations } from "./conversations-context";
import { createChatLatencyTracker, recordChatLatency } from "@/lib/telemetry";
import { ApprovalController, resumeApproval } from "./approvals/approval-controller";
import {
  executeAction,
  getApprovalSnapshot,
  rejectAction,
} from "@/app/approvals/actions";
import { loadConversationMessages } from "@/app/chat/actions";

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
  openApprovalId,
}: {
  initialMessages?: UIMessage[];
  conversationId?: string | null;
  /** An approval already open for this conversation (loaded by the
   * page, e.g. after following the delete-guard link): the dialog
   * opens for it without waiting for a new stream. */
  openApprovalId?: string | null;
}) {
  const [input, setInput] = useState("");
  const router = useRouter();
  // The approval the dialog is open for: from the chat stream's
  // data-approval part, or from the page's openApprovalId prop.
  const [approvalId, setApprovalId] = useState<string | null>(openApprovalId ?? null);
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

  // App telemetry (2026-11-24): the reply is timed client-side, send →
  // first streamed token → completion, and the completed sample is kept
  // for the Overview Usage panel. A stopped or failed reply records
  // nothing — it is not a completed reply. One tracker per mount, from
  // the state initializer, so its identity is stable across renders.
  const [latencyTracker] = useState(() => createChatLatencyTracker());

  const { messages, sendMessage, setMessages, status, error, stop, regenerate } = useChat({
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
      // M3-18/21b: the stream ends with an approval ID (data-approval).
      // Show the dialog for it; the dialog renders the stored snapshot,
      // never anything from the stream.
      if (part.type === "data-approval") {
        const data = part.data as { approvalId?: unknown };
        if (typeof data.approvalId === "string") {
          setApprovalId(data.approvalId);
          // The layout's Activity badge is server-rendered: refresh it.
          router.refresh();
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

  // The chat hook's status drives the latency tracker: "streaming"
  // means the first token has arrived, "ready" after a stream means
  // the reply completed, "error" means it failed. The mount-time
  // "ready" is a no-op — the tracker has no send in flight, so
  // onFinish returns null.
  useEffect(() => {
    if (status === "streaming") {
      latencyTracker.onFirstToken();
    } else if (status === "ready") {
      const sample = latencyTracker.onFinish(new Date().toISOString());
      if (sample) recordChatLatency(sample);
    } else if (status === "error") {
      latencyTracker.onError();
    }
  }, [status, latencyTracker]);

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
    latencyTracker.onSend();
    void sendMessage({ text });
  }, [pending, clear, sendMessage, latencyTracker]);

  // After an approval outcome is delivered, the resume follow-up is
  // persisted server-side: reload the stored messages so the chat
  // shows the real history, refresh the conversation list (the
  // outcome moved updated_at) and the server-rendered nav badge.
  const reloadAfterResolve = useCallback(async () => {
    const id = currentConversationId;
    if (id) {
      const reloaded = await loadConversationMessages(id);
      if (reloaded.ok) setMessages(reloaded.data);
    }
    refreshConversations();
    router.refresh();
  }, [currentConversationId, refreshConversations, router, setMessages]);

  const isStreaming = status === "streaming" || status === "submitted";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    latencyTracker.onSend();
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

      {error && (
        <div role="alert" aria-live="assertive" className="mt-4 flex flex-col items-center gap-2">
          <p className="text-sm text-danger">The reply failed. Your message was not lost.</p>
          <button
            type="button"
            onClick={() => {
              latencyTracker.onSend();
              void regenerate();
            }}
            className="flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm text-text-primary"
          >
            Retry
          </button>
        </div>
      )}

      {approvalId ? (
        <ApprovalController
          approvalId={approvalId}
          actions={{
            getApproval: getApprovalSnapshot,
            executeAction,
            rejectAction,
            resume: resumeApproval,
          }}
          onResolved={() => void reloadAfterResolve()}
          onClose={() => setApprovalId(null)}
        />
      ) : null}

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
            onClick={() => {
              // A stopped reply is not a completed reply: the tracker
              // drops it, so the Overview never shows a stopped reply
              // as a completion time.
              latencyTracker.onStop();
              stop();
            }}
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
