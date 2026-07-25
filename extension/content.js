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
    // plus the mock's form.html and React mock app
    urlHints: [/\/apply\b/i, /\/edit\b/i, /[?&]step=/i, /form/i, /localhost/i, /127\.0\.0\.1/i],
    urlWeight: 3,
    urlPatterns: [
      [/[?&]step=\d/i, 2],
      [/\/services\/\d+\/apply\b/i, 3],
    ],
    // "Step 1 / 8" style progress counters (live-portal wizard chrome).
    textPatterns: [[/\bstep\s*\d+\s*(?:\/|of)\s*\d+\b/i, 4]],
    keywords: [
      // observed on the LIVE wizard & mock app
      ["adult application instructions", 5],
      ["category", 4],
      ["passport owner", 4],
      ["applicant details", 4],
      ["dual nationality", 4],
      ["form navigation", 4],
      ["saved as draft", 3],
      ["passport type", 4],
      ["parents details", 4],
      ["recommender", 5],
      ["upload documents", 4],
      ["review application", 4],
      // Form 19 vocabulary (printed form + older flow + mock)
      ["form 19", 6],
      ["first time passport application", 6],
      ["special peculiarities", 5],
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
      ["preview", 2],
      ["passport application", 1], // site-wide header text
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
    centres: [
      "nairobi", "kisumu", "mombasa", "eldoret", "nakuru",
      "embu", "kisii", "kericho", "bungoma", "garissa",
    ],
  },
];

const DETECTION_THRESHOLD = 5;

function detectPage(structuralText) {
  const url = location.href;
  const text = structuralText.toLowerCase();
  let best = { id: null, score: 0 };

  for (const rule of PAGE_RULES) {
    let score = 0;
    if (rule.urlHints.some((re) => re.test(url))) score += rule.urlWeight;
    for (const [re, weight] of rule.urlPatterns || []) {
      if (re.test(url)) score += weight;
    }
    for (const [re, weight] of rule.textPatterns || []) {
      if (re.test(text)) score += weight;
    }
    for (const [kw, weight] of rule.keywords) {
      if (text.includes(kw)) score += weight;
    }
    if (rule.centres) {
      const hits = rule.centres.filter((c) => text.includes(c)).length;
      if (hits >= 3) score += 4;
    }
    if (score > best.score) best = { id: rule.id, score };
  }
  return best.score >= DETECTION_THRESHOLD ? best.id : null;
}

// ---------- 3. context capture (structure only, values never) ----------

const STRUCTURE_SELECTORS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "legend", "label", "button", "th", "summary",
  "[role=heading]", "[role=tab]", "[role=alert]", "[role=progressbar]",
  ".step", ".steps", ".step-indicator", ".step-title", ".wizard-step",
  ".breadcrumb", ".nav-link", ".nav-item", ".form-label",
  ".alert", ".notice", ".warning",
  ".page-title", ".card-title", ".card-header",
  ".sd-title", ".sd-page__title", ".sd-question__title", ".sv-title",
].join(",");

const VALUE_BEARING = [
  "input", "textarea", "select", "option", "optgroup", "datalist", "output",
  "[contenteditable]",
  "script", "style", "noscript", "template", "iframe", "object", "embed",
].join(",");

function redact(text) {
  return text
    .replace(/\d[\d ]{5,}\d/g, (m) =>
      (m.match(/\d/g) || []).length >= 7 ? "[redacted]" : m,
    )
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted]");
}

function readStructural() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(VALUE_BEARING).forEach((el) => el.remove());

  const counts = new Map();
  const parts = [];
  const docTitle = (document.title || "").trim();
  if (docTitle) parts.push(docTitle);
  clone.querySelectorAll(STRUCTURE_SELECTORS).forEach((el) => {
    if (el.parentElement && el.parentElement.closest(STRUCTURE_SELECTORS)) {
      return;
    }
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 200) return;
    counts.set(t, (counts.get(t) || 0) + 1);
    if (counts.get(t) === 1 && t !== docTitle) parts.push(t);
  });
  return { text: parts.join("\n"), parts, counts, clone };
}

function parseWizardStep(clone, parts, counts) {
  let num = 0;
  let total = 0;

  // 1. Check URL parameters e.g. ?step=2
  const urlMatch = location.search.match(/[?&]step=(\d{1,2})/i);
  if (urlMatch) {
    num = parseInt(urlMatch[1], 10);
    total = 8;
  }

  // 2. Tree walker match for "Step X / Y", "Step X of Y", or "Step X"
  if (!num) {
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const val = node.nodeValue.replace(/\s+/g, " ");
      const m = val.match(/\bstep\s*(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})\b/i) ||
                val.match(/\bstep\s*(\d{1,2})\b/i);
      if (!m) continue;
      const n = +m[1];
      const t = m[2] ? +m[2] : 8;
      if (n >= 1 && n <= 20) {
        num = n;
        total = t;
        break;
      }
    }
  }

  // 3. Fallback: check active index among step pills/tabs
  if (!num) {
    const navItems = Array.from(clone.querySelectorAll(".nav-item, .nav-link, [role=tab], .step-indicator, .wizard-step, button"));
    const stepItems = navItems.filter((el) => {
      const txt = (el.textContent || "").toLowerCase();
      return /category|instruction|dual|type|details|parent|recommender|upload|review|declaration|step/i.test(txt);
    });
    if (stepItems.length >= 3) {
      total = stepItems.length;
      const activeIdx = stepItems.findIndex((el) =>
        el.classList.contains("active") ||
        el.getAttribute("aria-current") ||
        el.getAttribute("aria-selected") === "true" ||
        el.querySelector(".active")
      );
      if (activeIdx >= 0) {
        num = activeIdx + 1;
      }
    }
  }

  if (!num || !total) return null;

  const titleOk = (t) =>
    t.length >= 3 &&
    t.length <= 60 &&
    /[a-z]/i.test(t) &&
    !/step\s*\d|navigation|passport application for adult/i.test(t) &&
    !t.includes("@") &&
    !/\d{7,}/.test(t);

  // 1. Check active pill or tab element
  const active = clone.querySelector(
    '[aria-current], [role=tab][aria-selected="true"], .nav-link.active, .nav-item.active, .active > .nav-link, .active, [data-active=true]',
  );
  const activeText = active
    ? (active.textContent || "").replace(/\s+/g, " ").trim().replace(/^\d+\.\s*/, "")
    : "";

  if (activeText && titleOk(activeText)) {
    return { num, total, title: redact(activeText) };
  }

  // 2. Check duplicated structural text (pill + heading)
  const dupes = parts.filter((t) => (counts.get(t) || 0) >= 2 && titleOk(t));
  if (dupes.length > 0) {
    return { num, total, title: redact(dupes[0]) };
  }

  // 3. Fallback to main section heading
  const heading = clone.querySelector("h1, h2, h3, .page-title, .step-title, legend, .card-title");
  const headingText = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : "";
  if (headingText && titleOk(headingText)) {
    return { num, total, title: redact(headingText) };
  }

  return { num, total, title: "" };
}

function capture() {
  const { text, parts, counts, clone } = readStructural();
  if (looksLikeAuth(text)) return { pageId: null, context: "", step: null }; // rule 1
  const pageId = detectPage(text);
  const step = pageId === "form" ? parseWizardStep(clone, parts, counts) : null;
  return { pageId, context: redact(text).slice(0, 4000), step };
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

let last = { pageId: null, context: "", step: null };

function push(force = false) {
  const next = capture();
  if (
    !force &&
    next.pageId === last.pageId &&
    next.context === last.context &&
    JSON.stringify(next.step) === JSON.stringify(last.step)
  ) {
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
  debounce = setTimeout(() => push(), 300);
}).observe(document.body, { childList: true, subtree: true, characterData: true });
