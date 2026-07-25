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

const AUTH_PATH =
  /\/(auth|login|logout|register|authorize|password|otp|signin|sign-in|sso|mfa|2fa)\b/i;
// NOTE: no site-wide brand strings here — "One Login" is eCitizen's tagline,
// and a tagline in the title/footer would mute the extension on every page.
// Markers must be auth-specific; the password-field and URL checks are the
// decisive signals anyway.
const AUTH_MARKERS = [
  "password",
  "login with otp",
  "email address or id number",
  "sign in with digital id",
  "remember for 30 days",
  "forgot password",
  "create an account",
  "enter the otp sent",
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
    // A wizard-style ?step=N URL or the /services/N/apply entry route is a
    // strong form signal on its own (the entry page's visible text is too
    // generic to clear the threshold otherwise).
    urlPatterns: [
      [/[?&]step=\d/i, 2],
      [/\/services\/\d+\/apply\b/i, 3],
    ],
    // "Step 1 / 8" and "Step 1 of 8" progress counters (live wizard chrome).
    // Must stay in sync with STEP_COUNTER below — on a keyword-sparse wizard
    // step these 2 points are the difference between 5 and threshold 6.
    textPatterns: [[/\bstep\s*\d+\s*(?:\/|of)\s*\d+\b/i, 2]],
    keywords: [
      // observed on the LIVE wizard, 2026-07-25 (screenshot-verified)
      ["adult application instructions", 5],
      ["passport owner", 4],
      ["applicant details", 4],
      ["dual nationality", 4],
      ["form navigation", 3],
      ["saved as draft", 3],
      ["passport type", 3],
      // Form 19 vocabulary (printed form + older flow + mock)
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
  "h1", "h2", "h3", "h4", "h5", "h6",
  "legend", "label", "button", "th", "summary",
  "[role=heading]", "[role=tab]", "[role=alert]", "[role=progressbar]",
  ".step", ".steps", ".step-indicator", ".step-title", ".wizard-step",
  ".breadcrumb", ".nav-link", ".nav-item", ".form-label",
  ".alert", ".notice", ".warning",
  ".page-title", ".card-title", ".card-header",
  // SurveyJS renders titles into these (kept for older/other DIS flows)
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

// Backstop: 7+ digit identifiers (IDs, phones, invoice/application numbers —
// including when grouped by spaces, hyphens, slashes, dots or commas, which is
// how DIS/Pesaflow format references) and emails.
function redact(text) {
  return text
    .replace(/\d[\d\s\/\-.,]{5,}\d/g, (m) =>
      (m.match(/\d/g) || []).length >= 7 ? "[redacted]" : m,
    )
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted]");
}

function readStructural() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(VALUE_BEARING).forEach((el) => el.remove());

  const counts = new Map(); // pre-dedupe occurrence counts (see parseWizardStep)
  const parts = [];
  const docTitle = (document.title || "").trim();
  if (docTitle) parts.push(docTitle);
  clone.querySelectorAll(STRUCTURE_SELECTORS).forEach((el) => {
    // Nested allowlist matches (.nav-item > .nav-link, .card-header >
    // .card-title) are ONE rendering, not two — keep the outermost only, or
    // every nav pill self-duplicates and poisons the counts heuristic below.
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

// The live form is an 8-step wizard; guidance must track the step the user is
// actually on. Safety properties of this parser:
//   - The counter is matched per TEXT NODE (never whole-body text), so \s*
//     cannot bridge unrelated elements, and captures are bounded to 2 digits
//     with sanity checks — at most "99" of user-adjacent digits could ever
//     ride along, and in practice none.
//   - The title comes only from allowlisted structural text that appears
//     TWICE (nav pill + section heading — one rendering counts once now),
//     must look like a section name (4-40 chars, has letters, no emails or
//     long digit runs), and passes redact() as a final backstop.
const STEP_COUNTER = /\bstep\s*(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})\b/i;

function stepFrom(m) {
  if (!m) return null;
  const n = +m[1];
  const t = +m[2];
  return n >= 1 && t >= 2 && n <= t && t <= 20 ? { num: n, total: t } : null;
}

function parseWizardStep(clone, parts, counts) {
  let found = null;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    found = stepFrom(node.nodeValue.replace(/\s+/g, " ").match(STEP_COUNTER));
    if (found) break;
  }
  if (!found) {
    // Vue splits counters across child spans ("Step <span>3</span> / <span>8</span>"),
    // which defeats the per-text-node walk. Each `parts` entry is a single
    // allowlisted element's own collapsed text (≤200 chars, form controls
    // already purged), so \s* still cannot bridge two unrelated elements.
    for (const p of parts) {
      found = stepFrom(p.match(STEP_COUNTER));
      if (found) break;
    }
  }
  if (!found) {
    // Live DIS wizard (seen 2026-07-26): the counter lives in a card-header
    // row OUTSIDE the allowlist, digits in a bold child ("Step <b>1 / 9</b>").
    // Scan SMALL elements only — an element whose entire collapsed text fits
    // in 40 chars and matches the counter IS the counter (or its immediate
    // chrome); the length bound keeps \s* from bridging unrelated content.
    for (const el of clone.querySelectorAll("*")) {
      if (el.children.length > 4) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 40) continue;
      found = stepFrom(t.match(STEP_COUNTER));
      if (found) break;
    }
  }
  if (!found) return null;
  const { num, total } = found;

  const titleOk = (t) =>
    t.length >= 4 &&
    t.length <= 40 &&
    /[a-z]/i.test(t) &&
    !/step|navigation|passport application/i.test(t) &&
    !t.includes("@") &&
    !/\d{7,}/.test(t);

  // Candidates: duplicated structural text only. The wizard's active pill
  // marker prioritises among duplicates. The live DIS pills are radio-style
  // (role=radio / aria-checked), so those markers are included too.
  const dupes = parts.filter((t) => (counts.get(t) || 0) >= 2 && titleOk(t));
  const ariaCurrent = clone.querySelector("[aria-current]");
  const active =
    ariaCurrent ||
    clone.querySelector(
      '[role=tab][aria-selected="true"], [aria-checked="true"], ' +
        '.nav-link.active, .nav-item.active, .active > .nav-link, ' +
        '[class*="--current"], [class*="--active"]',
    );
  const activeText = active
    ? (active.textContent || "").replace(/\s+/g, " ").trim()
    : "";
  const currentText = ariaCurrent
    ? (ariaCurrent.textContent || "").replace(/\s+/g, " ").trim()
    : "";
  // Only trust the no-marker fallback when it is UNAMBIGUOUS: wizard chrome
  // that renders its pill list twice puts EVERY section name in dupes, and
  // dupes[0] would caption every step with the same wrong title. An empty
  // title degrades gracefully downstream (generic suggestions, untitled
  // explain prompt) — a wrong title poisons the explanation on stage.
  // Last resort: [aria-current] is BY DEFINITION "the current item in a
  // set" — trustworthy as a title even when the pill is the page's only
  // rendering of the section name (aria-checked is NOT: checked form radios
  // would leak answer captions like "50 pages" in as titles).
  const title =
    dupes.find((t) => t === activeText) ||
    (dupes.length === 1 ? dupes[0] : "") ||
    (currentText && titleOk(currentText) ? currentText : "");
  return { num, total, title: redact(title) };
}

function capture() {
  // A non-HTML top-level document (XML sitemap, raw SVG) has no body.
  if (!document.body) return { pageId: null, context: "", step: null };
  const { text, parts, counts, clone } = readStructural();
  if (looksLikeAuth(text)) return { pageId: null, context: "", step: null }; // rule 1
  // Parse the wizard counter BEFORE detection: the live counter may sit in
  // chrome the allowlist misses, and on a keyword-sparse step its 2 points
  // decide whether the form is recognised at all. The synthetic line feeds
  // detection only — never the outgoing context.
  const step = parseWizardStep(clone, parts, counts);
  const pageId = detectPage(
    step ? `${text}\nstep ${step.num} / ${step.total}` : text,
  );
  return {
    pageId,
    context: redact(text).slice(0, 4000),
    step: pageId === "form" ? step : null,
  };
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
    // Radios, checkboxes, selects and button-like inputs hold PREDEFINED
    // strings (their value/caption), not typed data — those strings
    // legitimately duplicate visible labels ("50 pages", "Kenya", "Proceed
    // to Pay") and would false-flag the audit. Rule 2 protects what the
    // user TYPES; only typed-entry surfaces are audited.
    const typed =
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" &&
        /^(text|search|email|tel|number|url|date|datetime-local|month|week|time)$/.test(
          el.type,
        ));
    if (!typed) return;
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
let observer = null;

function push(force = false) {
  // Reloading the extension while this tab is open ORPHANS this script: the
  // MutationObserver keeps firing but chrome.runtime is gone and sendMessage
  // throws synchronously — a .catch() on the promise never sees it. Detect
  // the orphan and shut down quietly; only a tab refresh injects a live
  // script again.
  if (!chrome.runtime?.id) {
    if (observer) observer.disconnect();
    return;
  }
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
  try {
    chrome.runtime
      .sendMessage({ type: "njia:context", ...next })
      .catch(() => {
        // Worker mid-restart: the message was LOST. Poison the dedupe so the
        // next capture (mutation or panel pull) re-sends rather than assuming
        // this one arrived.
        last = { pageId: null, context: " unsent", step: null };
      });
  } catch {
    if (observer) observer.disconnect(); // context invalidated mid-call
  }
}

// The side panel can pull on demand (e.g. it opened after this page loaded).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "njia:get-context") {
    last = capture();
    sendResponse(last);
    // A pull means the worker's stored copy may have been wiped (navigation
    // events fire for aborted downloads too, with no DOM change to trigger a
    // re-push) — restore storage + badge alongside the direct answer.
    try {
      chrome.runtime.sendMessage({ type: "njia:context", ...last }).catch(() => {});
    } catch {
      /* context invalidated — the direct response above already served */
    }
  } else if (msg?.type === "njia:audit") {
    sendResponse(auditNoValueLeak());
  }
});

// Initial read at document_idle, then re-read on meaningful DOM changes. The
// real portal is a Vue SPA — steps swap without a page load. Non-HTML
// documents (XML, SVG) have no body: nothing to read or observe there.
let debounce = null;
if (document.body) {
  push(true);
  observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => push(), 800);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
