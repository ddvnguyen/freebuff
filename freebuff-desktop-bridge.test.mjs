import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const bridge = resolve(import.meta.dir, "freebuff-desktop-bridge.mjs");
const scratchRoot = "/mnt/workspace/tmp";
mkdirSync(scratchRoot, { recursive: true });
const scratchDirs = [];
const servers = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureServer() {
  const requests = [];
  const threads = new Map();
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, body });
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && url.pathname.startsWith("/api/thread/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/thread/".length));
      const thread = threads.get(id);
      if (!thread) return json({}, 404);
      return json({ thread, messages: thread.messages || [] });
    }
    if (req.method === "POST" && url.pathname === "/api/threads") {
      const id = `new-${++sequence}`;
      threads.set(id, { id, status: "open", turnState: "idle", createdAt: new Date().toISOString(), messages: [] });
      return json({ id });
    }
    const messageMatch = url.pathname.match(/^\/api\/thread\/([^/]+)\/message$/);
    if (req.method === "POST" && messageMatch) {
      const thread = threads.get(decodeURIComponent(messageMatch[1]));
      const message = JSON.parse(body);
      thread.messages = [{ role: "assistant", parts: [{ kind: "text", text: "done" }] }];
      thread.lastPrompt = message.text;
      return json({ ok: true });
    }
    return json({ error: "unexpected request" }, 404);
  });
  servers.push(server);
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => {
    resolveListen({ requests, threads, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

function runBridge({ url, stateDir, cwd, resume, prompt = "do the task" }) {
  return new Promise((resolveRun, reject) => {
    const args = [bridge, "--output-format", "stream-json", "--input-format", "stream-json"];
    if (resume) args.push("--resume", resume);
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, FREEBUFF_DESKTOP_URL: url, FREEBUFF_DESKTOP_STATE_DIR: stateDir, FREEBUFF_DESKTOP_POLL_MS: "150" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`bridge exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify({ type: "user", message: { content: prompt } }) + "\n");
  });
}

test("expired resume rotates to a fresh thread with task context; valid resume keeps task identity without reinjecting context", async () => {
  const api = await fixtureServer();
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-test-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "CODEBUDDY.md"), "task-specific context");
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ thread_id: "expired" }));
  api.threads.set("expired", {
    id: "expired", status: "open", turnState: "idle",
    createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), messages: [],
  });

  const rotated = await runBridge({ url: api.url, stateDir, cwd, resume: "expired" });
  const firstPrompt = api.threads.get("new-1").lastPrompt;
  expect(firstPrompt).toContain("task-specific context");
  expect(firstPrompt).toContain("pre-authenticated as this agent for this task");
  expect(rotated.stdout).toContain('"session_id":"new-1"');
  expect(api.requests.some((request) => request.path === "/api/projects")).toBe(false);

  api.threads.set("recent", {
    id: "recent", status: "open", turnState: "idle",
    createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000 + 60_000).toISOString(), messages: [],
  });
  const resumed = await runBridge({ url: api.url, stateDir, cwd, resume: "recent", prompt: "follow-up" });
  const secondPrompt = api.threads.get("recent").lastPrompt;
  expect(secondPrompt).not.toContain("task-specific context");
  expect(secondPrompt).toContain("pre-authenticated as this agent for this task");
  expect(resumed.stdout).toContain('"session_id":"recent"');
  expect(readFileSync(join(stateDir, "state.json"), "utf8")).toContain('"thread_id":"recent"');
});
