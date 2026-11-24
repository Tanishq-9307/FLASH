// Conversation list panel (M2-7, DESIGN.md §5.1/§5.4).
//
// 280px, collapsible on desktop (>=768px); a slide-over opened from a
// "Conversations" button on mobile. Ordered by updated_at, newest first.
// Rename and delete go through the Server Actions in app/chat/actions.ts;
// a row changes only after the server confirms it (DESIGN.md §9, rule 2).
// Deleting a conversation with an open approval is refused by the
// database guard (M3-1b) and surfaces as "Cancel the pending action
// first." Icons are inline SVGs in the same style as components/nav.tsx
// (no icon dependency in this repo).
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  deleteConversation,
  listConversations,
  renameConversation,
} from "@/app/chat/actions";
import { MAX_TITLE_CHARS, type ConversationSummary } from "@/lib/conversations";
import { ConversationsRefreshContext } from "./conversations-context";

type IconProps = { className?: string };

function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ChevronLeftIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="m15 5-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="m4 12.5 5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 20h4L20 8l-4-4L4 16v4Z" strokeLinejoin="round" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  );
}

function TrashIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ERRORS: Record<string, string> = {
  invalid: "Titles need 1 to 255 characters.",
  not_found: "That conversation no longer exists.",
  unauthenticated: "You are signed out. Sign in again.",
  unavailable: "Could not reach the database. Nothing was changed.",
  open_approval: "Cancel the pending action first.",
};

const iconButton =
  "flex size-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:text-text-primary";

export function ConversationPanel({
  initial,
  loadError,
  activeId,
  children,
}: {
  initial: ConversationSummary[];
  loadError: boolean;
  activeId: string | null;
  children: React.ReactNode;
}) {
  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(
    loadError ? "Conversations unavailable." : null,
  );
  // The conversation whose delete was blocked by an open approval.
  const [blockedId, setBlockedId] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();

  const refresh = useCallback(() => {
    void listConversations().then((result) => {
      if (result.ok) {
        setItems(result.data);
        setError(null);
      } else {
        setError("Conversations unavailable.");
      }
    });
  }, []);

  const list = (
    <nav aria-label="Conversations" className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border p-2">
        <Link
          href="/chat"
          onClick={() => setMobileOpen(false)}
          className="flex h-11 flex-1 items-center gap-2 rounded-md px-3 text-text-primary hover:bg-surface-raised"
        >
          <PlusIcon className="size-4" /> New chat
        </Link>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Hide conversations"
          className={`${iconButton} hidden md:flex`}
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="Close conversations"
          className={`${iconButton} md:hidden`}
        >
          <CloseIcon className="size-4" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-danger">
          {error}{" "}
          {blockedId ? (
            <Link
              href={`/chat?id=${blockedId}`}
              onClick={() => setMobileOpen(false)}
              className="text-accent-cyan underline"
            >
              Open the pending action
            </Link>
          ) : null}
        </p>
      ) : null}
      {items.length === 0 && !loadError ? (
        <p className="px-3 py-4 text-sm text-text-secondary">
          No conversations yet. Your first message starts one.
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {items.map((item) => (
            <ConversationRow
              key={item.id}
              item={item}
              active={item.id === activeId}
              onNavigate={() => setMobileOpen(false)}
              onError={(code) => {
                setError(code ? (ERRORS[code] ?? ERRORS.unavailable) : null);
                setBlockedId(code === "open_approval" ? item.id : null);
              }}
              onRenamed={(row) => {
                setError(null);
                setItems((all) =>
                  all.map((x) => (x.id === row.id ? row : x)),
                );
              }}
              onDeleted={() => {
                setError(null);
                setItems((all) => all.filter((x) => x.id !== item.id));
                if (item.id === activeId) router.push("/chat");
              }}
            />
          ))}
        </ul>
      )}
    </nav>
  );

  return (
    <ConversationsRefreshContext.Provider value={refresh}>
      <div className="flex">
        {open ? (
          <aside className="hidden h-[calc(100dvh-4rem)] w-[280px] shrink-0 border-r border-border bg-surface md:block">
            {list}
          </aside>
        ) : (
          <div className="hidden border-r border-border bg-surface p-2 md:block">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Show conversations"
              className={iconButton}
            >
              <ChevronRightIcon className="size-4" />
            </button>
          </div>
        )}
        {mobileOpen ? (
          <div className="fixed inset-x-0 top-16 bottom-16 z-30 bg-surface md:hidden">
            {list}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="border-b border-border bg-surface px-3 py-1 md:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-11 items-center gap-2 text-sm text-text-secondary"
            >
              <ChevronRightIcon className="size-4" /> Conversations
            </button>
          </div>
          {children}
        </div>
      </div>
    </ConversationsRefreshContext.Provider>
  );
}

function ConversationRow({
  item,
  active,
  onNavigate,
  onError,
  onRenamed,
  onDeleted,
}: {
  item: ConversationSummary;
  active: boolean;
  onNavigate: () => void;
  /** An error code to show, or null to clear the message. */
  onError: (code: string | null) => void;
  onRenamed: (row: ConversationSummary) => void;
  onDeleted: () => void;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "confirm">("view");
  const [title, setTitle] = useState(item.title);
  const [pending, startTransition] = useTransition();

  if (mode === "rename") {
    return (
      <li>
        <form
          className="flex items-center gap-1 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await renameConversation(item.id, title);
              if (result.ok) {
                onRenamed(result.data);
                setMode("view");
              } else {
                onError(result.error);
              }
            });
          }}
        >
          <label htmlFor={`rename-${item.id}`} className="sr-only">
            New title
          </label>
          <input
            id={`rename-${item.id}`}
            value={title}
            maxLength={MAX_TITLE_CHARS}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            className="h-11 min-w-0 flex-1 rounded-md border border-border-strong bg-background px-2 text-sm"
          />
          <button
            type="submit"
            disabled={pending}
            aria-label="Save title"
            className={iconButton}
          >
            <CheckIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setTitle(item.title);
              setMode("view");
              onError(null);
            }}
            aria-label="Cancel rename"
            className={iconButton}
          >
            <CloseIcon className="size-4" />
          </button>
        </form>
      </li>
    );
  }

  if (mode === "confirm") {
    return (
      <li className="rounded-md border border-border-strong p-2 text-sm">
        <p>
          Delete &ldquo;{item.title}&rdquo; and all its messages?
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteConversation(item.id);
                if (result.ok) {
                  onDeleted();
                } else {
                  onError(result.error);
                  setMode("view");
                }
              })
            }
            className="h-11 rounded-md bg-danger px-3 text-on-accent"
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setMode("view")}
            className="h-11 rounded-md border border-border-strong px-3"
          >
            Keep
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`group flex items-center rounded-md ${active ? "bg-surface-raised" : "hover:bg-surface-raised"}`}
    >
      <Link
        href={`/chat?id=${item.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-11 min-w-0 flex-1 items-center truncate px-3 text-sm ${active ? "text-accent-cyan" : "text-text-primary"}`}
      >
        <span className="truncate">{item.title}</span>
      </Link>
      <button
        type="button"
        onClick={() => setMode("rename")}
        aria-label={`Rename ${item.title}`}
        className={iconButton}
      >
        <PencilIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => setMode("confirm")}
        aria-label={`Delete ${item.title}`}
        className={iconButton}
      >
        <TrashIcon className="size-4" />
      </button>
    </li>
  );
}
