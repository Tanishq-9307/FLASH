// DESIGN.md 3.1 (owner decision 2026-11-07, mockup look): the shared
// .flash-frame surface (bright corner brackets, gradient, soft glow) and a
// panel title. Every Overview panel is built on this.
export function Panel({
  title,
  action,
  children,
  className = "",
  tourId,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Tour anchor (DESIGN.md 7): the guided tour highlights this panel by its id. */
  tourId?: string;
}) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section
      aria-labelledby={id}
      data-tour={tourId}
      className={`flash-frame relative rounded-md border border-border bg-surface p-4 ${className}`}
    >
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h2 id={id} className="panel-title">
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** The honest failure state (DESIGN.md Section 9, rule 1): never a zero. */
export function Unavailable({ what }: { what: string }) {
  return (
    <p role="status" className="text-sm text-text-secondary">
      <span className="font-display font-semibold tracking-[0.08em] text-warning uppercase">
        Unavailable
      </span>{" "}
      · {what} could not be loaded.
    </p>
  );
}
