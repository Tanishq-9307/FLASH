// Waveform strip under the greeting (DESIGN.md 6, rule 9.5): bars in the
// mockup's style, but they only move with the real microphone level while
// FLASH is listening. Until M4 there is no microphone, so every bar sits at
// the same low height — a flat line drawn as bars. It never pretends to
// hear what it cannot.
const BARS = 73;
const MID = (BARS - 1) / 2;
const H = 36;
const FLAT = 2;

/** Bell-shaped envelope, tallest in the middle, like the mockup. */
const ENVELOPE = Array.from({ length: BARS }, (_, i) => Math.exp(-(((i - MID) / (MID * 0.42)) ** 2)) * 0.85 + 0.15);

export function WaveStrip() {
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${BARS * 5} ${H}`} className="h-9 w-[365px] max-w-full">
      {Array.from({ length: BARS }, (_, i) => (
        <rect
          key={i}
          x={i * 5 + 1.5}
          y={(H - FLAT) / 2}
          width="2"
          height={FLAT}
          rx="1"
          fill={i % 9 === 4 ? "#00b0ff" : "#00e5ff"}
          fillOpacity={0.35 + 0.55 * ENVELOPE[i]}
        />
      ))}
    </svg>
  );
}
