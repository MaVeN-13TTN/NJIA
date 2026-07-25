// Njia Claude proxy.
// Holds the Anthropic API key (never the extension), grounds every answer in
// the verified knowledge pack via Adiel's Python retriever, and serves the
// side panel's one endpoint: POST /ask.
//
// Contract (fixed by extension/sidepanel.js — do not change shapes here
// without changing the panel):
//   request  { pageId: "form"|"payment"|"appointment", pageContext: string,
//              question: string ("" = proactive explanation), history: [...] }
//   response 200 { answer: <non-empty string> } — anything else must be a
//              non-2xx status; the panel treats an empty 200 answer as an error.
//   The panel aborts after 30s.
//
// SECURITY (CLAUDE.md rule 4): this server keeps NO logs of user content.
// Request bodies, page context, questions, and answers are never written to
// stdout or disk. Log lines carry method, pageId, status, and duration only.

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { execFile } = require("child_process");
const path = require("path");
const express = require("express");

const PORT = 8787;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PYTHON = process.env.PYTHON_BIN || "python3";
const GROUNDING_SCRIPT = path.join(__dirname, "grounding.py");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const UPSTREAM_TIMEOUT_MS = 25000; // inside the panel's 30s abort
const MAX_TOKENS = 700;

const PAGE_IDS = new Set(["form", "payment", "appointment"]);

// The exact string the side panel stores in its own history when it sends an
// empty question (sidepanel.js:381) — using the same wording keeps the
// conversation the model sees consistent with what the panel saved.
const DEFAULT_QUESTION = "Explain this step for a first-time applicant.";

const STEP_FOCUS = {
  form: [
    "The user is on the passport APPLICATION FORM (Form 19 — on the live portal",
    "it is an 8-step wizard). Explain what the current step asks for and what a",
    "first-time applicant should watch out for. The single most common failure",
    "is a name or date-of-birth mismatch between national ID and birth",
    "certificate — warn about it when relevant.",
  ].join(" "),
  payment: [
    "The user is on the PAYMENT step. Be precise about the fee for their booklet",
    "and the payment methods. Always remind them: TWO payment invoices are",
    "issued — download and print BOTH (Government copy and Customer copy) before",
    "closing the tab; they must bring both to the appointment.",
  ].join(" "),
  appointment: [
    "The user is on the APPOINTMENT BOOKING step (biometrics). Help them pick a",
    "processing centre, list exactly what to bring on the day, and set",
    "expectations for what happens next (biometric capture, processing time,",
    "collection at the same centre).",
  ].join(" "),
};

const PERSONA = [
  "You are Njia, a friendly in-page guide helping a FIRST-TIME Kenyan passport",
  "applicant complete their application on eCitizen. You can see the structure",
  "of the page they are on (headings, labels, buttons — never anything they",
  "typed). Speak plainly, use Kenyan context (KES, M-Pesa, Nyayo House), and",
  "keep answers short and practical: lead with the direct answer, then at most",
  "a few supporting points. Stay under ~150 words unless the user asks for",
  "detail. Use **bold** sparingly and simple dash bullets — no headings, no",
  "tables, no links.",
].join(" ");

// ---------- knowledge grounding (Adiel's pipeline, unchanged) ----------

function getGrounding(question, pageContext) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [GROUNDING_SCRIPT],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error("grounding failed: " + err.message));
        const block = stdout.trim();
        if (!block) return reject(new Error("grounding returned nothing"));
        resolve(block);
      },
    );
    child.stdin.on("error", () => {}); // spawn failure surfaces via callback
    child.stdin.end(JSON.stringify({ question, page_context: pageContext }));
  });
}

// ---------- request sanitisation ----------

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-12)
    .map(({ role, content }) => ({ role, content }));
}

// ---------- the endpoint ----------

const app = express();
app.use(express.json({ limit: "200kb" }));

// CORS: the caller is a chrome-extension:// page with localhost
// host_permissions, so this is belt-and-braces (and enables curl testing).
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL }));

app.post("/ask", async (req, res) => {
  const started = Date.now();
  const { pageId, pageContext, question, history } = req.body || {};
  const done = (status, payload) => {
    // NO user content in logs — method, pageId, status, duration only.
    console.log(
      `POST /ask pageId=${PAGE_IDS.has(pageId) ? pageId : "invalid"} ` +
        `${status} ${Date.now() - started}ms`,
    );
    res.status(status).json(payload);
  };

  if (!PAGE_IDS.has(pageId)) {
    return done(400, { error: "pageId must be form | payment | appointment" });
  }
  const q =
    typeof question === "string" && question.trim()
      ? question.trim()
      : DEFAULT_QUESTION;
  const ctx = typeof pageContext === "string" ? pageContext.slice(0, 4000) : "";

  let grounding;
  try {
    grounding = await getGrounding(q, ctx);
  } catch (e) {
    console.error("grounding error:", e.message); // no user content in message
    return done(502, { error: "knowledge retrieval failed" });
  }

  const system = [
    PERSONA,
    STEP_FOCUS[pageId],
    ctx
      ? "Structure of the page the user is looking at right now (redacted, no typed values):\n" +
        ctx
      : "",
    grounding,
  ]
    .filter(Boolean)
    .join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [...cleanHistory(history), { role: "user", content: q }],
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      console.error(
        `anthropic ${r.status} ${errBody?.error?.type || "unknown_error"}:`,
        JSON.stringify(errBody),
      );
      return done(502, { error: "model call failed" });
    }

    const data = await r.json();
    if (data.stop_reason === "refusal") {
      return done(502, { error: "model declined the request" });
    }
    const answer = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!answer) return done(502, { error: "empty model response" });

    return done(200, { answer });
  } catch (e) {
    console.error(
      e.name === "AbortError" ? "anthropic timeout" : `anthropic error: ${e.name}`,
    );
    return done(504, { error: "model call timed out" });
  } finally {
    clearTimeout(timer);
  }
});

// ---------- startup ----------

app.listen(PORT, () => {
  console.log(`Njia proxy on http://localhost:${PORT}  model=${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY is not set — /ask will fail.");
    console.warn("         cp .env.example .env and paste the key.");
  }
  // Prove the Python knowledge bridge works before the demo does.
  getGrounding("how much does a passport cost?", "")
    .then(() => console.log("knowledge retrieval OK (grounding.py)"))
    .catch((e) =>
      console.warn(
        `WARNING: knowledge retrieval failed (${e.message}). ` +
          `Check PYTHON_BIN in .env and that rank_bm25 is installed ` +
          `(pip install -r ../requirements.txt).`,
      ),
    );
});
