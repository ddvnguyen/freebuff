#!/usr/bin/env node
// freebuff-desktop bridge: drives the Freebuff Desktop HTTP API (localhost:4320)
// and emits codebuddy stream-json events on stdout, then exits 0.
//
// Account selection (M-153): FREEBUFF_DESKTOP_URL overrides the desktop
// endpoint, FREEBUFF_DESKTOP_CREDENTIAL_REF points at a daemon-local reference
// (e.g. a token file / FB_HOME dir) the bridge resolves itself. Credentials
// never travel through Multica's DB.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FB_URL = process.env.FREEBUFF_DESKTOP_URL || process.env.FB_URL || "http://localhost:4320";
const CREDENTIAL_REF = process.env.FREEBUFF_DESKTOP_CREDENTIAL_REF || process.env.FB_HOME || "";
const HOME_DIR = CREDENTIAL_REF || (existsSync("/mnt/workspace/work/lane-c/state.json") ? "/mnt/workspace/work/lane-c" : "/mnt/workspace/work/freebuff-session");

// --list-models --json: emit the codebuddy-compatible model list and exit.
if (process.argv.includes("--list-models")) {
  const models = [{ id: "freebuff-desktop", name: "Freebuff Desktop", provider: "freebuff" }];
  if (process.argv.includes("--json")) {
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

const prompt = process.argv.slice(2).filter(a => a !== "--list-models" && a !== "--json").join(" ") || await readStdin();
if (!prompt.trim()) { console.error("no prompt"); process.exit(2); }

async function api(path, opts = {}) {
  const r = await fetch(FB_URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`${opts.method||"GET"} ${path} -> ${r.status}`);
  return r.json();
}

let tid = state.thread_id;
if (!tid) {
  const projects = await api("/api/projects");
  let found = null;
  for (const p of projects.projects || []) for (const t of p.threads || []) {
    if (t.status === "open" && !t.archivedAt && t.turnState === "idle") { found = t.id; break; }
  }
  if (found) tid = found;
  else {
    const r = await api("/api/threads", { method: "POST", body: JSON.stringify({ projectPath: HOME_DIR }) });
    tid = r.id;
  }
  state.thread_id = tid;
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

emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], model: "freebuff-desktop" } });
emit({ type: "result", result: text, is_error: false, session_id: tid, num_turns: 1 });

process.exit(0);

function emit(o){ process.stdout.write(JSON.stringify(o) + "\n"); }
function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }
async function readStdin(){ let d=""; for await (const c of process.stdin) d+=c; return d; }