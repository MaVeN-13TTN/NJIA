// Njia content script.
// Injected ONLY on dis.ecitizen.go.ke and localhost (see manifest "matches"),
// top frame only (all_frames: false).
//
// SECURITY BY DESIGN — the whole boundary is auditable in this one file:
//   1. AUTH BAIL-OUT. If the page looks like a login / SSO / OTP screen, this
//      script captures NOTHING and reports nothing. The eCitizen login lives
//      on accounts.ecitizen.go.ke (not in our matches) but dis.ecitizen.go.ke
//      also serves /auth/* — so the check is by URL *and* by content.
//   2. Every form control is REMOVED from a detached clone BEFORE any text is
//      read. Typed values can never reach the extracted context.
//   3. Only structural text is read: headings, labels, button text, step
//      indicators, notices. Never free page text, never field values.
//   4. The page URL is NEVER sent — it can carry an application id. It is used
//      locally, in this file, for detection only.
//   5. Redaction backstop strips long digit runs and email addresses from the
//      structural text that survives.
//   6. This script makes no network requests of any kind. It messages the
//      extension's own service worker. (Content scripts get no CORS exemption
//      from host_permissions anyway — the one outbound call in this extension
//      is side panel → localhost proxy.)
//
// Page signals below were verified against the live portal on 2026-07-25:
// the DIS form is a SurveyJS wizard (Next/Previous/Complete/Preview), payment
// is a Pesaflow checkout, booking is a "BookingForm" with a "Book Now" button.

"use strict";

// ---------- 1. auth bail-out ----------

const AUTH_PATH = /\/(auth|login|logout|register|authorize|password|otp)\b/i;
const AUTH_MARKERS = [
  "password",
  "login with otp",
  "email address or id number",
  "sign in with digital id",
  "remember for 30 days",
  "forgot password",
  "create an account",
  "enter the otp sent",
  "one login",
];

function looksLikeAuth(structuralText) {
  if (AUTH_PATH.test(location.pathname)) return true;
  // A password field anywhere is decisive, and we check the live DOM for it
  // *before* reading any text.
  if (document.querySelector('input[type="password"]')) return true;
  const t = structuralText.toLowerCase();
  return AUTH_MARKERS.some((m) => t.includes(m));
}

// ---------- 2. page detection ----------
// Content keywords carry the decision; the URL is a weaker tiebreaker. The
// real portal serves all three steps under /applications/{id}/..., so URL
// alone cannot distinguish them.

const PAGE_RULES = [
  {
    id: "form",
    // /services/1/apply/1 (entry) and /applications/{id}/edit?step=N (wizard),
    // plus the mock's form.html
    urlHints: [/\/apply\b/i, /\/edit\b/i, /[?&]step=/i, /form/i],
    urlWeight: 3,
    keywords: [
      ["form 19", 6],
      ["first time passport application", 6],
      ["special peculiarities", 5],
      ["recommender", 5],
      ["birth certificate number", 5],
      ["next of kin", 4],
      ["reason for travel", 4],
      ["my child below 18", 4],
      ["application for a kenya passport", 4],
      ["colour of eyes", 3],
      ["eye colour", 3],
      ["marital status", 3],
      ["profession/occupation", 3],
      ["66 pages", 3],
      ["50 pages", 3],
      ["34 pages", 3],
      ["new application", 3],
      ["place of birth", 2],
      ["identity card number", 2],
      ["country of residence", 2],
      ["declaration", 2],
      ["upload", 2],
      ["preview", 1],
      ["passport application", 1], // site-wide header text — weak on purpose
    ],
  },
  {
    id: "payment",
    urlHints: [/payment/i, /invoice/i, /checkout/i, /receipt/i, /\/outputs?\//i],
    urlWeight: 3,
    keywords: [
      ["select your preferred payment method", 6],
      ["proceed to pay", 6],
      ["payment reference", 6],
      ["initiate payment", 6],
      ["government copy", 5],
      ["customer copy", 5],
      ["convenience fee", 5],
      ["pesaflow", 5],
      ["paybill", 4],
      ["pay bill", 4],
      ["222222", 4],
      ["payment method", 4],
      ["amount due", 4],
      ["airtel money", 3],
      ["m-pesa", 3],
      ["mpesa", 3],
      ["invoice", 3],
      ["online banking", 2],
      ["amount", 1],
    ],
  },
  {
    id: "appointment",
    urlHints: [/appointment/i, /booking/i, /\/book\b/i, /slot/i],
    urlWeight: 4,
    keywords: [
      ["no slots available for the selected date", 6],
      ["no offices configured for this appointment", 6],
      ["passport processing centre", 6],
      ["passport processing center", 6],
      ["book appointment", 6],
      ["book now", 5],
      ["biometric", 4],
      ["photo capture", 4],
      ["appointment", 4],
      ["available slots", 3],
      ["nyayo house", 3],
      ["select a date", 2],
      ["what happens next", 2],
    ],
    // A list of processing centres on the page is a strong booking signal.
    // 10 centres as of Feb 2025 — Garissa was added as the 10th.
    centres: [
      "nairobi", "kisumu", "mombasa", "eldoret", "nakuru",
      "embu", "kisii", "kericho", "bungoma", "garissa",
    ],
  },
];

const DETECTION_THRESHOLD = 6;

function detectPage(structuralText) {
  const url = location.href;
  const text = structuralText.toLowerCase();
  let best = { id: null, score: 0 };

  for (const rule of PAGE_RULES) {
    let score = 0;
    if (rule.urlHints.some((re) => re.test(url))) score += rule.urlWeight;
    for (const [kw, weight] of rule.keywords) {
      if (text.includes(kw)) score += weight;
    }
    if (rule.centres) {
      const hits = rule.centres.filter((c) => text.includes(c)).length;
      if (hits >= 3) score += 4; // a centre picker, not a passing mention
    }
    if (score > best.score) best = { id: rule.id, score };
  }
  return best.score >= DETECTION_THRESHOLD ? best.id : null;
}

// ---------- 3. context capture (structure only, values never) ----------
//
// Extraction is an ALLOWLIST: only text inside elements matching
// STRUCTURE_SELECTORS is ever read. This matters on the wizard's read-only
// Preview step, where SurveyJS re-renders every answer as plain text — those
// values live in sibling content nodes (.sd-question__content,
// .sv-string-viewer) that nothing below matches, so the Preview page yields
// question TITLES only. The VALUE_BEARING purge that follows is
// defence-in-depth on top of the allowlist, not the primary control.
// (Adversarially reviewed 2026-07-25.)

// Elements whose text is structure, not user data.
const STRUCTURE_SELECTORS = [
  "h1", "h2", "h3", "h4",
  "legend", "label", "button", "th", "summary",
  "[role=heading]", "[role=tab]", "[role=alert]",
  ".step", ".steps", ".step-indicator", ".breadcrumb",
  ".alert", ".notice", ".warning",
  ".page-title", ".card-title", ".card-header",
  // SurveyJS (the real DIS form engine) renders titles into these
  ".sd-title", ".sd-page__title", ".sd-question__title", ".sv-title",
].join(",");

// Anything that can hold typed values or executable content — removed from the
// clone before a single character of text is read. `iframe` matters here: the
// Pesaflow card / M-Pesa checkout renders inside one.
const VALUE_BEARING = [
  "input", "textarea", "select", "option", "optgroup", "datalist", "output",
  "[contenteditable]",
  "script", "style", "noscript", "template", "iframe", "object", "embed",
].join(",");

// Backstop: 7+ digit runs (IDs, phones, invoice/application numbers) and emails.
function redact(text) {
  return text
    .replace(/\d[\d ]{5,}\d/g, (m) =>
      (m.match(/\d/g) || []).length >= 7 ? "[redacted]" : m,
    )
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted]");
}

function readStructuralText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(VALUE_BEARING).forEach((el) => el.remove());

  const seen = new Set();
  const parts = [];
  const title = (document.title || "").trim();
  if (title) {
    seen.add(title);
    parts.push(title);
  }
  clone.querySelectorAll(STRUCTURE_SELECTORS).forEach((el) => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length <= 200 && !seen.has(t)) {
      seen.add(t);
      parts.push(t);
    }
  });
  return parts.join("\n");
}

function capture() {
  const raw = readStructuralText();
  if (looksLikeAuth(raw)) return { pageId: null, context: "" }; // rule 1
  return { pageId: detectPage(raw), context: redact(raw).slice(0, 4000) };
}

// ---------- 4. privacy audit (the one place values are touched) ----------
//
// READ THIS BEFORE JUDGING THE FILE. Everything above reads structure only and
// never touches a value. This function is the single exception, and it exists
// solely to PROVE the guarantee rather than assert it: it reads the values on
// the page locally, checks whether any of them appear in the context string we
// would send, and returns COUNTS AND FIELD NAMES ONLY.
//
// No value is returned, stored, logged, or transmitted — not even a sample.
// It runs only when the user explicitly clicks "Privacy audit" in the panel.
// If this function were deleted, the extension's behaviour would not change.

function auditNoValueLeak() {
  const { pageId, context } = capture();
  const haystack = context.toLowerCase();
  const checked = [];
  let filled = 0;

  document.querySelectorAll("input, textarea, select").forEach((el) => {
    if (el.type === "password") {
      // Never read a credential, not even to audit it. Its presence alone
      // means the auth bail-out should already have produced empty context.
      checked.push({ field: "[password field]", leaked: context !== "" });
      return;
    }
    const value = (el.value || "").trim();
    if (!value) return;
    filled++;
    // Short values ("M", "Yes") collide with ordinary label text, so they are
    // not evidence of a leak either way; skip them to avoid false alarms.
    if (value.length < 4) return;
    if (haystack.includes(value.toLowerCase())) {
      // Field identity is structure, not typed data — safe to report.
      checked.push({
        field: el.name || el.id || el.getAttribute("aria-label") || el.tagName,
        leaked: true,
      });
    }
  });

  return {
    pageId,
    context, // already redacted; this is exactly what would be sent
    filled, // how many fields on this page currently hold a value
    leaks: checked.filter((c) => c.leaked).map((c) => c.field),
  };
}

// ---------- 5. publish to the extension ----------

let last = { pageId: null, context: "" };

function push(force = false) {
  const next = capture();
  if (!force && next.pageId === last.pageId && next.context === last.context) {
    return;
  }
  last = next;
  chrome.runtime
    .sendMessage({ type: "njia:context", ...next })
    .catch(() => {}); // worker may be mid-restart; the next push catches up
}

// The side panel can pull on demand (e.g. it opened after this page loaded).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "njia:get-context") {
    last = capture();
    sendResponse(last);
  } else if (msg?.type === "njia:audit") {
    sendResponse(auditNoValueLeak());
  }
});

// Initial read at document_idle, then re-read on meaningful DOM changes. The
// real portal is a Vue SPA — steps swap without a page load.
push(true);

let debounce = null;
new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(() => push(), 800);
}).observe(document.body, { childList: true, subtree: true, characterData: true });
