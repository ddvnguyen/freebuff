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

function fixtureServer({ launchIDs, onRequest = () => {}, refusal = null, threadFields = {}, pollScript = null, echoUserText = false } = {}) {
  const requests = [];
  const threads = new Map();
  const queueBodies = [];
  let sequence = 0;
  let getCount = 0;
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
      if (refusal && (refusal === "always" || (refusal === "poll" && ++getCount >= 1))) {
        return json({ thread: { ...thread, lastTurnOutcome: "prompt_policy_refused: Driven by another agent" }, messages: [] });
      }
      if (pollScript) thread.turnState = pollScript(getCount++, thread);
      return json({ thread: { pendingWorkCount: 0, ...threadFields, ...thread }, messages: thread.messages || [] });
    }
    if (req.method === "GET" && url.pathname.endsWith("/mission-receipts")) {
      return json({ receipts: [] });
    }
    if (req.method === "POST" && url.pathname === "/api/threads") {
      const id = `new-${++sequence}`;
      threads.set(id, { id, status: "open", turnState: "idle", createdAt: new Date().toISOString(), messages: [] });
      return json({ id });
    }
    const actionMatch = url.pathname.match(/^\/api\/thread\/([^/]+)\/(stop|queue\/pause)$/);
    if (req.method === "POST" && actionMatch) {
      const thread = threads.get(decodeURIComponent(actionMatch[1]));
      if (thread) thread[actionMatch[2] === "stop" ? "stopped" : "paused"] = true;
      return json({ ok: true });
    }
    const queueMatch = url.pathname.match(/^\/api\/thread\/([^/]+)\/queue$/);
    if (req.method === "POST" && queueMatch) {
      const thread = threads.get(decodeURIComponent(queueMatch[1]));
      const message = JSON.parse(body);
      queueBodies.push(message);
      thread.messages = echoUserText
        ? [{ role: "user", parts: [{ kind: "text", text: message.text }] },
           { role: "assistant", parts: [{ kind: "text", text: "done" }] }]
        : [{ role: "assistant", parts: [{ kind: "text", text: "done" }] }];
      thread.lastPrompt = message.text;
      return json({ id: `item-${queueBodies.length}` });
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
    resolveListen({ requests, threads, queueBodies, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

function runBridge({ url, stateDir, cwd, resume, prompt = "do the task", launchID, listModels = false, env = {} }) {
  return new Promise((resolveRun, reject) => {
    const args = listModels ? [bridge, "--list-models", "--json"] : [bridge, "--output-format", "stream-json", "--input-format", "stream-json"];
    if (resume) args.push("--resume", resume);
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, FREEBUFF_DESKTOP_URL: url, FREEBUFF_DESKTOP_STATE_DIR: stateDir, FREEBUFF_DESKTOP_POLL_MS: "150", FREEBUFF_IDLE_SECS: "1", ...(launchID ? { FREEBUFF_DESKTOP_LAUNCH_ID: launchID } : {}), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ stdout, stderr, code }));
    if (!listModels) child.stdin.end(JSON.stringify({ type: "user", message: { content: prompt } }) + "\n");
  });
}

function expectBridgeOk(r) {
  if (r.code !== 0) throw new Error(`bridge exited ${r.code}: ${r.stderr}`);
  return r;
}

test("expired resume rotates to a fresh thread with task context; valid resume keeps task identity without reinjecting context", async () => {
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-test-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "CODEBUDDY.md"), "task-specific context");
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
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), messages: [],
  });

  const rotated = expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, resume: "expired", env: { FREEBUFF_STARTER_SEED: "s1", FREEBUFF_IDLE_SECS: "1" } }));
  expect(api.queueBodies.length).toBe(3);
  expect(api.queueBodies[0].mission).toBeUndefined();
  expect(api.queueBodies[0].text).toContain("Multica");
  expect(api.queueBodies[1].mission).toBeUndefined();
  expect(api.queueBodies[1].text).toContain("Context before I give the task");
  expect(api.queueBodies[2].mission).toEqual({ prompt: api.queueBodies[2].text, effort: 3 });
  const firstPrompt = api.threads.get("new-1").lastPrompt;
  expect(firstPrompt).toContain("task-specific context");
  expect(firstPrompt).toContain("pre-authenticated as this agent for this task");
  expect(rotated.stdout).toContain('"session_id":"new-1"');
  expect(api.requests.some((request) => request.path === "/api/projects")).toBe(false);
  expect(api.requests.some((request) => request.path === "/api/thread/new-1/message")).toBe(false);

  api.threads.set("recent", {
    id: "recent", status: "open", turnState: "idle",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000 + 60_000).toISOString(), messages: [],
  });
  const queueBefore = api.queueBodies.length;
  const resumed = expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, resume: "recent", prompt: "follow-up", env: { FREEBUFF_IDLE_SECS: "1" } }));
  expect(api.queueBodies.length).toBe(queueBefore + 1);
  expect(api.queueBodies[api.queueBodies.length - 1].mission).toBeUndefined();
  const secondPrompt = api.threads.get("recent").lastPrompt;
  expect(secondPrompt).not.toContain("task-specific context");
  expect(secondPrompt).toContain("pre-authenticated as this agent for this task");
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

  expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, launchID: "launch-one", env: { FREEBUFF_IDLE_SECS: "1" } }));
  const beforeRestart = api.requests.length;
  expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, launchID: "launch-two", prompt: "after restart", env: { FREEBUFF_IDLE_SECS: "1" } }));
  const restartedRequests = api.requests.slice(beforeRestart);
  expect(restartedRequests.length).toBeGreaterThan(0);
  expect(restartedRequests.every((request) => request.launchID === "launch-two")).toBe(true);
  expect(restartedRequests.some((request) => request.path === "/api/thread/new-1/queue")).toBe(true);
  expect(restartedRequests.some((request) => request.path === "/api/thread/new-1/message")).toBe(false);
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
  await runBridge({ url: api.url, stateDir: accountB, cwd });
  const stateA = JSON.parse(readFileSync(join(accountA, "bridge-state.json"), "utf8"));
  const stateB = JSON.parse(readFileSync(join(accountB, "bridge-state.json"), "utf8"));
  expect(stateA.thread_id).toBe("new-1");
  expect(stateB.thread_id).toBe("new-2");
});

test("M-563: seeded starter pick is stable per seed and logged", async () => {
  const api = await fixtureServer();
  const mk = (name) => {
    const dir = mkdtempSync(join(scratchRoot, name));
    scratchDirs.push(dir);
    const stateDir = join(dir, "account-state");
    const cwd = join(dir, "task");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    return { stateDir, cwd };
  };
  const a = mk("freebuff-bridge-seed-a-");
  const b = mk("freebuff-bridge-seed-b-");
  const ra = expectBridgeOk(await runBridge({ url: api.url, ...a, env: { FREEBUFF_STARTER_SEED: "same-seed", FREEBUFF_IDLE_SECS: "1" } }));
  const rb = expectBridgeOk(await runBridge({ url: api.url, ...b, env: { FREEBUFF_STARTER_SEED: "same-seed", FREEBUFF_IDLE_SECS: "1" } }));
  const idxA = ra.stderr.match(/starter=(\d+)/)?.[1];
  const idxB = rb.stderr.match(/starter=(\d+)/)?.[1];
  expect(idxA).toBeDefined();
  expect(idxA).toBe(idxB);
  expect(api.queueBodies[0].text).toBe(api.queueBodies[3].text);
  const rc = mk("freebuff-bridge-seed-c-");
  const r2 = expectBridgeOk(await runBridge({ url: api.url, ...rc, env: { FREEBUFF_STARTER_SEED: "other-seed", FREEBUFF_IDLE_SECS: "1" } }));
  const idxC = r2.stderr.match(/starter=(\d+)/)?.[1];
  expect(idxC).toBeDefined();
});

test("M-563: thread reuse cutoff is 2h — a 3h-old thread rotates", async () => {
  const api = await fixtureServer();
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-cutoff-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(stateDir, "bridge-state.json"), JSON.stringify({ thread_id: "old" }));
  api.threads.set("old", {
    id: "old", status: "open", turnState: "idle",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), messages: [],
  });
  const r = expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, resume: "old", env: { FREEBUFF_IDLE_SECS: "1" } }));
  expect(r.stdout).toContain('"session_id":"new-1"');
  expect(api.queueBodies.length).toBe(3);
});

test("M-563: idle end waits out running and stops after the threshold", async () => {
  const api = await fixtureServer({ pollScript: (n) => (n === 0 ? "running" : "idle"), threadFields: { pendingWorkCount: 0 } });
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-idle-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const t0 = Date.now();
  expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, env: { FREEBUFF_IDLE_SECS: "1", FREEBUFF_DESKTOP_POLL_MS: "150" } }));
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeGreaterThanOrEqual(900);
  expect(elapsed).toBeLessThan(30_000);
});

test("M-563: refusal hard-stops with exit 3 and never posts the task", async () => {
  const api = await fixtureServer({ refusal: "poll" });
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-refusal-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  api.threads.set("refused", { id: "refused", status: "open", turnState: "idle", createdAt: new Date().toISOString(), messages: [] });
  const r = await runBridge({ url: api.url, stateDir, cwd, resume: "refused", env: { FREEBUFF_IDLE_SECS: "60" } });
  expect(r.code).toBe(3);
  expect(r.stdout).toContain("prompt_policy_refused");
  expect(r.stderr).toContain("HARD STOP");
  expect(api.queueBodies.length).toBe(0);
  expect(api.requests.filter((q) => q.method === "POST" && q.path.endsWith("/message")).length).toBe(0);
  const thread = api.threads.get("refused");
  expect(thread.stopped).toBe(true);
  expect(thread.paused).toBe(true);
});

test("M-563: task text mentioning prompt_policy_refused is not a refusal", async () => {
  const api = await fixtureServer({ echoUserText: true });
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-falsepos-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const r = expectBridgeOk(await runBridge({
    url: api.url, stateDir, cwd, prompt: "handle prompt_policy_refused gracefully per the policy doc",
    env: { FREEBUFF_IDLE_SECS: "1" },
  }));
  expect(r.code).toBe(0);
  expect(r.stdout).not.toContain("prompt_policy_refused");
  expect(r.stderr).not.toContain("HARD STOP");
  expect(api.queueBodies.length).toBe(3);
  expect(api.queueBodies[2].text).toContain("prompt_policy_refused");
});

test("M-563: idle end stops the session (stop + queue/pause)", async () => {
  const api = await fixtureServer({ pollScript: () => "idle", threadFields: { pendingWorkCount: 0 } });
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-idlestop-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  expectBridgeOk(await runBridge({ url: api.url, stateDir, cwd, env: { FREEBUFF_IDLE_SECS: "1" } }));
  const thread = api.threads.get("new-1");
  expect(thread.stopped).toBe(true);
  expect(thread.paused).toBe(true);
});

test("M-563: starter names real repo via FREEBUFF_REPO and issue via FREEBUFF_ISSUE", async () => {
  const api = await fixtureServer();
  const dir = mkdtempSync(join(scratchRoot, "freebuff-bridge-repo-"));
  scratchDirs.push(dir);
  const stateDir = join(dir, "account-state");
  const cwd = join(dir, "task");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  expectBridgeOk(await runBridge({
    url: api.url, stateDir, cwd,
    env: { FREEBUFF_IDLE_SECS: "1", FREEBUFF_REPO: "multica-x", FREEBUFF_ISSUE: "M-563", FREEBUFF_STARTER_SEED: "repo-seed" },
  }));
  expect(api.queueBodies[0].text).toContain("`multica-x`");
  expect(api.queueBodies[0].text).toContain("M-563");
  expect(api.queueBodies[0].text).not.toContain("{REPO}");
  expect(api.queueBodies[0].text).not.toContain("{ISSUE}");
});
