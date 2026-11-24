// Ring gauge in the mockup's style (DESIGN.md 5.7): a glowing arc with the
// value in the middle and the label underneath. Values are passed in; the
// gauge never invents one. The ring is decorative; the numbers are text.
const R = 34;
const C = 2 * Math.PI * R;

export function RingGauge({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 1;
  const full = value >= max;
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1.5">
      <div className="relative size-[88px]">
        <svg viewBox="0 0 80 80" aria-hidden="true" className="size-[88px] -rotate-90 overflow-visible">
          <circle cx="40" cy="40" r={R} fill="none" strokeWidth="5" className="stroke-border" />
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - ratio)}
            className={`${full ? "stroke-warning" : "stroke-accent-cyan"} drop-shadow-[0_0_5px_rgb(0_229_255/0.7)]`}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-display text-2xl font-semibold">
          {value}
        </span>
      </div>
      <figcaption className="text-center leading-tight">
        <span className="block font-display text-base font-semibold tracking-[0.04em] whitespace-nowrap text-text-primary uppercase">
          {label}
        </span>
        <span className="text-sm text-text-secondary">
          {value} of {max}
        </span>
      </figcaption>
    </figure>
  );
}

/** The gauge's honest failure state: the label stays, the number says Unavailable. */
export function RingGaugeUnavailable({ label }: { label: string }) {
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1.5">
      <div aria-hidden="true" className="size-[88px] rounded-full border-[5px] border-dashed border-border" />
      <figcaption className="text-center leading-tight">
        <span className="block font-display text-base font-semibold tracking-[0.06em] text-text-primary uppercase">
          {label}
        </span>
        <span className="text-sm text-warning">Unavailable</span>
      </figcaption>
    </figure>
  );
}
