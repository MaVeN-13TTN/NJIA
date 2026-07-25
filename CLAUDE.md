# CLAUDE.md — Njia

Guidance for Claude Code working in this repo. Read this first; read `HANDOFF.md` for the current build plan and task ownership.

## What we're building

**Njia** (Kiswahili: "the way / path" — _Navigating Journeys with In-context AI_) is a Chrome extension that guides a first-time Kenyan passport applicant through the eCitizen application **from inside the page they're on**. It reads the structure of the current page, opens a side-panel chat, proactively explains the step, and answers questions — grounded in a verified knowledge pack, not model memory.

This is a **hackathon build** (Impact Lab: AI Mashinani, Huduma track). Optimise for a working live demo by 3:15 AM, not for production completeness.

## Scope — build exactly this, nothing more

**Ships by 3:15 AM:** the extension detects which of **three checkpoint pages** the user is on, the side panel explains that step, and the user can ask free-form questions answered from the knowledge pack.

The three pages:

1. **Form** — the passport application form (Form 19).
2. **Payment** — the fee / invoice step.
3. **Appointment** — booking the biometric appointment / "what happens next".

**Do NOT build** (out of scope for the night — do not add these even if they seem quick):

- Passport _renewals_ or any service other than first-time application.
- Any other eCitizen service (NTSA, business registration, KRA…).
- Login / authentication handling of any kind. **The user logs in themselves.**
- User accounts, sign-up, persistence of user identity, analytics.
- A production backend, database, or deployment pipeline. A local proxy is enough.

If a task would add anything on the "do NOT build" list, stop and flag it instead of implementing it.

## Architecture

Four thin components. Data flows one way: sanitised page structure + question **out**, guidance **back**.

1. **Chrome extension (Manifest V3)** — content script injected **only** on eCitizen/DIS domains (and `localhost` for the mock). Structurally cannot read any other site.
2. **Side panel (`chrome.sidePanel`)** — the chat UI, native right-hand panel. No overlay injected into the page's own DOM.
3. **DOM context capture (in the content script)** — reads page _structure_ (headings, labels, step indicators, button text, visible notices). **Never reads typed input values, never reads login/credential fields.** Redaction happens client-side before anything leaves the browser.
4. **Claude proxy (`/proxy`)** — a minimal local server that holds the Anthropic API key, prepends the verified knowledge pack as the system prompt, calls the Messages API, and returns the answer. The key never lives in the extension.

### Message flow

1. `content.js` detects the page (`form` | `payment` | `appointment`), extracts + redacts context, and makes it available via `chrome.runtime` messaging.
2. Side panel opens (see the gotcha below), pulls the current page's `{pageId, context}`, and requests a **proactive explanation** for that step from the proxy.
3. User asks a question → side panel sends `{pageId, context, question, history}` to the proxy → renders the answer. `history` is persisted in `chrome.storage.local` (the service worker sleeps — see below).

## Tech stack (deliberately minimal)

- **Extension:** vanilla JS + HTML + CSS. **No framework, no bundler.** This dodges the MV3 CSP/remote-script trap and saves build time. Load unpacked; no build step.
- **Proxy:** Node + a tiny Express server. `fetch` to the Anthropic Messages API.
- **Mock portal:** three static HTML pages that mimic the eCitizen structure and labels. Lives in its **own repo** (Blessed's), cloned and served locally for the demo — this repo holds only the extension, the knowledge/data pipeline, and the proxy.

## Repo structure

```
njia/                      # this repo — extension + knowledge/data + proxy
  extension/
    manifest.json
    service-worker.js      # opens side panel; message routing
    content.js             # page detection + DOM read + redaction
    sidepanel.html
    sidepanel.js           # chat UI + calls to the proxy
    sidepanel.css
    icons/                 # njia-icon-16/32/48/128.png (already generated)
  proxy/
    server.js              # /ask handler; holds the key; injects the grounding block
    grounding.py           # Node→Python bridge to the retriever
    package.json
    .env.example           # ANTHROPIC_API_KEY= , CLAUDE_MODEL= , PYTHON_BIN=
  data/
    raw/                   # verified knowledge sources (markdown, version-stamped)
    index/chunks.json      # committed BM25 chunk index
  scrape.py                # fetch official pages → data/raw/
  build_index.py           # chunk data/raw/ → data/index/chunks.json
  retrieve.py              # BM25 retrieval + grounding_block()
  requirements.txt         # Python deps the proxy needs at runtime (rank_bm25 …)
  README.md
```

The **mock portal** (three static demo pages) is a separate repo maintained by Blessed — clone it alongside this one when preparing the demo.

## Dev / run commands

**Extension:** open `chrome://extensions`, enable _Developer mode_, _Load unpacked_ → select `extension/`. After edits, hit _Reload_ on the card. There is no build step.

**Proxy:**

```bash
cd proxy
cp .env.example .env      # then paste the Claude.ai account's API key
npm install
node server.js            # serves on http://localhost:8787
```

**Portal to test against:**

- **Development:** the live portal. Log in yourself at `dis.ecitizen.go.ke` and open the passport application — the extension activates on the form / payment / appointment pages (never on the login itself).
- **Demo:** the mock portal, from its own repo. Clone it next to this repo and serve it locally:

```bash
git clone <mock-portal-repo-url> njia-mock-portal   # Blessed's repo — URL TBD
cd njia-mock-portal
python -m http.server 5500    # pages at http://localhost:5500/form.html etc.
```

## Non-negotiable rules (security by design — this is our differentiator)

These are product requirements, not nice-to-haves. Every PR must keep all four true:

1. **Domain-locked.** The content script's `matches` and `host_permissions` list only eCitizen/DIS hosts (and `localhost` for the mock). Never widen to `<all_urls>`.
2. **Never read typed input.** Strip `input`, `textarea`, `select`, and any password field from the DOM _before_ extracting text. We read labels and structure, never values.
3. **Never touch the login.** No reading, storing, or autofilling of credentials. The user authenticates themselves; the extension activates on the application pages only.
4. **Store nothing sensitive, log nothing.** Conversation history lives only in `chrome.storage.local` on the user's machine. The proxy keeps no logs of user content. Redact long digit runs (IDs/phones) from context as a backstop.

Frame these in the pitch using Kenya's Data Protection Act, 2019 (Section 25: minimisation, purpose limitation, storage limitation). The code should make them _auditable_ — a reviewer reading `content.js` should be able to see that input values never leave the browser.

## MV3 gotchas — get these right up front

- **`sidePanel.open()` needs a user gesture** and silently no-ops otherwise. Cleanest fix: in the service worker, `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so clicking the toolbar icon opens the panel. Don't call `open()` from arbitrary code.
- **The MV3 service worker sleeps** after ~30s idle. Do **not** keep conversation state in service-worker variables — persist to `chrome.storage.local`.
- **No remote scripts** (MV3 CSP). Everything the extension runs must be bundled locally. This is the main reason we're using vanilla JS with no CDN dependencies.
- **`chrome.sidePanel` needs Chrome 114+** and the `"sidePanel"` permission in the manifest.

## Grounding knowledge pack (verified facts)

The proxy injects these into the system prompt so answers come from verified data, not the model's memory. **Version-stamp it and re-verify against the live DIS portal on build night** — secondary sources disagree, which is the whole reason this tool exists.

- **Flow:** register/log in on eCitizen (dis.ecitizen.go.ke) → Directorate of Immigration Services → New Applications → complete Form 19 + upload documents → pay the fee, receive **two** payment invoices → book an appointment at a processing centre → attend in person for submission + biometrics (photo, fingerprints) → collect once notified.
- **Processing centres (9):** Nairobi (Nyayo House), Kisumu, Mombasa, Eldoret, Nakuru, Embu, Kisii, Kericho, Bungoma. Diaspora → nearest High Commission/Embassy.
- **Documents (first-time adult):** original birth certificate + copy; original national ID + copy; recent passport-size photo to spec (white background, taken within 6 months); printed application form + payment invoices. Minors need extra documents incl. parental consent.
- **Common failure mode to warn about:** name mismatch between national ID and birth certificate causes rejection — resolve before applying.
- **Fee:** standard passport **KES 7,550** (2026). The older **KES 4,550** is outdated and gets applications rejected — never quote it. Larger booklets / special categories cost more.
- **Timelines:** ~10 working days from biometric capture; express (2–3 days) at Nyayo House.
- **Payment:** M-Pesa, Airtel Money, card, or online banking via the eCitizen gateway.

**Answer rules for the system prompt:** answer only from this pack; if it doesn't cover something, say so plainly rather than guessing; be concise and specific; use Kenyan context and plain language; state the verification date when giving fees or requirements; never invent a fee, document, or step.

## Reference snippets (shape, not gospel)

`manifest.json` essentials:

```json
{
  "manifest_version": 3,
  "name": "Njia — eCitizen passport guide",
  "version": "0.1.0",
  "permissions": ["sidePanel", "storage", "activeTab", "scripting"],
  "host_permissions": ["https://dis.ecitizen.go.ke/*", "http://localhost/*"],
  "background": { "service_worker": "service-worker.js" },
  "action": { "default_title": "Njia" },
  "side_panel": { "default_path": "sidepanel.html" },
  "content_scripts": [
    {
      "matches": ["https://dis.ecitizen.go.ke/*", "http://localhost/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "icons": {
    "16": "icons/njia-icon-16.png",
    "48": "icons/njia-icon-48.png",
    "128": "icons/njia-icon-128.png"
  }
}
```

Side-panel-open fix (`service-worker.js`):

```js
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);
```

Redaction (`content.js`, illustrative):

```js
const LONG_DIGITS = /\b\d{7,}\b/g; // ID/phone backstop
function readContext() {
  const clone = document.body.cloneNode(true);
  clone
    .querySelectorAll(
      "input, textarea, select, [type=password], script, style, noscript",
    )
    .forEach((el) => el.remove()); // never read typed values
  const parts = [];
  clone
    .querySelectorAll(
      "h1,h2,h3,legend,label,button,[role=heading],.step,.alert,.notice",
    )
    .forEach((el) => {
      const t = el.innerText?.trim();
      if (t) parts.push(t);
    });
  return parts.join("\n").replace(LONG_DIGITS, "[redacted]").slice(0, 4000);
}
```

Proxy handler (`proxy/server.js`, illustrative):

```js
app.post("/ask", async (req, res) => {
  const { pageId, pageContext, question, history = [] } = req.body;
  const system = buildSystemPrompt(pageId, pageContext); // knowledge pack + page focus + answer rules
  const messages = [
    ...history,
    {
      role: "user",
      content: question || "Explain this step for a first-time applicant.",
    },
  ];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL,
      max_tokens: 700,
      system,
      messages,
    }),
  });
  const data = await r.json();
  res.json({ answer: (data.content || []).map((b) => b.text).join("") });
});
```

> `CLAUDE_MODEL`: confirm the current model id from Anthropic docs (docs.claude.com). The event's API credits work with the standard models — pick a fast one (Sonnet-class) for snappy demo latency.

## Definition of done (for the night)

- Load unpacked works; clicking the Njia icon opens the side panel on a checkpoint page.
- On each of the three checkpoint pages, the panel shows a correct proactive explanation of that step.
- The user can ask at least these and get grounded answers: "how much will this cost and how do I pay?", "which centre should I book from Thika?", "what do I bring to the appointment?"
- No input values or credentials ever leave the browser (verify in the network tab during the demo).
- Verified end to end against the **live eCitizen portal** during development; the demo runs against the locally-served **mock portal** (separate repo).
