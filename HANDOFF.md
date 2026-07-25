# HANDOFF.md — Njia build night

Kickoff handoff for Impact Lab: AI Mashinani (Huduma track). Pairs with `CLAUDE.md`, which holds the architecture, the non-negotiable rules, and the verified knowledge pack. This file is the plan: where we are, the sequence, who owns what, and the first moves.

## Status

**Starting from zero at kickoff.** No code yet. Plan and scope are locked (see `CLAUDE.md`). Icons are already generated (`extension/icons/njia-icon-*.png`).

## The plan in one line

A Manifest V3 Chrome extension that detects one of three eCitizen passport pages, opens a side-panel chat, and answers the applicant's questions grounded in a verified knowledge pack — demoed against a local mock of those three pages.

## Team & workstreams

Three streams, one owner each. Swap to actual strengths, but keep one owner per stream.

- **Adiel — knowledge pack.** Own `proxy/knowledge/passport.js` (verify every fact against the live DIS portal tonight, version-stamp it) and the system-prompt answer rules — what the model should know and how it should answer. Lighter component load, so also the **live fact-checker** during the demo.
- **Blessed — extension + side panel.** Own `manifest.json`, `service-worker.js`, `content.js` (page detection + DOM read + **redaction implementation**), and `sidepanel.*`. Scaffold the MV3 skeleton fast — heaviest Claude Code leverage here.
- **Kinyanjui — mock portal + proxy + Claude integration.** Own `mock-portal/*.html` (the three demo pages), `proxy/server.js` (the `/ask` handler, injecting Adiel's knowledge pack into the system prompt, CORS for the extension), and — as the concept's author — the three-minute **demo narrative + Data Protection Act framing**. The proxy is the integration hub between Adiel's pack and Blessed's extension.

**Security-by-design boundary is co-owned.** It spans Blessed's `content.js` (redaction — input values never leave the browser) and Kinyanjui's `proxy` (no logging of user content). Blessed implements the redaction; Kinyanjui defines what counts as sensitive for the pitch and **verifies on the network tab** during the demo that no input values leave. Agree the redaction rule early.

### Interfaces between streams (agree these early so we can work in parallel)

- **extension → proxy** contract: `{ pageId: 'form'|'payment'|'appointment', pageContext: string, question: string, history: [] }`. Seam between **Blessed** (extension / content / side panel) and **Kinyanjui** (proxy).
- **proxy → side panel** response: `{ answer: string }`.
- **knowledge pack:** Adiel authors `passport.js`; Kinyanjui's proxy consumes it (injects into the system prompt). Seam between **Adiel** and **Kinyanjui**.
- **pageId detection:** Blessed produces it in `content.js`; Kinyanjui's proxy tailors the proactive explanation per `pageId`. Lock the three ids now: `form`, `payment`, `appointment`.

## Build sequence (time-boxed, ~10 hours of build)

**Hour 1 — de-risk the hard parts first.** Do NOT start with the interesting features.

- Blessed: stand up the extension skeleton — `manifest.json` + `service-worker.js` with `setPanelBehavior({ openPanelOnActionClick: true })` + an empty `sidepanel.html`. Confirm the toolbar icon opens the panel on a `localhost` page. This proves the two biggest MV3 gotchas are handled (user-gesture + panel wiring) before anything depends on them.
- Kinyanjui: stand up `proxy/server.js` that returns a reply from a real Anthropic API call. Confirm the key works and latency is acceptable. Pick and pin the model.
- Adiel: draft `passport.js` from `CLAUDE.md`'s knowledge pack and start live-verifying facts against dis.ecitizen.go.ke.

**Hours 2–4 — the spine.**

- Blessed: `content.js` reads + redacts DOM and detects `pageId`; wire the side panel to send a question and render an answer.
- Kinyanjui: `/ask` prepends the knowledge pack; build the first mock page (`form.html`) with realistic labels/structure so `content.js` has something to read.
- Adiel: finalise verified facts; write the system-prompt answer rules; hand the redaction policy (what counts as sensitive) to Blessed.

**Hours 5–7 — make it real across three pages.**

- Kinyanjui: build `payment.html` and `appointment.html` mocks; the proxy tailors the proactive explanation per `pageId`.
- Blessed: `content.js` detects all three; the side panel shows a **proactive explanation** per page on load, then supports free-form Q&A; history persists to `chrome.storage.local`.
- Adiel: fact-check across all three page contexts; draft the three demo questions.

**Hours 8–9 — polish + demo hardening.**

- Blessed: tidy the panel UI (readable, on-brand — ink/terracotta).
- Kinyanjui: rehearse the three-minute script; screen-record a backup in case live fails; verify on the network tab that no input values leave the browser (the security demo).
- Adiel: make the three demo questions bulletproof against the knowledge pack; be ready as the live fact-checker.

**By 3:15 AM — submit.** Working demo against the mock, hits the Definition of Done in `CLAUDE.md`.

## First hour is the whole game

The two things that most commonly sink an MV3 build are the side-panel user-gesture requirement and the sleeping service worker. Both are solved patterns (see `CLAUDE.md` → MV3 gotchas). Prove them in hour 1 so nothing built later trips over them.

## Confirm at kickoff (before committing to the above)

- **The actual track problem statement.** We know the question — "what does it take to finish one eCitizen service, end to end?" — but the precise framing is announced at kickoff. If it emphasises a different angle (e.g. _tracking_ a pending application), the architecture is service-agnostic: swap the knowledge pack and the `pageId` targets, keep everything else. Budget one hour to re-scope, not a restart.
- **Fees/documents are current.** Re-verify against the live DIS portal tonight and version-stamp the pack. Never quote KES 4,550.
- **Which Claude model** the credits favour for latency — pin it in `.env`.

## Demo target — what must work live (3 minutes)

1. **0:30** — the problem, via the fee-confusion finding ("the internet can't agree what a passport costs — here are three current sources with three answers").
2. **1:30** — open the mock application page; panel explains the step. Ask "how much will this cost and how do I pay?" Move to the payment page; panel warns about downloading both invoices. Ask "I live in Thika — which centre should I book?"
3. **0:45** — security architecture: what the extension structurally _cannot_ see (open the network tab, show no input values leave), and the Data Protection Act principles behind it.
4. **0:15** — where it goes next (same architecture generalises to NTSA, business registration).

## Why we demo against a mock

We do **not** log into a real eCitizen account with real personal data on a projector. The mock replicates the three pages' structure and labels with dummy data, so: no one's real ID appears on screen, we can build all night without depending on a live government site, and it's honest to say the extension targets page _structure_ so it runs identically on the real portal (show that briefly logged-out). Build the mock's structure to match the real portal's public pages so the "works on the real thing" claim holds.

## Risks & handling

- **sidePanel/service-worker gotchas eat time** → proven in hour 1.
- **A wrong fact on stage** kills the "verified, not hearsay" premise → the pack is small; verify line-by-line tonight; the system prompt answers only from the pack and says so when unsure.
- **Mock diverges from the real portal** → build it from the portal's public (logged-out) pages; match labels exactly.
- **Team of three vs teams of five** → scope above is sized for three; if a 4th joins, they take a mock page off Kinyanjui or panel polish off Blessed.

## References

- `CLAUDE.md` — architecture, rules, MV3 gotchas, knowledge pack, snippets.
- `Njia-Project-Brief.docx` — the full concept + pitch framing.
- Chrome side panel API, Manifest V3 migration, Anthropic Messages API — confirm current details from official docs on the night.
