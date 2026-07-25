<div align="center">

# Njia 🧭

**Navigating Journeys with In-context AI**

_Find your way through._ 🇰🇪

![Built with Claude](https://img.shields.io/badge/built%20with-Claude-C15F3C)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-1A1A2E)
![Track: Huduma](https://img.shields.io/badge/track-Huduma-4A5A6A)
![Hackathon](https://img.shields.io/badge/Impact%20Lab-AI%20Mashinani-C15F3C)

</div>

---

## 🌍 The problem

Kenyan government services have moved online — but the **knowledge of how to finish them hasn't**. The passport application is the classic example: it's officially digital end-to-end, yet in practice people assemble it from fragments — a portal that says one thing, an officer at Nyayo House who says another, a cousin who applied last year under different rules, and a cyber café attendant who fills the gaps for a fee. 💸

The result is a service built from **hearsay**: wrong fees paid, applications rejected at the appointment for a missing document, and repeat trips for what's meant to be self-service. During research we couldn't even get current sources to agree on the price of a passport. 🤷🏾‍♂️

## ✨ What Njia does

Njia is a **Chrome extension that guides you through the eCitizen passport application from inside the page you're on**. Instead of a chatbot you have to describe your situation to, Njia sees the _structure_ of the current page and opens a side-panel chat that:

- 🧭 **Proactively explains the step you're on** — "You're on the payment page; here's why there are two invoices."
- 💬 **Answers your questions in plain language** — "How much will this cost?", "Which centre should I book from Thika?", "What do I bring to the appointment?"
- ✅ **Grounds every answer in verified official requirements**, not model memory — so the fee, the documents, and the steps are the _real_ ones, dated and checked.

The magic is **context**: a generic assistant gives a generic seven-step summary; Njia answers the question you actually have, on the page you're actually stuck on.

## 🧩 How it works

Four thin components. Data flows one way — sanitised page _structure_ + your question out, guidance back. 🔁

```
 eCitizen page ──▶ content script ──▶  side panel  ──▶  proxy  ──▶  Claude
 (you're logged   (reads structure,     (chat UI)      (holds key,       │
  in yourself)     redacts, detects                     injects the      │
                   which page)                          knowledge pack)  │
        ▲                                                                │
        └──────────────────────  grounded answer  ◀──────────────────────┘
```

1. 🧱 **Chrome extension (Manifest V3)** — a content script injected **only** on eCitizen pages. It reads page structure (headings, labels, steps) and detects which of three pages you're on.
2. 🪟 **Side panel** — the native right-hand chat, no overlay hacked into the page.
3. 🧠 **Claude proxy** — a tiny server that holds the API key and prepends a **verified knowledge pack** to every request.
4. 📚 **Knowledge pack** — the real passport requirements, fees, centres, and flow — version-stamped and re-verified against the live portal.

## 🎯 Scope

Njia focuses on the **first-time passport application** and three checkpoint pages:

| Page               | What Njia does there                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| 📝 **Form**        | Explains Form 19 and the documents you'll be asked to reference                     |
| 💳 **Payment**     | Explains the fee, how to pay, and _download both invoices before you close the tab_ |
| 📅 **Appointment** | Explains booking your biometric slot and what to bring                              |

## 🔒 Security by design

An extension that "watches you use a government portal" has to earn trust — so the constraints are the headline, framed around **Kenya's Data Protection Act, 2019**. 🛡️

- 🚫 **Domain-locked** — activates only on eCitizen pages, inert everywhere else _(purpose limitation)_.
- 👁️ **Never reads what you type** — input values are stripped before anything leaves the browser _(data minimisation)_.
- 🔑 **Never sees your login** — you authenticate yourself; the extension plays no part.
- 🗑️ **Stores nothing, logs nothing** — chat history lives only on your machine _(storage limitation)_.

The redaction happens in client-side code you can read — the privacy claim is **auditable**, not just asserted. You can watch the network tab during the demo and see that no personal data ever leaves. ✅

## 🛠️ Tech stack

- **Extension:** vanilla JS + HTML + CSS, Manifest V3, `chrome.sidePanel` — no framework, no bundler (keeps it MV3-CSP-safe and fast to build).
- **Proxy:** Node + Express → Anthropic Messages API.
- **Mock portal:** static HTML replicas of the three pages for a safe live demo.

## 🚀 Getting started

**Prerequisites:** Chrome 114+, Node 18+, Python 3 (for the mock portal), and an [Anthropic API key](https://console.anthropic.com).

```bash
git clone https://github.com/MaVeN-13TTN/NJIA && cd NJIA
```

**1. Run the Claude proxy** 🧠

```bash
cd proxy
cp .env.example .env        # paste your Claude.ai account's API key
npm install
node server.js              # http://localhost:8787
```

**2. Serve the mock portal** 🖥️

```bash
cd mock-portal
python3 -m http.server 5500 # pages at http://localhost:5500/form.html
```

**3. Load the extension** 🧩

- Open `chrome://extensions`
- Enable **Developer mode**
- **Load unpacked** → select the `extension/` folder
- Click the **Njia** icon on a mock page to open the side panel ✨

## 📁 Project structure

```
njia/
├── extension/        # 🧩 MV3 extension: manifest, service worker, content script, side panel
│   └── icons/        #    generated icon set (16/32/48/128)
├── proxy/            # 🧠 Claude proxy — holds the key, injects the knowledge pack
│   └── knowledge/    # 📚 the verified passport knowledge pack
├── mock-portal/      # 🖥️ static replicas of the 3 eCitizen pages (demo target)
├── CLAUDE.md         # 🤖 project guide for Claude Code (architecture, rules, facts)
├── HANDOFF.md        # 📋 build-night plan and ownership
└── README.md         # 📖 you are here
```

## 🎬 Demo

The live demo runs against the **local mock portal** — never a real eCitizen account with real personal data on screen. Because Njia targets page _structure_, it runs identically on the real portal. The three-minute story:

1. 🌍 The problem — three current sources, three different passport prices.
2. 🧭 The walkthrough — open a page, Njia explains it; ask a question, get a grounded answer.
3. 🔒 The trust story — what the extension _structurally cannot see_ (shown live in the network tab).
4. 🚀 What's next — the same architecture generalises to NTSA, business registration, and beyond.

## 👥 Team

Built at **Claude Community Nairobi — Impact Lab: AI Mashinani** 🌙 in a single overnight build.

- **Ndung'u Kinyanjui** — mock portal · proxy + Claude integration · pitch — [@handle]
- **Blessed Kagera Kimani** — extension + side panel — [@handle]
- **Adiel Ngugi Maina** — knowledge pack + verification — [@handle]

## 🙏 Acknowledgements

- The **Claude Community** team and mentors for the night. 🌙
- Built with [Claude](https://claude.ai) and Claude Code. 🤖
- _Njia_ — Kiswahili for _the way / path_. 🛤️

## 📄 License

Released under the MIT License — see `LICENSE`.

---

<div align="center">
<sub>Made overnight in Nairobi. ☕ 🇰🇪</sub>
</div>
