---
name: milestone-gate
description: Closing a FLASH milestone with evidence — rerun all checks, security review, docs-vs-code check, evidence table in PROGRESS.md, Git tag.
---

# milestone-gate

Use at each `M*-7` gate task in `TASKS.md`. A milestone is complete only when its acceptance criteria are met with evidence (`docs/PRD.md` §7).

## Steps

1. **Rerun everything.** `npm run test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`. All must pass; report the real output. Remove any temporary state-gallery or token test page before the gate.
2. **Security review.** Run the `security-review` skill against the repository. Fix or consciously accept every finding; record decisions in `PROGRESS.md`.
3. **Docs-versus-code check.** Verify the documents match the code: pinned versions in `docs/TECH_STACK.md` §2, function contracts in `docs/DATABASE.md` §5, the approval flow in `docs/ARCHITECTURE.md` §5, tokens and honest-UI rules in `docs/DESIGN.md`. Mismatches are fixed with a separate `docs:` commit noted in `PROGRESS.md`.
4. **Design review.** Run the applicable items of the `docs/DESIGN.md` §10.2 checklist for the milestone: compare screens to the mockup for layout and style and to §2 for content; confirm no fake data is visible; contrast check in dev tools (text ≥ 4.5:1, input borders and focus rings ≥ 3:1); keyboard-only run-through; mobile check (tab bar, 44px targets, no horizontal scroll); reduced-motion check.
5. **Evidence.** Write one row per acceptance criterion in the gate-evidence table in `PROGRESS.md` (criterion, evidence, date). Evidence is a command output, a test result, or a file reference — never "it seems to work".
6. **Deployment step (adapted for this build).** The spec gates deploy to production and verify the live URL. This build has no live deployment: record the live-URL check as **deferred** in the evidence table and do not claim it. Deployment happens later with the owner.
7. **Tag.** Create the milestone tag (for example `v0.0.1` for M0) with `git tag <tag>` and record the tag command in `PROGRESS.md`. Tags are pushed separately when a push path for tags exists; note if the tag is local-only.
8. **Checkpoint.** Set the gate task to `[x]` in `TASKS.md`, append the gate line to `PROGRESS.md`, and commit with the gate task's message.

## Wrap-up addition (W-2)

- Rerun the `security-review` skill.
- Rotate every key used during development (owner step — flag it, do not do it).
- Confirm the repo history contains no secrets.
- Confirm signups are disabled and MFA (if enabled) works.
