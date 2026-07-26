# RUNNING.md — bringing Njia up, testing it, demoing it

The operational runbook. README.md is the pitch; this is the checklist you
follow on a machine, plus every gotcha we hit while testing on the live
portal (2026-07-26). Three moving parts:

| Piece                | Where                    | Port                          |
| -------------------- | ------------------------ | ----------------------------- |
| Claude proxy         | `proxy/` (this repo)     | `8787` (hardcoded both sides) |
| Portal being guided  | live eCitizen, or the mock-portal repo served locally | any (`http://localhost/*` matches all ports) |
| Chrome extension     | `extension/` (this repo) | — (load unpacked)             |

## Prerequisites

- Chrome 114+ (side panel API)
- Node 18+
- Python 3 — **required by the proxy at runtime**, not just tooling: every
  `/ask` shells out to `proxy/grounding.py` → `retrieve.py` (BM25 over
  `data/index/chunks.json`)
- An Anthropic API key

## First-time setup

```bash
pip install -r requirements.txt      # rank_bm25 etc. — proxy dies without it
cd proxy
npm install
cp .env.example .env                 # then edit .env:
```

In `proxy/.env`:

- `ANTHROPIC_API_KEY=` your key
- **Windows:** `PYTHON_BIN=python` — the default `python3` resolves to the
  Microsoft Store stub and every `/ask` returns 502 until you change it.
  Optionally `PYTHONIOENCODING=utf-8` (stops em-dash mangling in the
  grounding block on Windows).

## Start the stack

**1. Proxy** — from `proxy/`:

```bash
node server.js
```

Watch for BOTH startup lines. If the second says WARNING, stop and fix —
nothing downstream will work:

```
Njia proxy on http://localhost:8787  model=claude-sonnet-5
knowledge retrieval OK (grounding.py)
```

**2. Portal** — pick one:

- **Development / verification:** the live portal. Log in yourself at
  dis.ecitizen.go.ke and open the passport application. Njia activates on
  the form / payment / appointment pages and stays inert on login pages.
  **Never click "Proceed to Pay" during dev testing** — walk up to it, not
  through it.
- **Demo:** clone the mock portal (separate repo, Blessed's) and serve it:
  `python -m http.server 5500` (Windows: `python`, not `python3`).

**3. Extension:** `chrome://extensions` → Developer mode → Load unpacked →
select `extension/`. Pin the icon; clicking it opens the side panel (that
click IS the MV3 user gesture — there is no other way to open it).

## After any code change — the reload ritual

Chrome keeps running what it loaded. Every time `extension/` changes:

1. **Reload** on the Njia card in `chrome://extensions`
2. **Refresh the portal tab** — an extension reload orphans the content
   script already in the tab; only a refresh injects a live one
3. Side panel open? Close and reopen it. Then **Clear chat** if you want
   proactive explanations to re-fire (they run once per step per browser
   session)

Skipping step 2 is what "Extension context invalidated" errors look like.

## Smoke tests (no browser needed)

```bash
curl http://localhost:8787/health
# → {"ok":true,"model":"claude-sonnet-5"}

curl -s -X POST http://localhost:8787/ask -H 'content-type: application/json' \
  -d '{"pageId":"payment","pageContext":"","question":"how much will this cost and how do I pay?"}'
# → answer quoting KES 7,550 with a verification date + the two-invoices reminder

python retrieve.py "which centre should I book from Thika?"   # retrieval only, no API key needed
```

## Test suites

```bash
cd tests
npm install     # first time only (jsdom)
npm test        # content-script suite + side-panel integration suite
```

These run the REAL `extension/` files inside jsdom: detection per page,
wizard step tracking (live-portal markup replicas included), SPA step
swaps, the four security rules, orphan handling, and the full 8-step walk
(8 proactive messages + Q&A, no duplicates on revisit). Run them before
committing anything that touches `extension/`.

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| Every `/ask` returns 502 "knowledge retrieval failed" | `PYTHON_BIN` wrong (Windows: set `python`) or `pip install -r requirements.txt` missing. Proxy startup warning names it. |
| Panel: "can't reach the Njia proxy on localhost:8787" | Proxy not running — `cd proxy && node server.js` |
| "Extension context invalidated" in chrome://extensions | Stale orphaned script from before a reload. Reload card → refresh tab → Clear all errors. Won't recur (the script now detects orphaning and goes quiet). |
| Chip says "Application form" but no step number | The wizard counter wasn't parsed. Copy the step indicator's outerHTML (right-click → Inspect) and file it — the parser has fallbacks for `Step N / M`, `Step N of M`, split spans, pill-index, and `?step=N`, so a miss means new markup. |
| No proactive explanation on a step you've visited before | By design: once per step per browser session. **Clear chat** resets. |
| Privacy audit flags a "leak" for a dropdown/radio value | Shouldn't happen anymore (only typed fields are audited). If it does, check whether the flagged text is a predefined option caption, not something typed. |
| Proxy answers are slow (~5s) | Normal: each `/ask` spawns a Python process for retrieval (~0.5–1s) + model time. Panel aborts at 30s, proxy at 25s. |

## Demo-night checklist

- [ ] Proxy running, both startup lines green, terminal visible (its logs
      are part of the security story: `POST /ask pageId=form 200 1234ms` —
      never question text)
- [ ] Mock portal cloned + served; extension loaded; badge ● shows on each page
- [ ] **Clear chat immediately before the run** — rehearsals burn the
      once-per-session explanation keys
- [ ] The three questions rehearsed: cost + payment / centre from Thika /
      what to bring
- [ ] Security segment: type into a field → 🔒 Privacy audit → "0 of their
      values appear" → Network tab on the side panel showing the `/ask`
      payload is `{pageId, pageContext, question, history}` only
- [ ] Screen-recorded backup of the whole flow, in case the venue network dies
