# DESIGN.md

**Project:** FLASH (private, single-user personal AI assistant)
**Status:** Final candidate for approval. Supersedes the earlier DESIGN.md draft.
**Visual reference:** `docs/design/overview-mockup.png` (the Overview screen mockup). Save the image at that path in the repository.
**Labels:** [DECIDED] settled. [PROPOSED] recommended, change only with a stated reason. [OPEN] unverified, check before relying on it.

**How the mockup is used:** the image is a reference for **look and layout only**. Its text, numbers, and widgets are illustrative. Where the image and this file disagree about content or behaviour, this file wins (see Section 2). Never copy mockup text, numbers, or fake data into the product.

---

## 1. Visual Direction

**Direction [DECIDED]:** a dark, credible, futuristic interface: deep navy surfaces, cyan emphasis, violet used only inside the orb, framed panels with corner brackets, a large orb as the focal point, and uppercase monospace panel titles. It should feel like a serious engineering tool.

**Adopted from the mockup:**
- Top bar: logo and wordmark, status chip, command bar, clock, account avatar.
- Left icon rail with labels under the icons.
- Panel style: thin border with corner-bracket ticks.
- Central orb with greeting text and a waveform strip below it.
- Overview screen made of panels: usage, tasks, activity, quick actions.
- Cyan-to-violet gradient inside the orb, subtle blueprint grid in the background.

**Rejected from the mockup [DECIDED]:**
- Fake system telemetry (CPU, RAM, network, thermal). A web app cannot read your machine, so showing it would be invented data.
- "Autonomous" and "Automation" labels and running progress bars. v1 has no autonomous actions.
- Invented version strings ("v9.4") and invented dates.
- Quick actions that imply arbitrary power ("Deploy Code", "Database Query").
- Projects, Knowledge Base, and Integrations navigation (not in v1).
- Glow on static elements. Glow is allowed only on the orb and on focus rings.
- Text smaller than 12px and dim labels below the contrast targets in Section 3.

---

## 2. Mockup-to-Product Mapping

| Mockup element | v1 treatment | Real data source | Milestone |
|---|---|---|---|
| Logo + "FLASH" wordmark | Keep. Wordmark is an SVG logo (no extra font). Replace the "A.I. Operating System // v9.4" subtitle with the real app version (for example `v0.1`) or remove it. | `package.json` version | M0 |
| "System status: ONLINE" chip | Keep, but derive it from a real health check: Online (auth and database reachable), Degraded (recent model errors), Offline (check failing), Limit reached (daily cap hit). The health check never calls the model, so it costs no quota. | `/api/health`, `api_usage` | M1 |
| "Ask FLASH anything…" command bar | Keep as a quick-ask field. Submitting opens Chat and sends the message. Hidden on the Chat screen, where the composer is the input. Shortcut `Ctrl+Space` focuses it. | Chat route | M1 |
| Mic button in command bar | Hidden until M4. Then toggles listening. | Speech adapter | M4 |
| Date and time | Keep. Real local time and date from the browser. | Browser clock | M1 |
| Avatar | Account menu: email, sign out. | Supabase session | M1 |
| Left rail (9 items) | v1 items only: Overview, Chat, Tasks & Notes, Memory, Activity, Settings. Documents appears when M5 ships. A Voice control lives on the orb, not as a page. Projects, Knowledge Base, Integrations: not built, not shown. | None | M1 to M3 |
| System Telemetry (CPU/RAM/NET gauges) | Replace with **Usage & Limits**: the same ring-gauge style showing today's model calls against the cap, open approvals (0 or 1), and memory on or off. | `api_usage`, `tool_approvals`, `settings` | M1, M3 |
| Thermal Status | Remove. | None | n/a |
| Projects & Knowledge | Replace with **Recent Notes** (latest notes). Becomes Documents in M5. | `notes` | M2 |
| Central Intelligence orb + floating labels | Keep the orb. Replace the floating labels (Network Sync, Autonomous Search…) with **capability chips** showing the tools actually registered: Tasks, Notes, Memory (and Documents, Research when shipped). Disabled tools appear greyed with their state. | Tool registry | M3 |
| Greeting ("Good evening…") | Keep, time-of-day aware. | Browser clock | M1 |
| Waveform strip | Moves only while the microphone is actually listening. Flat line otherwise. | Microphone input | M4 |
| Tasks & Automation | Replace with **Tasks**: pending and completed with due dates, plus an **Awaiting your approval** card when an approval is open. Remove "Running" progress bars. | `tasks`, `tool_approvals` | M2, M3 |
| Activity Timeline | Keep. Backed by `action_logs`, with the status icons in Section 5.6. | `action_logs` | M3 |
| Quick Actions | Keep four buttons: **New task**, **New note**, **Review approval** (appears only when one is open), **Start voice** (M4). Remove Deploy Code and Database Query. | None | M2 to M4 |

---

## 3. Design Tokens

> **Owner decision 2026-11-24 (decision-gate exception to the frozen docs):** the palette below is SUPERSEDED by the Electric Cyan theme, finalized by the owner after Claude, ChatGPT and Gemini rated the themes (Electric Cyan #1 with Gemini 9.2 and ChatGPT 9.7). Core accent `#00E5FF`, deep `#00B0FF`, backgrounds `#020A14` / `#0A1C2E`, surfaces derived from those, text ice-white `#EAF6FF`; orb cyan family — idle `#00E5FF`, listening `#00B0FF`, thinking `#7DF9FF`, speaking `#00FFC8`. The violet orb accent is gone. Everything else in this section (contrast rules, cyan usage, no pure black, status never colour alone) still governs. Recomputed WCAG ratios (2026-11-24, recorded in PROGRESS.md): text-primary 18.11 / 15.70 / 13.33, text-secondary 10.67 / 9.25 / 7.86, text-muted 6.89 / 5.97 / 5.07, accent-cyan 12.93 / 11.20 / 9.51, accent-deep 8.19 / 7.10 / 6.03, thinking 15.97 / 13.84 / 11.75, speaking 15.28 / 13.24 / 11.25, success 10.34 / 8.97 / 7.61, warning 11.91 / 10.32 / 8.77, danger 7.19 / 6.23 / 5.29, info 7.82 / 6.78 / 5.76 (on background / surface / raised); on-accent on accent-cyan 12.34:1; border-strong 4.36 / 3.78 (≥ 3:1); focus ring 12.93:1. One deviation from the reference port: text-muted is `#759DB8`, not `#6E93AD` — the reference value measures 4.49:1 on surface-raised, just under AA. Applied in `app/globals.css`; enforced by `tests/design-tokens.test.ts`.

[PROPOSED] Colours are defined as HSL variables for Tailwind and shadcn/ui theming. **Contrast ratios below were calculated with the WCAG relative-luminance formula, not estimated.** The earlier draft's `text-muted` (`#676D75`) was claimed at 4.6:1 but measures about 3.7:1 and fails AA; it is replaced.

| Token | Hex | HSL | On background | On surface | On raised |
|---|---|---|---|---|---|
| `--background` | `#090D16` | `222 42% 6%` | n/a | n/a | n/a |
| `--surface` | `#101624` | `222 38% 10%` | n/a | n/a | n/a |
| `--surface-raised` | `#172033` | `221 38% 15%` | n/a | n/a | n/a |
| `--border` (decorative) | `#243049` | `221 34% 21%` | n/a | n/a | n/a |
| `--border-strong` (inputs, focus targets) | `#5B6C92` | `221 23% 46%` | 3.7 | 3.5 | 3.1 |
| `--text-primary` | `#EAF0FA` | `218 62% 95%` | 17.0 | 15.8 | 14.2 |
| `--text-secondary` | `#A3B0C6` | `218 23% 71%` | 8.9 | 8.2 | 7.4 |
| `--text-muted` | `#8593AD` | `219 20% 60%` | 6.3 | 5.8 | 5.3 |
| `--accent-cyan` | `#2DD4E8` | `186 80% 54%` | 10.8 | 10.1 | 9.1 |
| `--accent-violet` (orb only) | `#A78BFA` | `255 92% 76%` | 7.1 | 6.6 | 6.0 |
| `--success` | `#34D399` | `158 64% 52%` | 10.1 | 9.4 | 8.5 |
| `--warning` | `#FBBF24` | `43 96% 56%` | 11.6 | 10.8 | 9.8 |
| `--danger` | `#F87171` | `0 91% 71%` | 7.0 | 6.5 | 5.9 |
| `--info` | `#60A5FA` | `213 94% 68%` | 7.6 | 7.1 | 6.4 |
| `--on-accent` (text on cyan buttons) | `#04121A` | `202 73% 6%` | 10.6 on cyan | n/a | n/a |

Rules:
- All text meets AA (4.5:1) on every surface it appears on. `--border-strong` meets the 3:1 requirement for input boundaries and focus indicators. Decorative `--border` is allowed below 3:1 because it does not carry meaning.
- Cyan is for emphasis, icons, active nav, primary buttons, and focus rings. It is not used for body text.
- Violet appears only inside the orb gradient.
- No pure black.
- Status is never colour alone: every status pairs colour with an icon and a text label.
- [OPEN] Re-run the contrast check in browser dev tools on the built UI, since overlays and opacity change the effective colours.

### 3.1 Frame and background treatments [DECIDED]
> **Owner decision 2026-11-07 (supersedes the "no glow" lines below):** match the mockup's look more closely. Panels get a slight gradient, a cyan-tinted outline, a soft static glow and brighter 14px corner brackets (`.flash-frame`). The background gets a faint static circuit texture and a soft blue glow. The Overview orb is a dense Canvas ring and particle field with labelled leader lines on wide screens; every label links to a real screen. Honest-UI rules (Section 9) are unchanged: no CPU, RAM or network gauges, and the waveform still moves only with the real microphone.
- **Panel frame:** 1px `--border` outline plus four 10px corner-bracket ticks in `--accent-cyan` at 50% opacity. Static. No glow, no animation.
- **Background grid:** a faint static blueprint grid (CSS gradients, about 3% opacity) behind the workspace. Removed on mobile and when the user enables reduced motion or data saving. Never behind text-heavy areas such as message lists.
- **Radius:** 6px for panels and buttons, 4px for inner elements. Fully round only for the orb and avatar.
- **Elevation:** use border and `--surface-raised` steps as the primary cue; shadows barely register on dark backgrounds.

---

## 4. Typography

> **Owner decision 2026-11-07:** condensed sci-fi type from the mockup. Body text is Barlow; titles, labels, the logo and the greeting are Rajdhani (both SIL OFL 1.1, self-hosted through `next/font`). JetBrains Mono stays for timestamps, tool names and parameters.

[DECIDED] Two typefaces, both SIL Open Font License 1.1 (free to use, self-hostable). Self-host through `next/font`. Licences confirmed 2026-11-07 on the official repositories: Inter, github.com/rsms/inter ("licensed under the SIL Open Font License"); JetBrains Mono, github.com/JetBrains/JetBrainsMono ("available under the OFL-1.1 License").

- **Body:** Inter. Fallback `ui-sans-serif, system-ui, -apple-system, sans-serif`.
- **HUD and data:** JetBrains Mono, used for panel titles, labels, timestamps, tool names, and parameters. Fallback `ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Panel titles:** JetBrains Mono, 12px, uppercase, letter-spacing 0.08em, `--text-secondary`.
- **Minimum size:** 12px anywhere. The mockup's tiny labels are not allowed.

Scale [PROPOSED]: xs 12/16, sm 14/20, base 16/24, lg 18/28, xl 20/28, 2xl 24/32 (greeting). Chat text is `base`.

---

## 5. Layout and Components

### 5.1 Screens [DECIDED]
1. **Overview (home):** the mockup layout, adapted per Section 2.
2. **Chat:** conversation list panel (280px, collapsible) plus message area and composer. The orb appears as a compact status indicator in the header, not the large hero.
3. **Tasks & Notes**
4. **Memory:** list with view, edit, delete; global Memory toggle.
5. **Activity:** full timeline with filters.
6. **Settings:** account, usage and limits, memory toggle.
7. **Documents:** M5.
8. **Login.**

### 5.2 Responsive behaviour [DECIDED]
- **1280px and up:** the mockup's three zones: left panels, centre orb, right panels. Icon rail 88px wide with labels under icons. Header 64px.
- **768 to 1279px:** orb full width on top; panels in two columns beneath. Icon rail stays.
- **Below 768px:** single column; orb scaled down at the top; panels stack and may collapse; bottom tab bar with Overview, Chat, Tasks, Activity, More (Memory, Settings). The quick-ask field is not shown (the Chat tab is the input). Header shows logo, status dot, avatar.
- Touch targets are at least 44x44px on touch screens.

### 5.3 Top bar, status chip, command bar
- Status chip states follow Section 2. It shows both an icon and a text label.
- The command bar is a single-line input with `--border-strong` outline, visible label for screen readers, and the `Ctrl+Space` hint hidden on touch devices.

### 5.4 Chat components
- **User message:** right aligned, `--surface-raised` background.
- **Assistant message:** left aligned, transparent background, `--text-primary`.
- **System notices** (for example "Daily limit reached, no model reply"): centred, JetBrains Mono, 12px, `--text-secondary`.
- **Streaming indicator:** a blinking block cursor or three-dot pulse. No heavy animation.
- **Tool-activity card:** left aligned panel, visually distinct from messages: tool name in mono, status icon plus text, summary body. Never blends into conversational text.
- Markdown rendering follows ARCHITECTURE.md Section 8: no raw HTML, no remote images, safe links showing the destination domain.

### 5.5 Approval dialog (critical) [DECIDED]
Opened when a state-changing action needs consent. Focus is trapped inside; `Esc` is not a silent approve and acts as Cancel only after a visible confirmation of what Cancel does.
- **Header:** tool display name and tool identifier (for example `create_task`), plus a risk badge. Risk level is a static property in the tool registry, never supplied by the model.
- **Parameters:** key-value list rendered **only** from the stored `parameters` snapshot read from the database, in JetBrains Mono, rendered as plain text (never as HTML or markdown). Long values truncate with an expand control.
- **Countdown:** computed from the server's `expires_at`, not from the browser clock. It uses `role="timer"` and turns red under 10 seconds.
- **Actions:** Cancel (outline) and Approve (solid cyan with `--on-accent` text).
- **States:** active; executing (buttons disabled, spinner in the Approve button); retryable error (dialog stays open, error text above the buttons, Approve re-enabled, shows attempts used); expired (when the countdown hits zero the UI locks and triggers Resume, then shows "Expired"); final failure; succeeded; rejected.
- The dialog also surfaces on the Overview Tasks panel as "Awaiting your approval" and as a badge on the Activity nav item.

### 5.6 Activity timeline [DECIDED]
Vertical list backed by `action_logs`; each row has an icon, a text status, a timestamp, the tool name, and an expandable parameters view.
- `succeeded`: green check. `failed`: red X plus reason. `not_executed` (rejected, expired, refused claim): grey slash. `unknown`: blue question mark. `pending`: grey spinner.
- **Tamper flag:** rows whose `result_payload` flags tamper get a `--danger` left border, a warning icon, and the text "Possible tamper".

### 5.7 Usage & Limits panel
Ring gauges in the mockup's style for: daily model calls (value over cap), open approvals, memory state. Values come only from the database. If data fails to load, the panel shows "Unavailable", not a zero.

### 5.8 Capability chips and quick actions
Chips show registered tools and whether each is available. Quick actions are the four buttons from Section 2.

---

## 6. Voice Orb [DECIDED]

Large on Overview, compact in the Chat header, decorative (`aria-hidden`) with a separate visible and announced text state ("Listening", "Thinking", "Speaking").

- **States:** idle (dim, still), listening (scale follows real microphone volume via the Web Audio `AnalyserNode`), thinking (slow rotation with a cyan to violet gradient), speaking, error (brief red tint, then idle).
- **Speaking constraint:** browser speech synthesis exposes no audio stream, so the speaking animation is a scripted loop that runs while `speechSynthesis.speaking` is true. Do not present it as a real waveform.
- **Waveform strip:** animates only from real microphone input. Otherwise it is a flat line.
- **Rendering approach [PROPOSED]:**
  - Desktop: a lightweight Canvas 2D ring animation capped at 30fps, paused when the tab is hidden.
  - Mobile: layered CSS gradients with `transform` and `opacity` animation only.
  - No SVG filters, full-screen shaders, or particle systems on mobile. The mockup's dense particle look is not required.
  - Reduced motion: a static orb with opacity changes only.
- Glow is permitted on the orb only.

---

## 7. Motion [PROPOSED]
- Motion informs state and never blocks interaction.
- 150ms for hover and focus changes; 250ms for dialogs and panel changes; easing `cubic-bezier(0.4, 0, 0.2, 1)`.
- Honour `prefers-reduced-motion: reduce`: transitions become instant, the orb becomes static, the background grid is removed.

---

## 8. Accessibility [DECIDED]
- Every interactive element is reachable by keyboard; focus order follows visual order.
- Visible focus: 2px `--accent-cyan` ring with offset on all interactive elements; never removed.
- Streaming chat container uses `aria-live="polite"`. Critical failures (limit reached, final failure) use `aria-live="assertive"`.
- Dialogs trap focus, restore focus on close, and label their title and description.
- Status is conveyed by icon and text, not colour alone.
- Touch targets are at least 44x44px; minimum text size 12px.
- Icon-only buttons have accessible names.

---

## 9. Honest-UI Rules [DECIDED]
1. No fake data: every number, status, and timestamp comes from the database, a real health check, or the browser. If it cannot be loaded, show "Unavailable".
2. No optimistic success. A task appears in a list only after the server returns the committed row.
3. Real outcomes always: when the daily cap blocks a follow-up, show the real outcome from the database plus the system line "Action [outcome]. Daily limit reached, no model reply."
4. Ambiguity is shown as ambiguity: an `unknown` outcome is displayed as unknown.
5. No decorative status: the status chip, gauges, waveform, and capability chips must each be backed by real state. Decoration that implies activity that is not happening is not allowed.
6. Features that do not exist yet are not shown as navigation or buttons.

---

## 10. Build Plan and Checklist

### 10.1 Build plan [PROPOSED]
Build each component against props and verify its states with component tests that use fixtures (normal, empty, loading, error, unavailable). No mock data ships in the product; a temporary state-gallery page is optional and must be removed before each milestone gate.
1. **Tokens and shell (M0 and M1):** CSS variables, fonts, header, icon rail, panel component with corner brackets. Compare screenshots to the mockup for layout and feel.
2. **Overview components (M2):** layout, panel frame, ring gauge, lists, orb placeholder, quick actions as props-driven components, then wire them to real data.
3. **Critical components (M3):** Approval dialog and Activity timeline as props-driven components with a test per state, then wire them to the Server Actions and Route Handlers in ARCHITECTURE.md.
4. **Orb (M4):** desktop canvas first, mobile CSS version second.

### 10.2 End-of-milestone review checklist
- [ ] Compare each screen to the mockup for layout and style, and to Section 2 for content. Confirm no fake data is visible.
- [ ] Contrast check in dev tools on every text and surface combination used; all text at least 4.5:1, input borders and focus rings at least 3:1.
- [ ] Lighthouse accessibility audit on the deployed URL (target 100; report any gap honestly).
- [ ] Keyboard-only run-through, including the Approval dialog focus trap.
- [ ] Mobile check: tab bar, 44px targets, no horizontal scroll, orb without heavy effects.
- [ ] Reduced-motion check: dialog and orb work with animations disabled.
- [ ] Throttled-CPU test on the orb; frame rate stays acceptable on a mid-range phone.
- [ ] Failure states shown on purpose: cap reached, health check failing, approval expired, final failure, unknown outcome.

---

## 11. Open Items
- [OPEN] Logo: create or choose an SVG logo; confirm you have rights to use it. Do not reuse any film branding. Since M1-9 (2026-11-07) the header uses a plain text wordmark placeholder ("FLASH" in JetBrains Mono), so nothing is blocked; replace it when an owned SVG exists.
- [x] Font licence confirmation: done 2026-11-07 (Section 4).
- [OPEN] Final orb implementation, decided and measured in M4.
- [OPEN] Re-verify all contrast values on the built UI.

