# PRD.md

**Project:** FLASH (private, single-user personal AI assistant)
**Status:** Final candidate for approval. Supersedes all earlier PRD drafts.
**Companion documents:** TECH_STACK.md, ARCHITECTURE.md, DATABASE.md, DESIGN.md, TASKS.md. If any document conflicts with ARCHITECTURE.md on behaviour, ARCHITECTURE.md wins and the conflict is reported.
**Labels:** [DECIDED] settled. [PROPOSED] recommended, change only with a stated reason. [OPEN] unverified, check before relying on it.

---

## 1. Overview

FLASH is a private web application: a personal AI assistant with a dark, futuristic dashboard. It converses by text and voice, keeps only memories I explicitly approve, manages tasks and notes, and uses a small set of registered tools. **It asks for my explicit approval before any action that changes data, and it never claims an action succeeded unless the database confirms it.**

The goal is a reliable, demonstrable application that I understand end to end, not an impressive-looking but fragile prototype.

## 2. Goals and Non-Goals

**Goals**
- A working, deployed web app with a repeatable live demo.
- A real approval system enforced on the server, with tests that prove it.
- A codebase I can explain: architecture, data model, and security boundaries.
- Free-tier services only.

**Non-goals for v1** [DECIDED]
- Shell access, arbitrary code execution, unrestricted filesystem or computer control.
- Autonomous actions without approval; purchases or financial transactions.
- Always-on microphone.
- Email and calendar integration.
- A local companion ("computer operator") app. This is a future ambition only.
- Multiple users, public signups, or public access.
- Training models, vector databases, Redis, microservices, agent frameworks.

## 3. Core Principles [DECIDED]

1. **Zero-trust AI.** Model output is untrusted. The model can request actions; it can never approve or perform them.
2. **Server-enforced approval.** State-changing actions need explicit approval, enforced on the server and in the database. Hidden UI is not security.
3. **Honest execution.** Outcomes shown to me and reported by the model come from the database, never from assumption.
4. **Untrusted content.** Text from documents and the web is data, not instructions.
5. **Fail closed.** If a check cannot complete (rate limit, ownership, approval), the action does not happen.
6. **Function before spectacle.** The interface can be ambitious, but nothing in it may imply activity that is not real.

## 4. User

One user: me. Private login, public signups disabled. Every row still carries a `user_id` and ownership is enforced at the database level.

## 5. Feature Specifications

### 5.1 Dashboard
Dark interface with restrained cyan accents (see DESIGN.md). Responsive for desktop and mobile. Sections: Overview, Chat, Tasks and Notes, Memory, Activity, Settings (Documents arrives with M5). Every screen has loading, empty, error, and success states. Every number or status shown is real (DESIGN.md Section 9).

### 5.2 Conversation
Send and receive text; stream responses; persist history; create, rename, and delete conversations; retry failed requests; show tool activity visually separate from ordinary assistant messages. Conversation history is server-authoritative: the browser sends only the new message and a conversation ID.

### 5.3 Memory
- Memories are saved only through an approval-gated `save_memory` tool, or directly by me on the Memory screen.
- Approved memories are retrieved into future conversations. Start by injecting all of them as delimited user data; add Postgres full-text search only if the list grows large. No vector database.
- I can view, edit, and delete memories, and switch memory off globally. When off, no memory is injected.
- Conversations are never automatically saved as memory.

### 5.4 Tasks and Notes
Create, edit, complete, and delete tasks with due dates and statuses. Create, edit, delete, and search notes (full-text search). The assistant manages tasks only through registered tools.

### 5.5 Tool Registry and Approvals
A server-side explicit allowlist. Each tool defines: name, description, input schema, read-only or state-changing, risk level (static metadata, never model-supplied), execution path, permission requirements, and result and error format.

Initial tools: `get_tasks` (read-only), `create_task` (state-changing), `save_memory` (state-changing).

For state-changing tools:
- Show a preview rendered from the stored, validated parameters (not model text).
- Require explicit approval; approvals are bound to the tool, user, conversation, and exact parameters; they expire; they are single-use.
- Only one open approval per conversation.
- Execute from the stored snapshot only; the browser sends only the approval ID.
- Report the real result; handle failure honestly, with limited retries.
- Log what actually happened.

### 5.6 Activity Log
Records: proposed action, tool, validated parameters, approval status, execution status, timestamp, result or error. Approval records decide whether an action may run; action logs record what actually happened. Never log secrets or unnecessary sensitive data.

### 5.7 Voice (M4)
Voice input, spoken replies, and an orb visualizer, behind a swappable speech provider interface. The voice persona is British (`en-GB`), calm, dry, and formal. It must not imitate or clone any real person. Microphone access starts only on my action.

### 5.8 Documents (M5)
PDF only. Validate type and size. Extract text server-side with page references. Answer from the document with evidence-linked citations. Say clearly when the document does not support an answer. Document contents are untrusted input.

### 5.9 Web Research (M6)
Configured free search provider. Show source links. Separate source evidence from model interpretation. Handle failed searches and pages. Never claim a search happened when none ran.

### 5.10 Settings and Security
Server-side keys and validation; ownership checks; rate limits; protected uploads; no stack traces or secrets in client errors; memory and tool controls; tests for permission boundaries.

## 6. Configuration Values

| Setting | Value | Status |
|---|---|---|
| Approval lifetime | 5 minutes, configurable (tests use seconds) | [PROPOSED] |
| Daily model-call cap | 20 calls per day (Gemini free tier allows 20 requests per day); counts model calls, not chat messages | [DECIDED] M1-0 |
| Day boundary for the cap | `Asia/Kolkata` midnight | [PROPOSED] |
| Maximum model calls per request | 3 | [PROPOSED] |
| Maximum execution retries per approval | 3 | [PROPOSED] |
| Gemini model and real free-tier limits | `gemini-3.8-flash`; RPM 5, TPM about 250,000, RPD 20 (requests per day) | [DECIDED] M1-0 |
| Privacy of free-tier prompts | Free tier; non-sensitive memories only; warning on the Memory screen (Section 9) | [DECIDED] M3-0 |

## 7. Milestones and Acceptance Criteria

Development is gated: a milestone is complete only when its acceptance criteria are met with evidence, tests pass, documents are updated, and a Git tag is created. Task-level detail lives in TASKS.md.

### M0 Foundation
**Scope:** repository, Next.js and TypeScript scaffold, linting, environment conventions, secret protection, Supabase project and CLI, Vercel deployment, design tokens and fonts.
**Acceptance:** lint, type check, and build pass; hello-world deployed on Vercel; secrets cannot be committed (hook tested); DESIGN tokens applied; tag `v0.0.1`.

### M1 Auth and Chat
**Scope:** single-user auth, session refresh and CSP (report-only), rate-limit tables and functions, health route, Gemini streaming behind the Model Gate, dashboard shell, chat UI.
**Acceptance:**
- Unauthenticated users are blocked; signups are verifiably disabled.
- The limiter counts model calls, fails closed at the cap, never exceeds it under parallel requests, and refunds only when the server aborts before dispatch.
- Chat streams; the API key and service-role key never reach the client.
- Loading, empty, error, retry, and cap-reached states display correctly.
- Tag `v0.1.0`.

### M2 Persistence
**Scope:** conversations, messages, tasks, notes, server-authoritative history, conversation and task screens, Overview with real data.
**Acceptance:**
- A second account cannot read or modify the first account's rows; `user_id` is attached to all rows; signups remain disabled.
- The client cannot forge assistant, system, or tool messages.
- Conversations, messages, and tasks survive a hard refresh.
- Tag `v0.2.0`.

### M3 Memory and Tools (the v0.1 demo)
**Scope:** memory, tool registry, approval flow, activity log, approval and resume routes, all approval functions with tests.
**Acceptance, demo:** I ask FLASH to create a task; it shows the exact action; I approve; the task is created; it appears in the dashboard; the activity log shows the real result; it survives a refresh; I ask FLASH to retrieve it and it uses the read-only tool.
**Acceptance, negative tests (each must fail safely and be logged):**
1. Rejected approval.
2. Altered parameters: stored parameters changed outside the app give `hash_mismatch`, and the app offers no way for the client to supply parameters.
3. Expired approval, using a short configurable expiry.
4. Replayed approval.
5. Duplicate execution: parallel requests on one approval; exactly one succeeds.
6. Retry exhaustion: the third failure marks the approval failed and is reported honestly.
7. A second proposal while one is open is discarded.
8. Memory: an unapproved memory is never saved; the memory off switch stops injection.
**Acceptance, security tests:** invalid tool arguments; database failures; API failures and rate limits; unauthorised access; injected text cannot trigger an unapproved action.
**Also before the gate:** CSP switched from report-only to enforced after reviewing violations; a security review pass. Tag `v0.3.0`.

### M4 Voice
**Acceptance:** speech input works; spoken replies use a British voice if the device has one, with a graceful fallback; the orb shows idle, listening, thinking, speaking, and error states; microphone starts only on my action; reduced-motion respected. Tag `v0.4.0`.

### M5 Documents
**Acceptance:** PDFs upload securely (size and type validated; storage protected by ownership); text extracted server-side with page references; answers carry citations that point to real pages; unsupported questions are declined explicitly; a hostile PDF cannot cause an unapproved action. Tag `v0.5.0`.

### M6 Web Research
**Acceptance:** a real search runs and sources are shown; model interpretation is visibly separate from source evidence; failures are reported honestly; a hostile page cannot cause an unapproved action; a search quota protects the free tier. Tag `v0.6.0`.

## 8. User Stories (M0 to M3)

1. As the owner, I deploy a blank, secure dashboard so I have a foundation. (M0)
2. As the owner, I log in so that only I can use the assistant and its data. (M1)
3. As the owner, I chat with FLASH and receive streamed answers, with my daily model calls capped by the database. (M1)
4. As the owner, I see my past conversations and resume them after a refresh. (M2)
5. As the owner, I must approve FLASH's request to create a task before anything is saved. (M3)
6. As the owner, I can ask FLASH to remember a preference, approve it, and later view, edit, or delete it. (M3)
7. As the owner, I can audit exactly what FLASH did and whether it succeeded, failed, or was never executed. (M3)

## 9. Risks and Open Items

- [DECIDED, M3-0, owner 2026-11-07] **Privacy:** stay on the free Gemini tier. Only non-sensitive facts go into memories and chats; the Memory screen shows a permanent warning. Google's data-logging page (updated 2026-10-26) says not to include personal, sensitive or confidential information. Revisit (paid tier or another provider) if FLASH ever needs sensitive data.
- [x] Gemini model `gemini-3.8-flash` and free-tier limits (M1-0).
- [x] Supabase JWT lifetime: default 3600 seconds (M1-0). Resolved: Next.js interception file `proxy.ts` (M0-0); Postgres 17.11 on dev (M2-0).
- **Free-tier pausing:** Supabase pauses free projects after about a week of low activity. Use the app regularly or resume from the dashboard.
- **Residual risk:** approvals protect against the model and injected content, not against a stolen session (ARCHITECTURE.md Section 3).
- **Scope risk:** nine features are ambitious for irregular part-time hours. Milestone gates, not dates, set the pace; cut scope before cutting security.

## 10. Definition of Done (project level)

A deployed app that I can demonstrate; every milestone gate evidenced; all security tests passing; documents matching the code; a README with setup, known limitations, and the secret-rotation rule; and my ability to explain the architecture without notes.

