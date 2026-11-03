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

function fixtureServer({ launchIDs, onRequest = () => {}, stuck = false } = {}) {
  const requests = [];
  const threads = new Map();
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://localhost");
    const launchID = req.headers["x-freebuff-launch-id"];
    requests.push({ method: req.method, path: url.pathname, body, launchID });
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    onRequest({ method: req.method, path: url.pathname, body });
    if (launchIDs && url.pathname.startsWith("/api/") && !launchIDs.has(launchID)) {
      return json({ error: "missing or invalid launch id" }, 401);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/status") return json({ authed: true });
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`data: ${JSON.stringify({ type: "state", snapshot: { freebuff: { models: [{ id: "model-a", displayName: "Model A" }] } } })}\n\n`);
    }
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
      if (stuck) thread.turnState = "running";
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

function runBridge({ url, stateDir, cwd, resume, prompt = "do the task", launchID, listModels = false, token = "", timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const args = listModels ? [bridge, "--list-models", "--json"] : [bridge, "--output-format", "stream-json", "--input-format", "stream-json"];
    if (resume) args.push("--resume", resume);
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, MULTICA_TOKEN: token, FREEBUFF_DESKTOP_URL: url, FREEBUFF_DESKTOP_STATE_DIR: stateDir, FREEBUFF_DESKTOP_POLL_MS: "150", ...(launchID ? { FREEBUFF_DESKTOP_LAUNCH_ID: launchID } : {}), ...(timeoutMs ? { FREEBUFF_DESKTOP_TIMEOUT_MS: String(timeoutMs) } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`bridge exited ${code}: ${stderr}`)));
    if (!listModels) child.stdin.end(JSON.stringify({ type: "user", message: { content: prompt } }) + "\n");
  });
}

test("a running turn at the deadline fails instead of reporting success", async () => {
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-timeout-"));
  scratchDirs.push(dir);
  const api = await fixtureServer({ stuck: true });
  await expect(runBridge({ url: api.url, stateDir: dir, cwd: dir, timeoutMs: 150 })).rejects.toThrow("provider work may still be running");
  expect(api.requests.some((r) => r.path.endsWith("/stop"))).toBe(false);
});

test("fresh and resumed threads reference project instructions without copying them into the prompt", async () => {
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-test-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "task-specific context");
  const bridgeState = join(stateDir, "bridge-state.json");
  const orchestratorState = join(stateDir, "state.json");
  const updatedOrchestratorState = '{"auth":{"revision":2}}';
  writeFileSync(bridgeState, JSON.stringify({ thread_id: "expired" }));
  writeFileSync(orchestratorState, '{"auth":{"revision":1}}');
  const api = await fixtureServer({ onRequest: ({ method, path }) => {
    if (method === "POST" && path === "/api/threads") writeFileSync(orchestratorState, updatedOrchestratorState);
  } });
  api.threads.set("expired", {
    id: "expired", status: "open", turnState: "idle",
    createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), messages: [],
  });

  const rotated = await runBridge({ url: api.url, stateDir, cwd, resume: "expired", token: "test-token" });
  const firstPrompt = api.threads.get("new-1").lastPrompt;
  expect(firstPrompt).not.toContain("task-specific context");
  expect(firstPrompt).toContain(join(cwd, "AGENTS.md"));
  expect(firstPrompt).not.toContain("CODEBUDDY.md");
  expect(firstPrompt).toContain("uses this task's identity");
  expect(firstPrompt).toContain("issue comment list <issue-id> --roots-only --summary --output json");
  expect(firstPrompt.replaceAll(/`[^`]*`/g, "")).not.toMatch(/\b(?:agent|worker)s?\b/i);
  expect(rotated.stdout).toContain('"session_id":"new-1"');
  expect(api.requests.some((request) => request.path === "/api/projects")).toBe(false);

  api.threads.set("recent", {
    id: "recent", status: "open", turnState: "idle",
    createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000 + 60_000).toISOString(), messages: [],
  });
  const resumed = await runBridge({ url: api.url, stateDir, cwd, resume: "recent", prompt: "follow-up", token: "test-token" });
  const secondPrompt = api.threads.get("recent").lastPrompt;
  expect(secondPrompt).not.toContain("task-specific context");
  expect(secondPrompt).toContain(join(cwd, "AGENTS.md"));
  expect(secondPrompt).toContain("uses this task's identity");
  expect(secondPrompt.replaceAll(/`[^`]*`/g, "")).not.toMatch(/\b(?:agent|worker)s?\b/i);
  expect(resumed.stdout).toContain('"session_id":"recent"');
  expect(readFileSync(bridgeState, "utf8")).toContain('"thread_id":"recent"');
  expect(readFileSync(orchestratorState, "utf8")).toBe(updatedOrchestratorState);
});

test("launch ID authenticates model discovery and task APIs, and a restarted bridge uses the new ID", async () => {
  const api = await fixtureServer({ launchIDs: new Set(["launch-one", "launch-two"]) });
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-auth-test-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const catalog = await runBridge({ url: api.url, stateDir, cwd, launchID: "launch-one", listModels: true });
  expect(JSON.parse(catalog.stdout).models).toEqual([{ id: "model-a", name: "Model A", provider: "freebuff" }]);
  expect(api.requests.filter((request) => request.path === "/api/auth/status" || request.path === "/api/events").every((request) => request.launchID === "launch-one")).toBe(true);

  await runBridge({ url: api.url, stateDir, cwd, launchID: "launch-one" });
  const beforeRestart = api.requests.length;
  await runBridge({ url: api.url, stateDir, cwd, launchID: "launch-two", prompt: "after restart" });
  const restartedRequests = api.requests.slice(beforeRestart);
  expect(restartedRequests.length).toBeGreaterThan(0);
  expect(restartedRequests.every((request) => request.launchID === "launch-two")).toBe(true);
  expect(restartedRequests.some((request) => request.path === "/api/thread/new-1/message")).toBe(true);
  expect(readFileSync(join(stateDir, "bridge-state.json"), "utf8")).not.toContain("launch-two");
});

test("account bridge caches stay isolated", async () => {
  const api = await fixtureServer();
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-accounts-test-"));
  scratchDirs.push(dir);
  const cwd = join(dir, "task");
  const accountA = join(dir, "account-a");
  const accountB = join(dir, "account-b");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(accountA, { recursive: true });
  mkdirSync(accountB, { recursive: true });

  await runBridge({ url: api.url, stateDir: accountA, cwd });
  expect(api.threads.get("new-1").lastPrompt).toContain("Your final answer text IS the deliverable");
  expect(api.threads.get("new-1").lastPrompt.replaceAll(/`[^`]*`/g, "")).not.toMatch(/\b(?:agent|worker)s?\b/i);
  await runBridge({ url: api.url, stateDir: accountB, cwd, prompt: "Preserve agent and worker as user text" });
  expect(api.threads.get("new-2").lastPrompt).toContain("Preserve agent and worker as user text");
  const stateA = JSON.parse(readFileSync(join(accountA, "bridge-state.json"), "utf8"));
  const stateB = JSON.parse(readFileSync(join(accountB, "bridge-state.json"), "utf8"));
  expect(stateA.thread_id).toBe("new-1");
  expect(stateB.thread_id).toBe("new-2");
});
