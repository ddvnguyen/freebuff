#!/usr/bin/env node
// freebuff-desktop bridge: drives the Freebuff Desktop HTTP API (localhost:4320)
// and emits codebuddy stream-json events on stdout, then exits 0.
//
// Account selection (M-153): FREEBUFF_DESKTOP_URL overrides the desktop
// endpoint, FREEBUFF_DESKTOP_CREDENTIAL_REF points at a daemon-local reference
// (e.g. a token file / FB_HOME dir) the bridge resolves itself. Credentials
// never travel through Multica's DB.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const FB_URL = (process.env.FREEBUFF_DESKTOP_URL || process.env.FB_URL || "http://localhost:4320").replace(/\/+$/, "");
const CREDENTIAL_REF = process.env.FREEBUFF_DESKTOP_CREDENTIAL_REF || process.env.FB_HOME || "";
// Per-account state (the reusable thread id) lives in the directory the
// credential reference names; without one it lives under the working directory
// of the run, or FREEBUFF_DESKTOP_STATE_DIR when set. Never a fixed host path.
const HOME_DIR = resolve(CREDENTIAL_REF || process.env.FREEBUFF_DESKTOP_STATE_DIR || join(process.cwd(), ".freebuff-desktop"));

// Arguments. The daemon launches this as a codebuddy-family command, so it
// receives codebuddy's flags (-p --output-format stream-json --input-format
// stream-json --model X ...). Only --model (and our own --list-models/--json)
// mean anything here; every other flag is skipped together with its value so
// it can never leak into the prompt text.
const FLAGS_WITH_VALUE = new Set([
  "--model", "-m", "--effort", "--output-format", "--input-format", "--max-turns",
  "--append-system-prompt", "--resume", "--mcp-config", "--permission-mode",
  "--allowedTools", "--disallowedTools", "--allowed-tools", "--disallowed-tools",
  "--settings", "--add-dir", "--session-id", "--agent",
]);
function parseArgs(argv) {
  const out = { listModels: false, json: false, model: "", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list-models") out.listModels = true;
    else if (a === "--json") out.json = true;
    else if (a === "--model" || a === "-m") out.model = argv[++i] || "";
    else if (a.startsWith("--model=")) out.model = a.slice("--model=".length);
    else if (FLAGS_WITH_VALUE.has(a)) i++;
    else if (a.startsWith("-")) continue;
    else out.positional.push(a);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
// The one entry the bridge used to advertise; also what "no --model" means.
const DEFAULT_MODEL_ID = "freebuff-desktop";
const MODEL = ARGS.model && ARGS.model !== DEFAULT_MODEL_ID ? ARGS.model : "";

// Every model the account at FB_URL can pick. The desktop publishes its picker
// catalog as the first `state` event of GET /api/events (snapshot.freebuff.models),
// so one short read of that stream lists them all; there is no plain GET for it.
async function fetchModelCatalog() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(FB_URL + "/api/events", { signal: ctl.signal, headers: { accept: "text/event-stream" } });
    if (!r.ok || !r.body) throw new Error(`GET /api/events -> ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        const fb = ev?.type === "state" ? ev.snapshot?.freebuff : null;
        if (fb && Array.isArray(fb.models) && fb.models.length) return fb;
      }
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

// --list-models [--json]: report what THIS account can run, then exit.
//
// An account that is unreachable or signed out exits non-zero with the reason,
// so Multica reports that account as failed instead of advertising models it
// cannot run. The model list is the account's own picker catalog; when the
// desktop does not publish one, the single entry "freebuff-desktop" stands in.
if (ARGS.listModels) {
  let status;
  try {
    const r = await fetch(FB_URL + "/api/auth/status", { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GET /api/auth/status -> ${r.status}`);
    status = await r.json();
  } catch (e) {
    console.error(`freebuff desktop at ${FB_URL} is not reachable: ${e.message}`);
    process.exit(1);
  }
  if (!status.authed) {
    console.error(`freebuff desktop at ${FB_URL} is not signed in`);
    process.exit(1);
  }
  let models = [];
  try {
    const fb = await fetchModelCatalog();
    const recommended = new Set(Array.isArray(fb?.recommendedModels) ? fb.recommendedModels : []);
    const first = [...recommended][0];
    models = (fb?.models || [])
      .filter((m) => m && typeof m.id === "string" && m.id)
      .map((m) => ({
        id: m.id,
        name: m.displayName || m.id,
        provider: "freebuff",
        ...(m.tagline ? { description: m.tagline } : {}),
        ...(m.id === first ? { default: true } : {}),
      }));
  } catch (e) {
    console.error(`freebuff desktop model catalog unavailable: ${e.message}`);
  }
  // Multica merges accounts by model id and tags each with the accounts that answered.
  if (!models.length) models = [{ id: DEFAULT_MODEL_ID, name: "Freebuff Desktop", provider: "freebuff" }];
  if (ARGS.json) {
    process.stdout.write(JSON.stringify({ models, supported: true }) + "\n");
  } else {
    for (const m of models) console.log(m.id);
  }
  process.exit(0);
}

mkdirSync(HOME_DIR, { recursive: true });
const STATE = join(HOME_DIR, "state.json");
let state = {};
if (existsSync(STATE)) try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch {}

// The daemon sends the prompt on stdin as stream-json user messages
// ({"type":"user","message":{"content":"..."|[{"type":"text","text":"..."}]}});
// a positional argument or plain text on stdin works too.
function promptFromStdin(raw) {
  const parts = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { return raw; }
    if (ev?.type !== "user") continue;
    const c = ev.message?.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) parts.push(c.filter((p) => p?.type === "text").map((p) => p.text).join("\n"));
  }
  return parts.join("\n");
}
const prompt = ARGS.positional.join(" ") || promptFromStdin(await readStdin());
if (!prompt.trim()) { console.error("no prompt"); process.exit(2); }

async function api(path, opts = {}) {
  const r = await fetch(FB_URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`${opts.method||"GET"} ${path} -> ${r.status}`);
  return r.json();
}

// One reusable thread per model: a thread's model is fixed when it is created.
// The default (no --model) keeps the original top-level thread_id.
state.threads = state.threads || {};
let tid = MODEL ? state.threads[MODEL] : state.thread_id;
if (!tid) {
  let found = null;
  if (!MODEL) {
    const projects = await api("/api/projects");
    for (const p of projects.projects || []) for (const t of p.threads || []) {
      if (t.status === "open" && !t.archivedAt && t.turnState === "idle") { found = t.id; break; }
    }
  }
  if (found) tid = found;
  else {
    const body = { projectPath: HOME_DIR, ...(MODEL ? { harnessId: "codebuff", model: MODEL } : {}) };
    const r = await api("/api/threads", { method: "POST", body: JSON.stringify(body) });
    tid = r.id;
  }
  if (MODEL) state.threads[MODEL] = tid; else state.thread_id = tid;
  writeFileSync(STATE, JSON.stringify(state));
}

async function threadState() { const r = await api(`/api/thread/${tid}`); return r.thread; }
for (let i = 0; i < 60; i++) { const t = await threadState(); if (t.turnState !== "running") break; await sleep(5000); }

emit({ type: "system", subtype: "init", session_id: tid });

await api(`/api/thread/${tid}/message`, { method: "POST", body: JSON.stringify({ text: prompt }) });

for (let i = 0; i < 240; i++) { const t = await threadState(); if (t.turnState === "idle") break; await sleep(5000); }

const r = await api(`/api/thread/${tid}`);
const msgs = (r.messages || []).filter(m => m.role === "assistant");
const last = msgs[msgs.length - 1];
const text = (last?.parts || []).filter(p => p.kind === "text").map(p => p.text).join("\n");

emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], model: MODEL || DEFAULT_MODEL_ID } });
emit({ type: "result", result: text, is_error: false, session_id: tid, num_turns: 1 });

process.exit(0);

function emit(o){ process.stdout.write(JSON.stringify(o) + "\n"); }
function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }
async function readStdin(){ let d=""; for await (const c of process.stdin) d+=c; return d; }