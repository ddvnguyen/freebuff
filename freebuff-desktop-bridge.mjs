#!/usr/bin/env node
// freebuff-desktop bridge: drives the Freebuff Desktop HTTP API (localhost:4320)
// and emits codebuddy stream-json events on stdout, then exits 0.
//
// Account selection (M-153): FREEBUFF_DESKTOP_URL overrides the desktop
// endpoint, FREEBUFF_DESKTOP_CREDENTIAL_REF points at a daemon-local reference
// (e.g. a token file / FB_HOME dir) the bridge resolves itself. Credentials
// never travel through Multica's DB.
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const FB_URL = (process.env.FREEBUFF_DESKTOP_URL || process.env.FB_URL || "http://localhost:4320").replace(/\/+$/, "");
// Per-account state (the reusable thread id) lives beside the installed
// bridge: Multica hands every run a fresh workdir, so a workdir default would
// create a new desktop session on every run. FREEBUFF_DESKTOP_STATE_DIR and the
// account's credential ref (FB_HOME) still win, e.g. for per-account isolation;
// credentials never travel through Multica's DB. Never a fixed host path.
const CREDENTIAL_REF = process.env.FREEBUFF_DESKTOP_CREDENTIAL_REF || process.env.FB_HOME || "";
const INSTALL_DIR = (process.argv[1] && existsSync(process.argv[1]) ? dirname(realpathSync(process.argv[1])) : process.cwd());
const HOME_DIR = resolve(CREDENTIAL_REF || process.env.FREEBUFF_DESKTOP_STATE_DIR || join(INSTALL_DIR, ".freebuff-desktop-state"));

// Arguments. The daemon launches this as a codebuddy-family command, so it
// receives codebuddy's flags (-p --output-format stream-json --input-format
// stream-json --model X ...). Only --model (and our own --list-models/--json)
// mean anything here; every other flag is skipped together with its value so
// it can never leak into the prompt text.
const FLAGS_WITH_VALUE = new Set([
  "--model", "-m", "--effort", "--output-format", "--input-format", "--max-turns",
  "--append-system-prompt", "--resume", "--permission-mode",
  "--settings", "--session-id", "--agent",
]);
// Variadic in codebuddy's CLI: they swallow every following non-flag token
// (the daemon passes `--disallowedTools AskUserQuestion EnterPlanMode ...`).
const FLAGS_WITH_VARIADIC = new Set([
  "--allowedTools", "--disallowedTools", "--allowed-tools", "--disallowed-tools", "--add-dir", "--mcp-config",
]);
function parseArgs(argv) {
  const out = { listModels: false, json: false, model: "", resume: "", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list-models") out.listModels = true;
    else if (a === "--json") out.json = true;
    else if (a === "--model" || a === "-m") out.model = argv[++i] || "";
    else if (a.startsWith("--model=")) out.model = a.slice("--model=".length);
    else if (a === "--resume") out.resume = argv[++i] || "";
    else if (FLAGS_WITH_VARIADIC.has(a)) { while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) i++; }
    else if (FLAGS_WITH_VALUE.has(a)) i++;
    else if (a.startsWith("-")) continue;
    else out.positional.push(a);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const STDIN_PROMPT = process.argv.includes("--input-format") || !process.stdin.isTTY;
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
// Text of a stream-json user event: "content" is a string or a text-parts array.
function userEventText(ev) {
  const c = ev.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  return "";
}
// The daemon keeps stdin open for steering (more user frames may arrive during
// the turn), so the prompt is THE FIRST user frame, not stdin-EOF: reading to
// EOF here deadlocks the run (daemon waits for output, bridge waits for EOF).
// Plain text only lands via the EOF fallback below, so non-JSON junk never
// becomes the prompt while a daemon is attached.
async function firstUserPrompt() {
  const reader = process.stdin[Symbol.asyncIterator]();
  let plain = "";
  try {
    for (;;) {
      const { value, done } = await reader.next();
      if (done) break;
      let data = value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
      for (const line of data.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev?.type === "user") {
            const text = userEventText(ev);
            if (text.trim()) return text;
          }
        } catch { plain += (plain ? "\n" : "") + line; }
      }
    }
  } finally {
    // Release stdin; the daemon may keep writing (steering) — ignore it.
    process.stdin.destroy();
  }
  return plain;
}
const fromStdin = STDIN_PROMPT ? await firstUserPrompt() : "";
const rawPrompt = fromStdin.trim() ? fromStdin : ARGS.positional.join(" ");
if (!rawPrompt.trim()) { console.error("no prompt"); process.exit(2); }
// The daemon's task preamble tells the agent to deliver via the `multica`
// CLI. Inside the desktop engine that CLI resolves through the machine-wide
// config, which authenticates as the machine OWNER — the agent then comments
// with the owner's identity. Multica attributes everything this bridge emits
// (assistant/result) to the agent automatically, so the CLI path is both
// wrong and unnecessary.
const RUNTIME_OVERRIDE = [
  "",
  "RUNTIME OVERRIDE (higher priority than any instruction above):",
  "You are NOT inside the Multica runtime. The `multica` CLI visible on this machine belongs to the machine owner and MUST NOT be used: never run `multica` to read issues, list comments, or write comments/mentions. The daemon preamble's 'post your results with multica issue comment add' does not apply here.",
  "Your final answer text IS the deliverable: when your turn ends, Multica publishes it to the issue automatically, attributed to the agent (you). Do nothing extra to deliver it.",
  "Never touch machine owner files (identity, /home config) and never write outside the task directory.",
  "If a task genuinely needs the multica CLI or repo checkout, state that as a plain blocker in your answer instead of attempting it.",
].join("\n");
const prompt = rawPrompt.trim() + "\n" + RUNTIME_OVERRIDE;

async function api(path, opts = {}) {
  const r = await fetch(FB_URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`${opts.method||"GET"} ${path} -> ${r.status}`);
  return r.json();
}

// One reusable thread per model: a thread's model is fixed when it is created.
// The default (no --model) keeps the original top-level thread_id.
state.threads = state.threads || {};
// Adopt in order: --resume (the daemon resumes the previous run's session after
// a cancel/requeue), then the state's known thread; create only when neither is
// usable. Adopting a thread with a still-running turn (the ghost of a cancelled
// run) stops that turn first — otherwise the new prompt rides on a dead turn
// and a fresh thread gets charged.
async function adopt(id) {
  try {
    const r = await api(`/api/thread/${id}`);
    const t = r.thread;
    if (t && t.status === "open") return t;
  } catch {}
  return null;
}
let tinfo = null;
let tid = null;
for (const id of [ARGS.resume, MODEL ? state.threads[MODEL] : state.thread_id].filter(Boolean)) {
  tinfo = await adopt(id);
  if (tinfo) { tid = id; break; }
}
if (!tid) {
  let found = null;
  if (!MODEL) {
    const projects = await api("/api/projects");
    for (const p of projects.projects || []) for (const t of p.threads || []) {
      if (t.status === "open" && !t.archivedAt && t.turnState === "idle") { found = t.id; break; }
    }
  }
  if (found) { tid = found; tinfo = await adopt(tid); }
  else {
    const body = { projectPath: HOME_DIR, ...(MODEL ? { harnessId: "codebuff", model: MODEL } : {}) };
    const r = await api("/api/threads", { method: "POST", body: JSON.stringify(body) });
    tid = r.id;
  }
}
const known = MODEL ? state.threads[MODEL] : state.thread_id;
if (known !== tid) {
  if (MODEL) state.threads[MODEL] = tid; else state.thread_id = tid;
  saveState();
}

async function threadState() { const r = await api(`/api/thread/${tid}`); return r.thread; }
if (tinfo?.turnState === "running") {
  await api(`/api/thread/${tid}/stop`, { method: "POST", body: "{}" }).catch(() => {});
}
// Streaming. The desktop does NOT push message deltas over /api/events (that
// stream carries state/thread/auth frames only, verified against 0.0.188), but
// GET /api/thread/:id is a live view of the turn: parts grow in place (text
// appends, tools gain output) and carry streamSeq. Poll it and forward each new
// slice as an `assistant` text block — the daemon appends MessageText
// progressively — so the run streams instead of arriving as one lump at the end.
const POLL_MS = Math.max(150, Number(process.env.FREEBUFF_DESKTOP_POLL_MS) || 500);
const MODEL_TAG = MODEL || DEFAULT_MODEL_ID;
const emitText = (delta) => {
  if (delta) emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: delta }], model: MODEL_TAG } });
};
const emitThinking = (delta) => {
  if (delta) emit({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", text: delta }], model: MODEL_TAG } });
};
const emitToolUse = (id, name, input) => {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: input || {} }], model: MODEL_TAG } });
};

// A stop can leave the previous turn "running"; waiting it out burned up to five
// minutes on a run that already looked hung, so bound the wait and move on.
for (let i = 0; i < Math.ceil(60_000 / POLL_MS); i++) {
  const t = await threadState();
  if (t.turnState !== "running") break;
  await sleep(POLL_MS);
}

emit({ type: "system", subtype: "init", session_id: tid });

const assistantOf = (msgs) => {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === "assistant") return msgs[i];
  return null;
};
const partLen = (p) => (p && typeof p.text === "string" ? p.text.length : 0);

// Baseline: what the thread already showed, so a resumed session's earlier parts
// are not replayed into this run's transcript.
let seenCount = 0;
let seenParts = [];
try {
  const base = await api(`/api/thread/${tid}`);
  const baseMsgs = base.messages || [];
  seenCount = baseMsgs.filter((m) => m.role === "assistant").length;
  seenParts = ((assistantOf(baseMsgs) || {}).parts || []).map((p) => ({ kind: p.kind, len: partLen(p) }));
} catch {}

await api(`/api/thread/${tid}/message`, { method: "POST", body: JSON.stringify({ text: prompt }) });

const emittedTools = new Set();
let streamedAnything = false;
let finalText = "";

// Forward the turn's new parts. `seenParts` tracks the last assistant message
// only: parts append to its tail (an older part stops changing once a newer one
// exists) and a new message resets the list.
function pump(msgs) {
  const assistants = msgs.filter((m) => m.role === "assistant");
  if (!assistants.length) return;
  const last = assistants[assistants.length - 1];
  if (assistants.length > seenCount) {
    seenCount = assistants.length;
    seenParts = [];
  }
  const parts = last.parts || [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] || {};
    const prev = seenParts[i];
    if (p.kind === "text" || p.kind === "reasoning") {
      const text = typeof p.text === "string" ? p.text : "";
      const from = prev && prev.kind === p.kind ? prev.len : 0;
      if (text.length > from) {
        if (p.kind === "text") {
          emitText(text.slice(from));
          streamedAnything = true;
        } else {
          emitThinking(text.slice(from));
        }
      }
      seenParts[i] = { kind: p.kind, len: text.length };
    } else if (p.kind === "tool") {
      const key = p.id || `i${i}`;
      if (!emittedTools.has(key)) {
        emittedTools.add(key);
        emitToolUse(key, p.toolName || "tool", p.input && typeof p.input === "object" ? p.input : {});
        streamedAnything = true;
      }
      seenParts[i] = { kind: p.kind, len: 0 };
    } else {
      seenParts[i] = { kind: p.kind, len: partLen(p) };
    }
  }
  const text = parts.filter((p) => p.kind === "text").map((p) => p.text || "").join("\n");
  if (text) finalText = text;
}

// 30 minutes at the default cadence; the old fixed loop gave up at 20.
const MAX_POLLS = Math.ceil(1_800_000 / POLL_MS);
for (let i = 0; i < MAX_POLLS; i++) {
  let r;
  try {
    r = await api(`/api/thread/${tid}`);
  } catch {
    await sleep(POLL_MS);
    continue;
  }
  pump(r.messages || []);
  if ((r.thread || {}).turnState !== "running") break;
  await sleep(POLL_MS);
}

// Final read: the slice produced between the last poll and the turn going idle.
try {
  const r = await api(`/api/thread/${tid}`);
  pump(r.messages || []);
} catch {}

// A turn with no visible parts still has to answer.
if (!streamedAnything) emitText(finalText);
emit({ type: "result", result: finalText, is_error: false, session_id: tid, num_turns: 1 });

process.exit(0);

function saveState(){
  // Atomic: several runs may share this state dir, a torn write would strand
  // a reusable thread id behind a JSON parse failure.
  writeFileSync(STATE + ".tmp", JSON.stringify(state));
  renameSync(STATE + ".tmp", STATE);
}
function emit(o){ process.stdout.write(JSON.stringify(o) + "\n"); }
function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }