// TEMPORARY test page for M0-6 (DESIGN.md tokens and fonts).
// Remove before the M1 gate. Shows every token and all three fonts.
const TOKENS = [
  { name: "--background", hex: "#090D16", text: "text-primary" },
  { name: "--surface", hex: "#101624", text: "text-primary" },
  { name: "--surface-raised", hex: "#172033", text: "text-primary" },
  { name: "--border", hex: "#243049", text: "text-primary" },
  { name: "--border-strong", hex: "#5B6C92", text: "text-primary" },
  { name: "--text-primary", hex: "#EAF0FA", text: "text-primary" },
  { name: "--text-secondary", hex: "#A3B0C6", text: "text-primary" },
  { name: "--text-muted", hex: "#8593AD", text: "text-primary" },
  { name: "--accent-cyan", hex: "#2DD4E8", text: "text-primary" },
  { name: "--accent-violet", hex: "#A78BFA", text: "text-primary" },
  { name: "--success", hex: "#34D399", text: "text-primary" },
  { name: "--warning", hex: "#FBBF24", text: "text-primary" },
  { name: "--danger", hex: "#F87171", text: "text-primary" },
  { name: "--info", hex: "#60A5FA", text: "text-primary" },
  { name: "--on-accent", hex: "#04121A", text: "text-primary" },
] as const;

export default function TokensPage() {
  return (
    <main className="p-8">
      <h1 className="font-display text-4xl font-semibold text-accent-cyan">
        FLASH design tokens
      </h1>
      <p className="mt-2 text-text-secondary">
        Body text is Barlow. Titles, labels, the logo and the greeting are
        Rajdhani. Timestamps, tool names and parameters are JetBrains Mono.
      </p>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {TOKENS.map((token) => (
          <div
            key={token.name}
            className="flash-frame p-3"
            style={{ background: token.hex }}
          >
            <p className="font-mono text-xs text-text-primary">{token.name}</p>
            <p className="font-mono text-xs text-text-secondary">
              {token.hex}
            </p>
          </div>
        ))}
      </section>

      <section className="flash-frame mt-8 p-4">
        <p className="panel-title">Panel title — JetBrains Mono 12px</p>
        <p className="mt-2 font-mono text-sm text-info">
          2026-11-23 10:20 · tool: search_web · params: {"{q: 'flash'}"}
        </p>
        <p className="mt-2 text-text-secondary">
          Sample body text in Barlow — the quick brown fox jumps over the
          lazy dog. 0123456789
        </p>
      </section>
    </main>
  );
}
