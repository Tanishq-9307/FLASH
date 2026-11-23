// Header quick-ask bar (M1-10b, DESIGN.md §2/§5.3).
//
// The bar lives in the header; the Chat screen lives on /chat. The text
// travels between them in client state only — never in the URL (a URL would
// put the message in browser history, server logs, and shared links). The
// QuickAskProvider sits in the root layout around both the header and the
// page content; the bar sets the pending text and navigates to /chat, and
// Chat consumes it on mount and sends it through the normal composer path
// (same Model Gate as a typed message).
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";

type QuickAskContextValue = {
  pending: string | null;
  ask: (text: string) => void;
  clear: () => void;
};

const QuickAskContext = createContext<QuickAskContextValue | null>(null);

export function QuickAskProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<string | null>(null);
  const ask = useCallback((text: string) => setPending(text), []);
  const clear = useCallback(() => setPending(null), []);
  const value = useMemo(() => ({ pending, ask, clear }), [pending, ask, clear]);
  return <QuickAskContext.Provider value={value}>{children}</QuickAskContext.Provider>;
}

export function useQuickAsk(): QuickAskContextValue {
  const context = useContext(QuickAskContext);
  if (!context) throw new Error("useQuickAsk must be used inside QuickAskProvider");
  return context;
}

export function QuickAskBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { ask } = useQuickAsk();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.key === " ") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Hidden on the Chat screen: the composer is the input there.
  if (pathname === "/chat") return null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text) return;
    setValue("");
    ask(text);
    router.push("/chat");
  }

  return (
    <form
      onSubmit={submit}
      className="hidden min-w-0 flex-1 items-center gap-2 md:flex"
      role="search"
    >
      <label htmlFor="quick-ask" className="sr-only">
        Ask FLASH anything
      </label>
      <input
        id="quick-ask"
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask FLASH anything…"
        autoComplete="off"
        className="h-11 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted"
      />
      {/* Shortcut hint: hover-capable devices only — touch devices have no
          Ctrl key, so showing it there would be a dead hint. */}
      <kbd className="hidden rounded border border-border bg-surface-raised px-2 py-1 font-mono text-xs text-text-muted [@media(hover:hover)]:block">
        Ctrl+Space
      </kbd>
    </form>
  );
}
