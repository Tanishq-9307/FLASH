// Capability chips (M3-24b, DESIGN.md §2/§5.8): the tools actually
// registered, around the orb where the mockup's floating labels were.
// Registered tools only, from the registry — never a fixed list.
// Unavailable tools are greyed with their state, not hidden: hiding
// one would pretend FLASH cannot do something it can, or the reverse.
// A null chips prop means the registry could not be read: "Unavailable".
import { Panel, Unavailable } from "./panel";
import type { CapabilityChip } from "@/lib/tools/registry";

export function CapabilityChips({ chips }: { chips: CapabilityChip[] | null }) {
  return (
    <Panel title="Capabilities" tourId="capabilities">
      {chips === null ? (
        <Unavailable what="Capabilities" />
      ) : (
        <ul className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li
              key={chip.name}
              className={`flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm ${
                chip.available
                  ? "border-accent-cyan/30 bg-surface-raised/80 text-text-primary"
                  : "border-border bg-surface-raised/40 text-text-muted opacity-60"
              }`}
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${chip.available ? "bg-accent-cyan" : "bg-text-muted"}`}
              />
              <span className="font-display font-semibold tracking-[0.04em] uppercase">
                {chip.label}
              </span>
              <span className="text-xs">
                {chip.kind === "read-only" ? "read-only" : "needs approval"} · {chip.state}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
