// Local verification harness for extension/content.js — run with `npm test`
// (or `node content.test.js`) from tests/. No browser needed: the REAL content
// script is evaluated inside jsdom pages shaped like the live DIS portal
// (Vue SPA wizard at /applications/{id}/edit?step=N), the mock, and hostile
// cases (auth pages, orphaned extension context).
//
// What this proves before touching the live site:
//   1. detection fires per page type and survives an SPA step swap
//   2. wizard step + section title tracking (the "Form · step N/8" chip)
//   3. typed input values NEVER reach the outgoing context (security rule 2)
//   4. auth pages yield an empty capture (security rule 3)
//   5. long digit runs / emails are redacted; the URL never leaves (rule 4)
//   6. the orphan guard: an invalidated extension context (extension reloaded
//      under a live tab) shuts the script down without an uncaught error

"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "extension", "content.js"),
  "utf8",
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// content.js debounces MutationObserver pushes by 800ms.
const DEBOUNCE = 950;

// ---------- tiny test framework ----------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const line = `${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(line);
    console.log(`  ✗ ${line}`);
  }
}

function suite(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------- page loader (stubs chrome.*, evals the real content.js) ----------

function loadPage({ html, url, title = "Directorate of Immigration Services" }) {
  const jsdomErrors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => jsdomErrors.push(e));

  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>${title}</title></head><body>${html}</body></html>`,
    { url, runScripts: "outside-only", virtualConsole: vc },
  );
  const { window } = dom;

  const sent = []; // every chrome.runtime.sendMessage payload, in order
  let listener = null;
  window.chrome = {
    runtime: {
      id: "njia-test",
      sendMessage(msg) {
        sent.push(msg);
        return Promise.resolve();
      },
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
    },
  };

  window.eval(SRC); // content.js runs: push(true) + observer attach

  return {
    window,
    sent,
    jsdomErrors,
    lastSent: () => sent[sent.length - 1],
    // simulate the side panel's on-demand pull / audit request
    request(msg) {
      let out;
      listener(msg, null, (r) => (out = r));
      return out;
    },
  };
}

// ---------- DOM fixtures ----------

const WIZARD_SECTIONS = [
  "Category", "Instructions", "Passport Type", "Applicant Details",
  "Dual Nationality", "Parents Details", "Documents Upload", "Preview",
];

// Shaped like the live DIS wizard: nav pills, "Step N / 8" chrome, the active
// section rendered as both pill and heading, filled fields with dummy PII.
function wizardHtml(num, sectionTitle) {
  const pills = WIZARD_SECTIONS.map(
    (s) =>
      `<button class="nav-link${s === sectionTitle ? " active" : ""}">${s}</button>`,
  ).join("\n");
  return `
    <h3>Form Navigation</h3>
    <nav>${pills}</nav>
    <div class="step">Step ${num} / 8</div>
    <h2>${sectionTitle}</h2>
    <form>
      <label>Passport Owner</label>
      <label>Full Name (as per birth certificate)</label>
      <input id="fullname" value="Wanjiku Kamau Njeri">
      <label>Identity Card Number</label>
      <input id="idno" value="32456789">
      <label>Marital Status</label>
      <select><option selected>Married</option></select>
      <label>Special peculiarities</label>
      <textarea>My typed notes</textarea>
    </form>
    <label>34 pages</label><input type="radio" value="34 pages" checked>
    <label>50 pages</label><input type="radio" value="50 pages">
    <h4>Application No. 15251326</h4>
    <h5>Invoice No: 152513-26</h5>
    <div class="notice">Progress is saved as draft. Contact support@immigration.go.ke for help.</div>
    <!-- SurveyJS preview-style value rendering: NOT allowlisted, must not leak -->
    <div class="sd-question__content"><span class="sv-string-viewer">Wanjiku Kamau Njeri</span></div>
  `;
}

function setWizardStep(window, num, sectionTitle) {
  const doc = window.document;
  doc.querySelector(".step").textContent = `Step ${num} / 8`;
  doc.querySelector("h2").textContent = sectionTitle;
  doc.querySelectorAll(".nav-link").forEach((b) =>
    b.classList.toggle("active", b.textContent.trim() === sectionTitle),
  );
}

const WIZARD_URL = "https://dis.ecitizen.go.ke/applications/15251326/edit?step=4";

const PAYMENT_HTML = `
  <h1>Payment for Passport Application</h1>
  <table><tr><th>Payment Reference</th><th>Amount Due</th></tr>
  <tr><td>PPA-2026-004417</td><td>KES 7,550</td></tr></table>
  <fieldset><legend>Select your preferred payment method</legend>
    <label>M-Pesa</label><label>Airtel Money</label><label>Card</label>
  </fieldset>
  <label>Phone number for the M-Pesa prompt (Paybill 222222)</label>
  <div class="notice">Download BOTH invoices — the Government Copy and the Customer Copy.</div>
  <button>Proceed to Pay</button>
`;

const APPOINTMENT_HTML = `
  <h1>Book Appointment</h1>
  <div class="card-title">Passport Processing Centre</div>
  <label>Nairobi (Nyayo House)</label>
  <label>Kisumu</label>
  <label>Mombasa</label>
  <label>Embu</label>
  <div class="card-title">Available Slots</div>
  <label>Select a date</label>
  <button>Book Now</button>
  <div class="notice">Biometrics (photo capture and fingerprints) happen at this visit.</div>
`;

// ---------- suites ----------

(async function main() {
  // 1 ─────────────────────────────────────────────────────────────────────
  suite("Wizard detection + step tracking (live-portal URL, step 4/8)");
  {
    const p = loadPage({ html: wizardHtml(4, "Applicant Details"), url: WIZARD_URL });
    const m = p.lastSent();
    check("initial push fired at load", p.sent.length === 1);
    check("pageId is 'form'", m?.pageId === "form", `got ${m?.pageId}`);
    check("step number parsed", m?.step?.num === 4 && m?.step?.total === 8,
      `got ${JSON.stringify(m?.step)}`);
    check("section title extracted", m?.step?.title === "Applicant Details",
      `got "${m?.step?.title}"`);
    check("context includes structural text", m.context.includes("Applicant Details"));
    check("no jsdom errors", p.jsdomErrors.length === 0, String(p.jsdomErrors[0]));
  }

  // 2 ─────────────────────────────────────────────────────────────────────
  suite("Security invariants on the wizard page");
  {
    const p = loadPage({ html: wizardHtml(4, "Applicant Details"), url: WIZARD_URL });
    const all = JSON.stringify(p.sent);
    check("typed name never leaves", !all.includes("Wanjiku"));
    check("typed ID number never leaves", !all.includes("32456789"));
    check("typed textarea never leaves", !all.includes("My typed notes"));
    check("select value never leaves", !all.includes("Married"));
    check("application number in heading is redacted", !all.includes("15251326"));
    check("hyphen-grouped identifier is redacted", !all.includes("152513-26"));
    check("email is redacted", !all.includes("support@immigration.go.ke"));
    check("[redacted] marker present", p.lastSent().context.includes("[redacted]"));
    check("page URL never leaves", !all.includes("dis.ecitizen.go.ke") && !all.includes("/edit"));

    const audit = p.request({ type: "njia:audit" });
    check("audit counts the 3 TYPED fields (radios/selects are predefined, skipped)",
      audit.filled === 3, `got ${audit.filled}`);
    check("audit reports zero leaks (radio values matching labels are not leaks)",
      audit.leaks.length === 0, `leaks: ${audit.leaks.join(", ")}`);
  }

  // 3 ─────────────────────────────────────────────────────────────────────
  suite("SPA step swap 4/8 → 5/8 (MutationObserver re-push)");
  {
    const p = loadPage({ html: wizardHtml(4, "Applicant Details"), url: WIZARD_URL });
    setWizardStep(p.window, 5, "Dual Nationality");
    await wait(DEBOUNCE);
    const m = p.lastSent();
    check("second push fired after mutation", p.sent.length === 2, `got ${p.sent.length}`);
    check("new step number", m?.step?.num === 5, `got ${JSON.stringify(m?.step)}`);
    check("new section title", m?.step?.title === "Dual Nationality", `got "${m?.step?.title}"`);

    // dedupe: a mutation that changes nothing structural must NOT re-push
    p.window.document.body.appendChild(p.window.document.createElement("p")).textContent = "hello";
    await wait(DEBOUNCE);
    check("no push when nothing structural changed", p.sent.length === 2, `got ${p.sent.length}`);
    check("no jsdom errors", p.jsdomErrors.length === 0, String(p.jsdomErrors[0]));
  }

  // 4 ─────────────────────────────────────────────────────────────────────
  suite("Payment + appointment detection");
  {
    const pay = loadPage({ html: PAYMENT_HTML, url: "https://dis.ecitizen.go.ke/payments/checkout/abc" });
    check("payment page detected", pay.lastSent()?.pageId === "payment",
      `got ${pay.lastSent()?.pageId}`);
    check("payment has no wizard step", pay.lastSent()?.step === null);
    check("fee notice text survives into context", pay.lastSent().context.includes("Government Copy"));

    const appt = loadPage({ html: APPOINTMENT_HTML, url: "https://dis.ecitizen.go.ke/appointments/book" });
    check("appointment page detected", appt.lastSent()?.pageId === "appointment",
      `got ${appt.lastSent()?.pageId}`);
    check("appointment has no wizard step", appt.lastSent()?.step === null);
  }

  // 5 ─────────────────────────────────────────────────────────────────────
  suite("Auth bail-out (rule 3)");
  {
    // by URL path — regardless of content
    const byPath = loadPage({
      html: `<h1>Passport Type</h1><label>Form 19</label>`,
      url: "https://dis.ecitizen.go.ke/auth/signin",
    });
    check("auth URL → pageId null", byPath.lastSent()?.pageId === null);
    check("auth URL → empty context", byPath.lastSent()?.context === "");

    // by live password field — even on an application-looking URL
    const byField = loadPage({
      html: `<h1>Verify to continue</h1><input type="password"><label>Form 19</label>`,
      url: WIZARD_URL,
    });
    check("password field → pageId null", byField.lastSent()?.pageId === null);
    check("password field → empty context", byField.lastSent()?.context === "");

    const audit = byField.request({ type: "njia:audit" });
    check("audit on auth page reads nothing", audit.context === "" && audit.leaks.length === 0);

    // extended path list from the review
    const signin = loadPage({
      html: `<h1>Sign in to eCitizen</h1>`,
      url: "https://dis.ecitizen.go.ke/signin",
    });
    check("/signin path → pageId null", signin.lastSent()?.pageId === null);
  }

  // 5b ────────────────────────────────────────────────────────────────────
  suite("Non-HTML document (body guard)");
  {
    const vc = new VirtualConsole();
    const errs = [];
    vc.on("jsdomError", (e) => errs.push(e));
    const dom = new JSDOM(`<?xml version="1.0"?><urlset><url>a</url></urlset>`, {
      url: "https://dis.ecitizen.go.ke/sitemap.xml",
      contentType: "application/xml",
      runScripts: "outside-only",
      virtualConsole: vc,
    });
    const sent = [];
    dom.window.chrome = {
      runtime: {
        id: "njia-test",
        sendMessage(m) { sent.push(m); return Promise.resolve(); },
        onMessage: { addListener() {} },
      },
    };
    let threw = null;
    try { dom.window.eval(SRC); } catch (e) { threw = e; }
    check("XML page: script loads without throwing", threw === null, String(threw));
    check("XML page: nothing captured or sent", sent.length === 0 && errs.length === 0,
      `sent=${sent.length} errs=${errs.length}`);
  }

  // 6 ─────────────────────────────────────────────────────────────────────
  suite("Split counter recovery (Vue renders digits in child spans)");
  {
    // "Step 1" and "/ 8" as separate text nodes: the per-node walk misses it,
    // the element-level fallback over allowlisted parts must recover it.
    const p = loadPage({
      html: wizardHtml(1, "Category").replace(
        `<div class="step">Step 1 / 8</div>`,
        `<div class="step"><span>Step 1</span><span>/ 8</span></div>`,
      ),
      url: "https://dis.ecitizen.go.ke/applications/15251326/edit?step=1",
    });
    check("pageId still 'form'", p.lastSent()?.pageId === "form", `got ${p.lastSent()?.pageId}`);
    check("split counter recovered from element-level text",
      p.lastSent()?.step?.num === 1 && p.lastSent()?.step?.total === 8,
      `got ${JSON.stringify(p.lastSent()?.step)}`);
  }

  // 6b ────────────────────────────────────────────────────────────────────
  suite("Keyword-sparse live steps (verifier-confirmed detection gaps)");
  {
    // 'of'-style counter: URL alone scores 5 of the 6-point threshold — the
    // harmonized textPattern must contribute the missing 2.
    const ofPage = loadPage({
      html: `<div class="step">Step 6 of 8</div><h2>Residence Details</h2>
             <label>County</label><label>Sub-County</label><input value="Kiambu">`,
      url: "https://dis.ecitizen.go.ke/applications/123/edit?step=6",
    });
    check("'Step 6 of 8' page detected as form", ofPage.lastSent()?.pageId === "form",
      `got ${ofPage.lastSent()?.pageId}`);
    check("'of' counter parsed", ofPage.lastSent()?.step?.num === 6 &&
      ofPage.lastSent()?.step?.total === 8, JSON.stringify(ofPage.lastSent()?.step));

    // Counter in NON-allowlisted chrome: parseWizardStep finds it via the
    // TreeWalker, and capture() feeds it to detection as a synthetic line.
    const hidden = loadPage({
      html: `<div class="progress-text">Step 6 / 8</div><h2>Residence Details</h2>
             <label>County</label>`,
      url: "https://dis.ecitizen.go.ke/applications/123/edit?step=6",
    });
    check("counter outside allowlist still counts toward detection",
      hidden.lastSent()?.pageId === "form", `got ${hidden.lastSent()?.pageId}`);
    check("hidden counter parsed", hidden.lastSent()?.step?.num === 6,
      JSON.stringify(hidden.lastSent()?.step));
    check("synthetic detection line never enters outgoing context",
      !hidden.lastSent().context.toLowerCase().includes("step 6"));
  }

  // 6c-live ───────────────────────────────────────────────────────────────
  suite("Live DIS wizard chrome (replica of the 2026-07-26 screenshot)");
  {
    // Radio-style pills (role=radio, NOT .nav-link), counter in a plain
    // card-header row with the digits inside a <b> child, 9 steps.
    const LIVE = `
      <div class="alert">Changes you make will be saved as draft and will not
        reflect in the application until you submit the form at the end</div>
      <h6>FORM NAVIGATION</h6>
      <div class="wizard-nav">
        <div role="radio" aria-checked="true" class="pill">Category</div>
        <div role="radio" aria-checked="false" class="pill">Adult Application Instructions</div>
        <div role="radio" aria-checked="false" class="pill">Dual Nationality</div>
        <div role="radio" aria-checked="false" class="pill">Passport Type</div>
        <div role="radio" aria-checked="false" class="pill">Applicant Details</div>
      </div>
      <div class="hdr-row"><h5 class="card-title">Category</h5>
        <div>Step <b>1 / 9</b></div></div>
      <label>Passport Owner *</label>
      <select><option>Your Application</option></select>
      <button>NEXT</button>
    `;
    const p = loadPage({
      html: LIVE,
      url: "https://dis.ecitizen.go.ke/applications/15251326/edit?step=1",
    });
    const m = p.lastSent();
    check("live page detected as form", m?.pageId === "form", `got ${m?.pageId}`);
    check("'Step <b>1 / 9</b>' in unallowlisted row is parsed",
      m?.step?.num === 1 && m?.step?.total === 9, JSON.stringify(m?.step));
    check("aria-checked pill does NOT become the title (only aria-current may)",
      m?.step?.title === "" || m?.step?.title === "Category", `got "${m?.step?.title}"`);

    // same chrome but with the semantic marker the spec prescribes
    const p2 = loadPage({
      html: LIVE.replace(
        `<div role="radio" aria-checked="true" class="pill">Category</div>`,
        `<div role="radio" aria-checked="true" aria-current="step" class="pill">Category</div>`,
      ),
      url: "https://dis.ecitizen.go.ke/applications/15251326/edit?step=1",
    });
    check("[aria-current] pill IS trusted as the section title",
      p2.lastSent()?.step?.title === "Category",
      `got "${p2.lastSent()?.step?.title}"`);

    // checked ANSWER radios must never leak captions in as titles
    const p3 = loadPage({
      html: LIVE.replace('aria-checked="true" class="pill">Category',
        'aria-checked="false" class="pill">Category')
        + `<div role="radio" aria-checked="true">50 pages</div>`,
      url: "https://dis.ecitizen.go.ke/applications/15251326/edit?step=1",
    });
    check("checked answer radio ('50 pages') never becomes the title",
      p3.lastSent()?.step?.title !== "50 pages",
      `got "${p3.lastSent()?.step?.title}"`);
  }

  // 6c ────────────────────────────────────────────────────────────────────
  suite("Ambiguous title guard (pill list rendered twice, no active marker)");
  {
    const pills = WIZARD_SECTIONS.map((s) => `<button class="nav-link">${s}</button>`).join("");
    const p = loadPage({
      html: `<nav>${pills}</nav><div class="step">Step 5 / 8</div>
             <h2>Dual Nationality</h2><nav>${pills}</nav>
             <label>Passport Owner</label><label>Applicant Details</label>`,
      url: WIZARD_URL,
    });
    const step = p.lastSent()?.step;
    check("step still parsed", step?.num === 5, JSON.stringify(step));
    check("ambiguous duplicates → empty title, never a wrong guess",
      step?.title === "", `got "${step?.title}"`);
  }

  // 7 ─────────────────────────────────────────────────────────────────────
  suite("On-demand pull (side panel njia:get-context)");
  {
    const p = loadPage({ html: wizardHtml(2, "Instructions"), url: WIZARD_URL });
    const r = p.request({ type: "njia:get-context" });
    check("get-context returns current capture",
      r?.pageId === "form" && r?.step?.num === 2 && r?.step?.title === "Instructions",
      JSON.stringify(r?.step));
  }

  // 8 ─────────────────────────────────────────────────────────────────────
  suite("Orphan guard (extension reloaded under a live tab)");
  {
    // (a) runtime id gone → observer shuts down, no error, no push
    const a = loadPage({ html: wizardHtml(4, "Applicant Details"), url: WIZARD_URL });
    a.window.chrome.runtime.id = undefined;
    setWizardStep(a.window, 5, "Dual Nationality");
    await wait(DEBOUNCE);
    check("no push after context invalidated", a.sent.length === 1, `got ${a.sent.length}`);
    check("no uncaught error (id gone)", a.jsdomErrors.length === 0, String(a.jsdomErrors[0]));

    // (b) sendMessage throws synchronously (the exact live failure mode) —
    // must be swallowed, and the observer must disconnect so it never recurs
    const b = loadPage({ html: wizardHtml(4, "Applicant Details"), url: WIZARD_URL });
    let attempts = 0;
    b.window.chrome.runtime.sendMessage = () => {
      attempts++;
      throw new Error("Extension context invalidated.");
    };
    setWizardStep(b.window, 5, "Dual Nationality");
    await wait(DEBOUNCE);
    check("sync throw is swallowed", b.jsdomErrors.length === 0, String(b.jsdomErrors[0]));
    check("one attempt made", attempts === 1, `got ${attempts}`);
    setWizardStep(b.window, 6, "Parents Details");
    await wait(DEBOUNCE);
    check("observer disconnected after throw (no retry)", attempts === 1, `got ${attempts}`);

    // (c) orphaned at load time (guard runs before observer is assigned)
    const c = loadPage({ html: wizardHtml(4, "Applicant Details"), url: WIZARD_URL });
    // re-eval in a fresh page with id undefined from the start
    const vc = new VirtualConsole();
    const errs = [];
    vc.on("jsdomError", (e) => errs.push(e));
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>${wizardHtml(4, "Applicant Details")}</body></html>`,
      { url: WIZARD_URL, runScripts: "outside-only", virtualConsole: vc },
    );
    dom.window.chrome = {
      runtime: {
        id: undefined,
        sendMessage() { throw new Error("should never be called"); },
        onMessage: { addListener() {} },
      },
    };
    dom.window.eval(SRC);
    await wait(DEBOUNCE);
    check("orphaned at load: no throw, no send", errs.length === 0, String(errs[0]));
    void c;
  }

  // ---------- summary ----------
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
