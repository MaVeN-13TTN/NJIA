// Side-panel integration test — run with `node sidepanel.test.js` from tests/.
// Loads the REAL sidepanel.html + sidepanel.js into jsdom with a faithful
// chrome.* stub and a fake proxy, then simulates an applicant walking the
// 8-step wizard exactly as the service worker would report it.
//
// The requirement under test: every section change auto-publishes a NEW
// proactive explanation into the chat window — by step 8 the panel holds
// 8 explanation messages plus every question the applicant asked, with no
// duplicates when a step is revisited.

"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(
  path.join(__dirname, "..", "extension", "sidepanel.html"), "utf8");
const SRC = fs.readFileSync(
  path.join(__dirname, "..", "extension", "sidepanel.js"), "utf8");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PROXY_LATENCY = 60; // fake model latency; long enough to test in-flight races

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

// ---------- chrome + proxy stubs ----------

function makeStore(backing) {
  return {
    async get(key) {
      return key in backing ? { [key]: structuredClone(backing[key]) } : {};
    },
    async set(kv) {
      for (const [k, v] of Object.entries(kv)) backing[k] = structuredClone(v);
    },
    async remove(key) {
      delete backing[key];
    },
  };
}

function loadPanel() {
  const dom = new JSDOM(HTML, {
    url: "chrome-extension://njia-test/sidepanel.html",
    runScripts: "outside-only",
  });
  const { window } = dom;

  const local = {};   // chrome.storage.local backing
  const session = {}; // chrome.storage.session backing
  const runtimeListeners = [];
  const proxyCalls = []; // every JSON body POSTed to the fake proxy

  window.chrome = {
    storage: { local: makeStore(local), session: makeStore(session) },
    runtime: {
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      // no content script in this harness — storage.session is the source
      sendMessage: async () => { throw new Error("no receiver"); },
      onActivated: { addListener() {} },
    },
    windows: {
      getCurrent: async () => ({ id: 7 }),
      onFocusChanged: { addListener() {} },
    },
  };

  // Fake proxy: answers encode the request so assertions can tell WHICH step
  // was explained and which question was answered.
  window.fetch = (url, opts) => {
    const body = JSON.parse(opts.body);
    proxyCalls.push(body);
    return new Promise((resolve) =>
      setTimeout(() => resolve({
        ok: true,
        status: 200,
        json: async () => {
          const m = body.question.match(/I'm on step (\d+) of (\d+)/);
          if (m) return { answer: `EXPLAIN step ${m[1]}` };
          if (!body.question) return { answer: `EXPLAIN ${body.pageId}` };
          return { answer: `ANSWER: ${body.question}` };
        },
      }), PROXY_LATENCY),
    );
  };

  window.eval(SRC); // sidepanel.js runs: init() → loadHistory, refreshContext

  const doc = window.document;
  return {
    window,
    local,
    session,
    proxyCalls,
    // Simulate the service worker: content.js pushed a new step for tab 1 —
    // write storage FIRST, then broadcast (the worker's invariant).
    async setStep(num, title) {
      session["ctx:1"] = {
        pageId: "form",
        context: `Form Navigation\nStep ${num} / 8\n${title}`,
        step: { num, total: 8, title },
      };
      runtimeListeners.forEach((fn) => fn({ type: "njia:context-updated", tabId: 1 }));
    },
    async askQuestion(q) {
      doc.getElementById("question").value = q;
      doc.getElementById("composer").dispatchEvent(
        new window.Event("submit", { cancelable: true }));
    },
    bubbles: (role) => [...doc.querySelectorAll(`.msg.msg-${role}`)].map((el) => el.textContent),
    chip: () => doc.getElementById("page-chip").textContent,
    suggestions: () => [...doc.querySelectorAll("#suggestions button")].map((b) => b.textContent),
  };
}

const SECTIONS = [
  "Category", "Instructions", "Passport Type", "Applicant Details",
  "Dual Nationality", "Parents Details", "Documents Upload", "Preview",
];

// ---------- suites ----------

(async function main() {
  // 1 ─────────────────────────────────────────────────────────────────────
  suite("Full 8-step walk: one explanation per section + questions in between");
  {
    const p = loadPanel();
    await wait(50); // init settles ("No step detected")

    for (let n = 1; n <= 8; n++) {
      await p.setStep(n, SECTIONS[n - 1]);
      await wait(PROXY_LATENCY + 120); // dwell: explanation lands before Next

      if (n === 3) {
        await p.askQuestion("How much will this cost and how do I pay?");
        await wait(PROXY_LATENCY + 120);
      }
    }
    await p.askQuestion("What do I bring to the appointment?");
    await wait(PROXY_LATENCY + 120);

    const assistant = p.bubbles("assistant");
    const explains = assistant.filter((t) => t.startsWith("EXPLAIN"));
    const answers = assistant.filter((t) => t.startsWith("ANSWER"));

    check("8 proactive explanations in the chat window", explains.length === 8,
      `got ${explains.length}: ${explains.join(" | ")}`);
    check("explanations cover steps 1..8 in order",
      explains.join(",") === Array.from({ length: 8 }, (_, i) => `EXPLAIN step ${i + 1}`).join(","),
      explains.join(","));
    check("both applicant questions answered", answers.length === 2, `got ${answers.length}`);
    check("applicant questions render as user bubbles", p.bubbles("user").length === 2);
    check("total: 10 assistant messages (8 explains + 2 answers)", assistant.length === 10,
      `got ${assistant.length}`);

    // each explanation request told the proxy which step it was
    const explainReqs = p.proxyCalls.filter((c) => /I'm on step \d+ of 8/.test(c.question));
    check("proxy was asked once per step with the step number",
      explainReqs.length === 8 &&
      new Set(explainReqs.map((c) => c.question.match(/step (\d+)/)[1])).size === 8);
    check("every explain request named its section title",
      explainReqs.every((c, i) => c.question.includes(`"${SECTIONS[c.question.match(/step (\d+)/)[1] - 1]}"`)));

    check("chip ends on 'Form · step 8/8: Preview'",
      p.chip() === "Form · step 8/8: Preview", p.chip());

    // persistence: 8 hidden explain turns + 8 answers + 2 Q + 2 A = 20 entries
    const hist = p.local["njia:history"];
    check("history persisted with 20 entries (under the 40 cap)",
      Array.isArray(hist) && hist.length === 20, `got ${hist?.length}`);
    check("explain prompts stored hidden (chat shows only the answer)",
      hist.filter((h) => h.hidden).length === 8);

    const explained = p.session["explained"];
    check("explained map burned form#1..form#8",
      SECTIONS.every((_, i) => explained[`form#${i + 1}`] === true),
      JSON.stringify(explained));

    // revisiting a step must NOT duplicate its explanation
    await p.setStep(4, SECTIONS[3]);
    await wait(PROXY_LATENCY + 120);
    check("revisiting step 4 adds no duplicate explanation",
      p.bubbles("assistant").length === 10,
      `got ${p.bubbles("assistant").length}`);
    check("chip still tracks the revisited step",
      p.chip() === "Form · step 4/8: Applicant Details", p.chip());
  }

  // 2 ─────────────────────────────────────────────────────────────────────
  suite("Per-section suggestion chips follow the applicant");
  {
    const p = loadPanel();
    await wait(50);
    await p.setStep(4, "Applicant Details");
    await wait(PROXY_LATENCY + 120);
    check("Applicant Details step surfaces the name-mismatch question",
      p.suggestions().some((s) => /ID and birth certificate names differ/.test(s)),
      p.suggestions().join(" | "));

    await p.setStep(7, "Documents Upload");
    await wait(PROXY_LATENCY + 120);
    check("Documents Upload step swaps to upload questions",
      p.suggestions().some((s) => /documents do I upload/i.test(s)),
      p.suggestions().join(" | "));

    await p.setStep(6, "Recommender");
    await wait(PROXY_LATENCY + 120);
    check("Recommender step asks about the recommending officer",
      p.suggestions().some((s) => /recommender/i.test(s)),
      p.suggestions().join(" | "));

    // a section we've never catalogued → title-derived questions, not the trio
    await p.setStep(8, "Minor Applicant Consent");
    await wait(PROXY_LATENCY + 120);
    check("unknown section gets title-derived questions",
      p.suggestions().some((s) => s.includes(`"Minor Applicant Consent" section`)),
      p.suggestions().join(" | "));

    // step number without a title → step-derived questions, not the trio
    await p.setStep(9, "");
    await wait(PROXY_LATENCY + 120);
    check("titleless step gets step-number questions",
      p.suggestions().some((s) => /step 9 of 8|step 9/.test(s)) &&
      !p.suggestions().every((s) => /cost|documents do I need|names differ/i.test(s)),
      p.suggestions().join(" | "));
  }

  // 3 ─────────────────────────────────────────────────────────────────────
  suite("Rapid clicking (steps swapped while an explanation is in flight)");
  {
    const p = loadPanel();
    await wait(50);

    await p.setStep(1, SECTIONS[0]); // explanation for 1 starts (60ms latency)
    await wait(15);
    await p.setStep(2, SECTIONS[1]); // passes through while 1 is in flight
    await wait(15);
    await p.setStep(3, SECTIONS[2]); // lands here
    await wait(PROXY_LATENCY * 3 + 200);

    let explains = p.bubbles("assistant").filter((t) => t.startsWith("EXPLAIN"));
    check("dwelled steps explained (1 and 3), passed-through step skipped",
      explains.join(",") === "EXPLAIN step 1,EXPLAIN step 3", explains.join(","));

    // the skipped step was never burned — revisiting it explains it
    await p.setStep(2, SECTIONS[1]);
    await wait(PROXY_LATENCY + 150);
    explains = p.bubbles("assistant").filter((t) => t.startsWith("EXPLAIN"));
    check("returning to the skipped step 2 explains it then",
      explains.length === 3 && explains[2] === "EXPLAIN step 2", explains.join(","));
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
