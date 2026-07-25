// Njia side panel — chat UI.
// Pulls the current tab's { pageId, context } (captured + redacted by
// content.js), shows a proactive explanation per step, and answers free-form
// questions via the local proxy. Conversation history persists in
// chrome.storage.local because the MV3 service worker sleeps.

"use strict";

const PROXY_URL = "http://localhost:8787/ask";
const HISTORY_KEY = "njia:history";
const MAX_HISTORY_STORED = 40; // UI entries kept locally
const MAX_HISTORY_SENT = 12; // messages sent to the proxy per request

const PAGE_LABELS = {
  form: "Step 1 · Application form",
  payment: "Step 2 · Payment",
  appointment: "Step 3 · Appointment",
};

const SUGGESTIONS = {
  form: [
    "How much will this cost and how do I pay?",
    "What documents do I need?",
    "My ID and birth certificate names differ — what now?",
  ],
  payment: [
    "Why do I have two invoices?",
    "Can I pay with M-Pesa?",
    "How much will this cost and how do I pay?",
  ],
  appointment: [
    "I live in Thika — which centre should I book?",
    "What do I bring to the appointment?",
    "How long until I get my passport?",
  ],
};

const els = {
  chip: document.getElementById("page-chip"),
  status: document.getElementById("status"),
  messages: document.getElementById("messages"),
  suggestions: document.getElementById("suggestions"),
  composer: document.getElementById("composer"),
  question: document.getElementById("question"),
  send: document.getElementById("send"),
  clear: document.getElementById("clear-btn"),
  auditBtn: document.getElementById("audit-btn"),
  audit: document.getElementById("audit"),
  auditClose: document.getElementById("audit-close"),
  auditVerdict: document.getElementById("audit-verdict"),
  auditContext: document.getElementById("audit-context"),
};

let currentTabId = null;
let current = { pageId: null, context: "" };
// history entries: { role: "user"|"assistant", content, hidden? }
// `hidden` = sent to the proxy for continuity but not rendered (the implicit
// "explain this step" behind each proactive explanation).
let history = [];
let busy = false;

// ---------- rendering ----------

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Minimal markdown: **bold** and bullet lists. Everything else is escaped
// text; .msg uses white-space: pre-wrap so newlines survive.
function renderMarkdownLite(text) {
  const bold = escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  let html = "";
  let inList = false;
  for (const line of bold.split("\n")) {
    const m = line.match(/^\s*[-•*]\s+(.*)$/);
    if (m) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${m[1]}</li>`;
    } else {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += line + "\n";
    }
  }
  if (inList) html += "</ul>";
  return html.replace(/\n$/, "");
}

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  if (role === "assistant") div.innerHTML = renderMarkdownLite(text);
  else div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function renderHistory() {
  els.messages.textContent = "";
  for (const m of history) {
    if (!m.hidden) addBubble(m.role, m.content);
  }
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function setStatus(text, retryFn) {
  els.status.textContent = "";
  els.status.hidden = !text;
  if (!text) return;
  els.status.append(text + " ");
  if (retryFn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn";
    b.textContent = "Try again";
    b.addEventListener("click", () => {
      setStatus("");
      retryFn();
    });
    els.status.appendChild(b);
  }
}

function setBusy(b) {
  busy = b;
  els.send.disabled = b;
  els.question.disabled = b;
  if (!b) drainPendingExplain();
}

function updateChip() {
  const label = PAGE_LABELS[current.pageId];
  els.chip.textContent = label || "No step detected";
  els.chip.classList.toggle("chip-off", !label);
}

function renderSuggestions() {
  const list = SUGGESTIONS[current.pageId] || [];
  els.suggestions.textContent = "";
  els.suggestions.hidden = list.length === 0;
  for (const q of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = q;
    btn.addEventListener("click", () => ask(q));
    els.suggestions.appendChild(btn);
  }
}

// ---------- persistence ----------

async function loadHistory() {
  const got = await chrome.storage.local.get(HISTORY_KEY);
  history = Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
}

async function saveHistory() {
  history = history.slice(-MAX_HISTORY_STORED);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

// ---------- context ----------

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function refreshContext() {
  if (currentTabId == null) return;
  // Primary source: what content.js pushed via the service worker.
  const key = "ctx:" + currentTabId;
  const got = await chrome.storage.session.get(key);
  let ctx = got[key];
  if (!ctx) {
    // Fallback: ask the content script directly (rejects if none is injected
    // on this tab — i.e. not an eCitizen / mock page).
    ctx = await chrome.tabs
      .sendMessage(currentTabId, { type: "njia:get-context" })
      .catch(() => null);
  }
  current = ctx && ctx.pageId ? ctx : { pageId: null, context: "" };
  updateChip();
  renderSuggestions();
  if (current.pageId) {
    setStatus("");
    await maybeExplain();
  } else {
    setStatus(
      "Njia works on the eCitizen passport application pages. Open the application form, payment, or appointment page to begin.",
    );
  }
}

// ---------- proxy ----------

// `chatEpoch` increments whenever "Clear chat" wipes state; requests capture
// it at entry and drop their results if it moved — otherwise a response landing
// after a clear would resurrect the cleared turn into history.
let chatEpoch = 0;
let activeController = null;

// `ctx` is snapshotted by the caller at entry so an SPA step-switch mid-flight
// can't pair the wrong pageId with the request.
async function callProxy(question, ctx) {
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: ctx.pageId,
        pageContext: ctx.context,
        question,
        history: history
          .slice(-MAX_HISTORY_SENT)
          .map(({ role, content }) => ({ role, content })),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`proxy responded ${res.status}`);
    const data = await res.json();
    // An empty answer would poison history: the next request would carry a
    // blank assistant turn, which the Messages API rejects.
    if (typeof data.answer !== "string" || !data.answer.trim()) {
      throw new Error("empty proxy response");
    }
    return data.answer;
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }
}

const PROXY_DOWN_MSG =
  "I can't reach the Njia proxy on localhost:8787 — is it running? (cd proxy && node server.js)";

// Turn a failure into a message the user can act on. AbortError = our 30s
// timeout; TypeError = fetch couldn't connect at all; anything else means the
// proxy answered but with something unusable.
function classifyError(e) {
  if (e?.name === "AbortError") {
    return "The proxy took more than 30 seconds to answer — the model call may be slow.";
  }
  if (e instanceof TypeError) return PROXY_DOWN_MSG;
  if (e instanceof SyntaxError) {
    return "The proxy replied with something that isn't JSON — check the proxy logs.";
  }
  return `The proxy returned an error (${e?.message || e}).`;
}

// Proactive explanation: once per step per browser session. The implicit
// question is stored hidden so the proxy sees an alternating user/assistant
// history, but the panel just shows Njia explaining the step.
//
// `explainInFlight` is set synchronously before the first await — without it,
// two context-updated events arriving in a burst (SPA step swaps do this)
// would both pass the storage check and double-fire the explanation.
//
// `pendingExplain` fixes the mirror-image bug: if the user reaches a new step
// while a request is in flight, maybeExplain would bail on `busy` and nothing
// would ever re-invoke it — the step would silently lose its explanation. The
// bail records the debt; setBusy(false) and the outer finally drain it.
let explainInFlight = false;
let pendingExplain = false;

function drainPendingExplain() {
  if (pendingExplain && !busy && !explainInFlight) {
    pendingExplain = false;
    maybeExplain();
  }
}

async function maybeExplain() {
  if (!current.pageId) return;
  if (explainInFlight || busy) {
    pendingExplain = true;
    return;
  }
  explainInFlight = true;
  const snap = current;
  const epoch = chatEpoch;
  try {
    const { explained = {} } = await chrome.storage.session.get("explained");
    if (explained[snap.pageId]) return;
    explained[snap.pageId] = true;
    await chrome.storage.session.set({ explained });

    setBusy(true);
    const typing = showTyping();
    try {
      const answer = await callProxy("", snap); // proxy substitutes its default prompt
      if (epoch !== chatEpoch) return; // cleared mid-flight — drop the result
      history.push(
        {
          role: "user",
          content: "Explain this step for a first-time applicant.",
          hidden: true,
        },
        { role: "assistant", content: answer },
      );
      await saveHistory();
      addBubble("assistant", answer);
    } catch (e) {
      if (epoch !== chatEpoch) return; // deliberate abort via Clear — stay quiet
      // Don't burn the once-per-session flag on a failed call — re-read the
      // map rather than writing back our stale copy, and delete the entry for
      // the page that FAILED (snap), not whatever page is current by now.
      const got = await chrome.storage.session.get("explained");
      const map = got.explained || {};
      delete map[snap.pageId];
      await chrome.storage.session.set({ explained: map });
      setStatus(classifyError(e), () => maybeExplain());
    } finally {
      typing.remove();
      setBusy(false);
    }
  } finally {
    explainInFlight = false;
    drainPendingExplain();
  }
}

async function ask(question) {
  const q = question.trim();
  if (!q || busy) return;
  if (!current.pageId) {
    setStatus(
      "Open one of the eCitizen passport application pages first — Njia answers about the step you're on.",
    );
    return;
  }
  els.question.value = "";
  els.question.style.height = "auto";
  addBubble("user", q);
  await send(q);
}

// Separate from ask() so "Try again" can re-send without duplicating the
// user's bubble (nothing was written to history on the failed attempt).
async function send(q) {
  const snap = current;
  const epoch = chatEpoch;
  setBusy(true);
  const typing = showTyping();
  try {
    const answer = await callProxy(q, snap);
    if (epoch !== chatEpoch) return; // cleared mid-flight — drop the result
    history.push({ role: "user", content: q }, { role: "assistant", content: answer });
    await saveHistory();
    setStatus("");
    addBubble("assistant", answer);
  } catch (e) {
    if (epoch !== chatEpoch) return; // deliberate abort via Clear — stay quiet
    setStatus(classifyError(e), () => send(q));
  } finally {
    typing.remove();
    setBusy(false);
    els.question.focus();
  }
}

// ---------- events ----------

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  ask(els.question.value);
});

els.question.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ask(els.question.value);
  }
});

// grow the textarea with content
els.question.addEventListener("input", () => {
  els.question.style.height = "auto";
  els.question.style.height = els.question.scrollHeight + "px";
});

els.clear.addEventListener("click", async () => {
  chatEpoch++; // any in-flight response now discards itself
  if (activeController) activeController.abort();
  history = [];
  await chrome.storage.local.remove(HISTORY_KEY);
  await chrome.storage.session.remove("explained");
  renderHistory();
  setStatus("");
  await refreshContext(); // re-explains the current step on a fresh slate
});

// Privacy audit — asks content.js what it can see on this page and whether any
// filled-in value survived into the payload. Doubles as the demo's security
// segment: this is the whole request body, live, on the real page.
els.auditBtn.addEventListener("click", async () => {
  els.audit.hidden = false;
  els.auditVerdict.className = "audit-verdict";
  els.auditVerdict.textContent = "Checking…";
  els.auditContext.textContent = "";

  const r =
    currentTabId == null
      ? null
      : await chrome.tabs
          .sendMessage(currentTabId, { type: "njia:audit" })
          .catch(() => null);

  if (!r) {
    els.auditVerdict.className = "audit-verdict audit-pass";
    els.auditVerdict.textContent =
      "Njia is not running on this page at all — it reads nothing here.";
    return;
  }

  const pass = r.leaks.length === 0;
  els.auditVerdict.className = `audit-verdict ${pass ? "audit-pass" : "audit-fail"}`;
  els.auditVerdict.textContent = pass
    ? `✓ ${r.filled} filled field${r.filled === 1 ? "" : "s"} on this page. 0 of their values appear in what Njia sends.`
    : `✗ LEAK: ${r.leaks.length} field value(s) reached the payload — ${r.leaks.join(", ")}`;

  els.auditContext.textContent =
    JSON.stringify({ pageId: r.pageId }, null, 2).replace(/[{}]/g, "").trim() +
    "\n\npageContext:\n" +
    (r.context || "(nothing — Njia reads nothing on this page)");
});

els.auditClose.addEventListener("click", () => {
  els.audit.hidden = true;
  els.auditContext.textContent = ""; // don't leave page text sitting in the DOM
});

// content.js re-read the page (navigation within the flow)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "njia:context-updated" && msg.tabId === currentTabId) {
    refreshContext();
  }
});

// User switched tabs. onActivated fires for EVERY window, but this panel
// belongs to one — without the filter, clicking a tab in a second window
// (speaker notes, slides) would repoint the panel at that window's tab and
// it would never recover, since switching back fires onFocusChanged, not
// onActivated.
let myWindowId = null;

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (myWindowId != null && windowId !== myWindowId) return;
  currentTabId = tabId;
  refreshContext();
});

// Focus returning to our window re-syncs to its active tab.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (myWindowId == null || windowId !== myWindowId) return;
  currentTabId = await getActiveTabId();
  refreshContext();
});

// ---------- init ----------

(async function init() {
  await loadHistory();
  renderHistory();
  try {
    myWindowId = (await chrome.windows.getCurrent()).id;
  } catch (e) {
    myWindowId = null; // fall back to accepting all activations
  }
  currentTabId = await getActiveTabId();
  await refreshContext();
})();
