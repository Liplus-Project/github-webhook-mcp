import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const META = "io.github.Liplus-Project/github-webhook-mcp/pending-status-observer";
const SECRET = "observer-test-secret-access";
const REFRESH = "observer-test-secret-refresh";
const raw = (count) => ({ pending_count: count, types: count ? { issues: count } : {}, latest_received_at: count ? "2026-10-19T00:00:00Z" : null });
const toolResult = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for bridge state");
    await wait(20);
  }
}

async function fixture(t, { twin = false, observer = true, channel = false, tokens, reject = false, wsReject = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "webhook-observer-"));
  const tokenDir = join(home, ".github-webhook-mcp");
  await mkdir(tokenDir);
  const tokenFile = join(tokenDir, "oauth-tokens.json");
  const save = async (value) => writeFile(tokenFile, typeof value === "string" ? value : JSON.stringify(value));
  if (tokens !== undefined) await save(tokens);
  const forbidden = join(home, "forbidden.log");
  const auditFile = join(home, "audit.jsonl");
  const fixtureId = randomUUID();
  // Sandbox the real entrypoint's home before any token read; forbid browser spawn.
  const preload = join(home, "sandbox.cjs");
  await writeFile(preload, `const os = require('node:os'); const cp = require('node:child_process'); const spawn = cp.spawn;
const fs = require('node:fs'); const fsp = require('node:fs/promises'); const readFile = fsp.readFile;
const audit = (data) => fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify(data) + '\\n');
fsp.readFile = async (file, ...args) => {
  let data;
  try { data = await readFile(file, ...args); } catch (err) { if (file === ${JSON.stringify(tokenFile)}) audit({op:'token-read', present:false}); throw err; }
  if (file === ${JSON.stringify(tokenFile)}) { let p; try { p = JSON.parse(data); } catch {}
    audit({op:'token-read', flow:p?.flow, tokenType:typeof p?.access_token, expiryType:typeof p?.expires_at, expiry:p?.expires_at, at:Date.now()}); }
  return data;
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => { const req = new Request(input, init); req.headers.set('x-observer-test-fixture', ${JSON.stringify(fixtureId)}); audit({op:'fetch', path:new URL(req.url).pathname, method:req.method, hasAuthorization:req.headers.has('authorization')}); return fetch(req); };
os.homedir = () => ${JSON.stringify(home)};
cp.spawn = (command, ...args) => { if (['esbuild', 'esbuild.exe'].includes(require('node:path').basename(command))) return spawn(command, ...args); require('node:fs').appendFileSync(${JSON.stringify(forbidden)}, 'spawn\\n'); throw new Error('browser disabled by test'); };
require('node:module').syncBuiltinESMExports();`);
  const state = { reject, wsReject, failure: false, holdUnauthorized: false, releaseUnauthorized: null, count: 3, calls: [], foreignCalls: [], upgrades: [], sockets: [], notifications: [] };
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : null;
    // Ephemeral ports can be reused while another client is still retrying.
    // Attribute HTTP traffic to the exact child, not just its destination port.
    if (req.headers["x-observer-test-fixture"] !== fixtureId) {
      state.foreignCalls.push({ url: req.url, method: rpc?.method, hasAuthorization: !!req.headers.authorization });
      res.writeHead(409).end("foreign test fixture");
      return;
    }
    state.calls.push({ url: req.url, method: rpc?.method, tool: rpc?.params?.name, args: rpc?.params?.arguments, authorization: req.headers.authorization });
    if (state.holdUnauthorized && rpc?.method === "tools/call" && req.headers.authorization === `Bearer ${SECRET}`) {
      await new Promise((resolve) => { state.releaseUnauthorized = resolve; });
      res.writeHead(401).end(SECRET);
      return;
    }
    if (state.reject) { res.writeHead(401).end(SECRET); return; }
    if (state.failure) { res.writeHead(500).end(`${SECRET} ${REFRESH}`); return; }
    if (req.url !== "/mcp") { res.writeHead(500).end("unexpected OAuth request"); return; }
    const result = rpc.method === "server/discover"
      ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : toolResult(rpc.params.name === "get_pending_status" ? raw(state.count) : { event_id: "event-1", payload: { action: "opened" } });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "tools/call" ? { ...result, resultType: "complete" } : result }));
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    state.upgrades.push(req.headers.authorization);
    if (state.wsReject) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { state.sockets.push(ws); });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const root = resolve(import.meta.dirname, "../..");
  const workerUrl = `http://127.0.0.1:${http.address().port}`;
  const args = ["--require", preload];
  if (twin) args.push("--import", pathToFileURL(join(root, "local-mcp/node_modules/tsx/dist/loader.mjs")).href);
  args.push(join(root, twin ? "local-mcp/src/index.ts" : "mcp-server/server/index.js"));
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: "pipe", env: {
    WEBHOOK_WORKER_URL: workerUrl, WEBHOOK_CHANNEL: channel ? "1" : "0", WEBHOOK_OBSERVER: observer ? "1" : "0",
  } });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "observer-contract-test", version: "1.0.0" });
  client.fallbackNotificationHandler = async (notification) => state.notifications.push(notification);
  t.after(async () => {
    state.releaseUnauthorized?.();
    await client.close();
    await transport.close();
    for (const ws of state.sockets) ws.terminate();
    wss.close();
    await new Promise((r) => http.close(r));
    const spawned = await readFile(forbidden, "utf8").catch(() => "");
    const audit = (await readFile(auditFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const outgoing = audit.filter((entry) => entry.op === "fetch");
    if (state.foreignCalls.length) t.diagnostic(`foreign fixture traffic: ${JSON.stringify(state.foreignCalls)}`);
    await rm(home, { recursive: true, force: true });
    assert.equal(spawned, "", "bridge attempted to spawn a browser");
    assert.ok(!stderr.includes(SECRET) && !stderr.includes(REFRESH), "token leaked to stderr");
    assert.equal(outgoing.length, state.calls.length, "every originating bridge fetch must be tagged and captured");
    assert.ok(outgoing.every((entry) => entry.path === "/mcp"), "bridge fetch attempted an OAuth endpoint");
    assert.ok(state.calls.every((c) => c.url === "/mcp"), "bridge attempted an OAuth endpoint");
  });
  try { await client.connect(transport); } catch (err) { throw new Error(`${err.message}: ${stderr}`); }
  return { client, state, save, workerUrl, audit: () => readFile(auditFile, "utf8").catch(() => ""), stderr: () => stderr, call: (name = "get_pending_status", args = {}) => client.callTool({ name, arguments: args }) };
}

const valid = (access = SECRET) => ({ flow: "web", access_token: access, refresh_token: REFRESH, expires_at: Date.now() + 3600_000 });
function authRequired(result) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "auth_required");
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(REFRESH));
  assert.ok(!JSON.stringify(result).includes("authorize_url"));
}

// CI exercises the distributed entrypoint. Opt in to repeat against the TS
// twin after `npm ci` in local-mcp; this does not add a CI runtime dependency.
for (const twin of process.env.WEBHOOK_TEST_TWIN === "1" ? [false, true] : [false]) {
  const label = twin ? "development twin" : "published bridge";
  test(`${label}: observer metadata and raw nonzero/zero result; get_event remains available`, async (t) => {
    const f = await fixture(t, { twin, tokens: valid() });
    const listed = await f.client.listTools();
    assert.equal(listed.tools.find((x) => x.name === "get_pending_status")._meta[META], 1);
    assert.equal(listed.tools.filter((x) => x._meta?.[META]).length, 1);
    assert.deepEqual(await f.call(), toolResult(raw(3)));
    f.state.count = 0;
    assert.deepEqual(await f.call(), toolResult(raw(0)));
    assert.deepEqual((await f.call("get_event", { event_id: "event-1" })).structuredContent.payload, { action: "opened" });
    assert.ok(f.state.calls.filter((c) => c.tool).every((c) => ["get_pending_status", "get_event"].includes(c.tool)));
  });

  for (const observer of [false, true]) {
    test(`${label}: foreground option schema and forwarding preserve ${observer ? "observer" : twin ? "normal raw" : "hook"} shape`, async (t) => {
      const f = await fixture(t, { twin, observer, tokens: valid() });
      const tools = (await f.client.listTools()).tools;
      for (const name of ["get_pending_status", "list_pending_events"]) {
        assert.deepEqual(tools.find((tool) => tool.name === name).inputSchema.properties.include_intermediate, {
          type: "boolean", default: false, description: "Include workflow_run requested/in_progress events (default false)",
        });
        await f.call(name, { include_intermediate: true });
        assert.deepEqual(f.state.calls.at(-1).args, { include_intermediate: true });
      }
      const result = await f.call("get_pending_status", { include_intermediate: false });
      assert.deepEqual(f.state.calls.at(-1).args, { include_intermediate: false });
      if (observer || twin) assert.deepEqual(result, toolResult(raw(3)));
      else assert.equal(JSON.parse(result.content[0].text).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    });
  }

  test(`${label}: missing/expired/malformed credentials are noninteractive and external login recovers`, async (t) => {
    const f = await fixture(t, { twin, channel: true });
    for (const tokens of [undefined, { ...valid(), expires_at: Date.now() - 1 }, "{bad-json", { ...valid(), access_token: 42 }, { ...valid(), expires_at: "invalid" }, { ...valid(), flow: "device" }]) {
      if (tokens !== undefined) await f.save(tokens);
      authRequired(await f.call());
      assert.equal(f.state.calls.length, 0, await f.audit());
    }
    assert.equal(f.state.calls.length, 0, JSON.stringify(f.state.calls.map(({ url, method, tool }) => ({ url, method, tool }))));
    assert.equal(f.state.upgrades.length, 0);
    await f.save(valid());
    assert.deepEqual(await f.call(), toolResult(raw(3)));
    await until(() => f.state.sockets.length === 1);
  });

  test(`${label}: initial expired token does not start WS or refresh`, async (t) => {
    const f = await fixture(t, { twin, channel: true, tokens: { ...valid(), expires_at: Date.now() - 1 } });
    authRequired(await f.call());
    await wait(150);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.upgrades.length, 0);
  });

  test(`${label}: foreign client traffic cannot be mistaken for missing-token bridge traffic`, async (t) => {
    const f = await fixture(t, { twin, channel: true });
    const foreign = await fetch(`${f.workerUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }) });
    assert.equal(foreign.status, 409);
    await foreign.text();
    authRequired(await f.call());
    assert.equal(f.state.foreignCalls.length, 1);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.upgrades.length, 0);
    assert.ok(!(await f.audit()).includes('"op":"fetch"'));
  });

  test(`${label}: rejected HTTP token is blocked until an external replacement`, async (t) => {
    const f = await fixture(t, { twin, tokens: valid(), reject: true });
    authRequired(await f.call());
    const before = f.state.calls.length;
    authRequired(await f.call());
    assert.equal(f.state.calls.length, before);
    f.state.reject = false;
    await f.save(valid("replacement-token"));
    assert.deepEqual(await f.call(), toolResult(raw(3)));
  });

  test(`${label}: connected HTTP 401 also returns auth_required`, async (t) => {
    const f = await fixture(t, { twin, tokens: valid() });
    await f.call();
    f.state.reject = true;
    authRequired(await f.call());
  });

  test(`${label}: a late 401 rejects its sent token without rejecting a concurrent external rotation`, async (t) => {
    const f = await fixture(t, { twin, tokens: valid() });
    await f.call();
    f.state.holdUnauthorized = true;
    const oldRequest = f.call();
    await until(() => f.state.releaseUnauthorized);
    await f.save(valid("replacement-token"));
    assert.deepEqual(await f.call(), toolResult(raw(3)));
    f.state.releaseUnauthorized();
    authRequired(await oldRequest);
    assert.deepEqual(await f.call(), toolResult(raw(3)));
  });

  test(`${label}: communication errors do not become zero or leak response secrets`, async (t) => {
    const f = await fixture(t, { twin, tokens: valid() });
    await f.call();
    f.state.failure = true;
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Failed to reach worker.");
    assert.equal(result.structuredContent, undefined);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.ok(!JSON.stringify(result).includes(REFRESH));
  });

  test(`${label}: observer accepts unexpired tokens inside normal refresh window and tokens without expiry`, async (t) => {
    const f = await fixture(t, { twin, tokens: { ...valid(), expires_at: Date.now() + 60_000 } });
    assert.deepEqual(await f.call(), toolResult(raw(3)));
    const tokens = valid();
    delete tokens.expires_at;
    await f.save(tokens);
    assert.deepEqual(await f.call(), toolResult(raw(3)));
  });

  test(`${label}: simultaneous status calls share one in-flight WebSocket`, async (t) => {
    const f = await fixture(t, { twin, channel: true });
    await f.save(valid());
    const results = await Promise.all(Array.from({ length: 8 }, () => f.call()));
    for (const result of results) assert.deepEqual(result, toolResult(raw(3)));
    await until(() => f.state.sockets.length === 1);
    await wait(150);
    assert.equal(f.state.upgrades.length, 1);
  });

  for (const rejection of [401, 1008, 4401]) {
    test(`${label}: WS ${rejection} stops auth retry and later external login restores notifications`, async (t) => {
      const f = await fixture(t, { twin, channel: true, tokens: valid(), wsReject: rejection === 401 });
      if (rejection !== 401) {
        await until(() => f.state.sockets.length === 1);
        f.state.sockets[0].close(rejection);
      }
      await until(() => f.stderr().includes("WebSocket: auth_required"));
      authRequired(await f.call());
      const before = f.state.upgrades.length;
      await wait(1200);
      assert.equal(f.state.upgrades.length, before);
      f.state.wsReject = false;
      await f.save(valid("replacement-token"));
      assert.deepEqual(await f.call(), toolResult(raw(3)));
      await until(() => f.state.upgrades.length === before + 1 && f.state.sockets.at(-1)?.readyState === 1);
      f.state.sockets.at(-1).send(JSON.stringify({ summary: { id: "notification-1", type: "issues", repo: "owner/repo", title: "test", sender: "tester", received_at: "2026-10-19T00:00:00Z" } }));
      await until(() => f.state.notifications.some((n) => n.method === "notifications/claude/channel"));
    });
  }

  test(`${label}: expired token on WS reconnect causes no refresh/browser`, async (t) => {
    const f = await fixture(t, { twin, channel: true, tokens: valid() });
    await until(() => f.state.sockets.length === 1);
    await f.save({ ...valid(), expires_at: Date.now() - 1 });
    f.state.sockets[0].close(1000);
    await until(() => f.stderr().includes("WebSocket: auth_required"));
    assert.equal(f.state.upgrades.length, 1);
    authRequired(await f.call());
  });
}

test("normal published bridge retains hook wrapping and does not advertise observer", async (t) => {
  const f = await fixture(t, { observer: false, tokens: valid() });
  assert.equal((await f.client.listTools()).tools.find((x) => x.name === "get_pending_status")._meta?.[META], undefined);
  const result = await f.call();
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext, /3 pending/);
  f.state.count = 0;
  assert.deepEqual(await f.call(), toolResult(raw(0)));
});
