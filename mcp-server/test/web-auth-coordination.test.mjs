import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinateWebAuth, webAuthScope, WEB_AUTH_START_MS, WEB_AUTH_LIFETIME_MS } from "../server/web-auth-coordinator.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, "coordination fixture timed out"); await wait(20); }
}

async function fixture(t) {
  const storage = await mkdtemp(join(tmpdir(), "web-auth-coordination-"));
  const state = { starts: 0, browsers: 0, release: new Set(), deny: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/start") {
      if (state.deny) { res.writeHead(503).end("{}"); return; }
      const id = ++state.starts;
      res.end(JSON.stringify({ id, authorize_url: `${workerUrl}/authorize?state=${id}` }));
    } else if (url.pathname === "/browser") {
      state.browsers++;
      res.end("{}");
    } else if (url.pathname === "/poll") {
      const id = Number(url.searchParams.get("id"));
      while (!state.release.has(id) && !res.destroyed) await wait(20);
      if (!res.destroyed) res.end(JSON.stringify({ flow: "web", access_token: `synthetic-access-${id}`,
        refresh_token: `synthetic-refresh-${id}`, expires_at: Date.now() + 3_600_000 }));
    } else res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const workerUrl = `http://127.0.0.1:${server.address().port}`;
  const children = [];
  function child(extra = {}) {
    const process = fork(new URL("./fixtures/coordination-child.mjs", import.meta.url), [], {
      env: { ...globalThis.process.env, COORDINATION_TEST_OPTIONS: JSON.stringify({ workerUrl,
        tokenDir: storage, startMs: 2000, lifetimeMs: 5000, settleMs: 500, ...extra }) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const messages = [];
    process.on("message", (message) => messages.push(message));
    const result = { process, messages, has: (type) => messages.some((message) => message.type === type),
      get: (type) => messages.find((message) => message.type === type) };
    children.push(result);
    return result;
  }
  t.after(async () => {
    for (const child of children) child.process.kill();
    await Promise.all(children.map(({ process }) => process.exitCode !== null || process.signalCode !== null ? null :
      new Promise((resolve) => process.once("exit", resolve))));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(storage, { recursive: true, force: true });
  });
  return { storage, state, workerUrl, child, identity: await webAuthScope(workerUrl, storage) };
}

test("three Node processes share one pending flow and validated disk completion; IPC is private", async (t) => {
  const f = await fixture(t);
  // A valid-looking but unrelated cached credential is not completion proof.
  await writeFile(f.identity.tokenFile, JSON.stringify({ flow: "web", access_token: "stale",
    web_auth: { scope: "other", generation: "old" } }));
  const children = [f.child(), f.child(), f.child()];
  await until(() => children.every((child) => child.has("pending")));
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.browsers, 1);
  assert.equal(children.filter((child) => child.has("owner")).length, 1);
  const pending = children[0].get("pending").pending;
  for (const child of children) {
    assert.deepEqual(child.get("pending").pending, pending);
    assert.equal(child.has("complete"), false);
  }
  const record = JSON.parse(await readFile(f.identity.recordFile, "utf8"));
  assert.ok(!JSON.stringify(record).includes("synthetic-"));
  for (const capability of [undefined, "0".repeat(64), "e".repeat(63)]) {
    const response = await fetch(`http://127.0.0.1:${record.port}/status`, {
      method: "POST", headers: capability ? { "x-web-auth-capability": capability } : {},
    });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "");
  }
  const status = await (await fetch(`http://127.0.0.1:${record.port}/status`, {
    method: "POST", headers: { "x-web-auth-capability": record.capability },
  })).json();
  assert.equal(status.pending.authorize_url, pending.authorize_url);
  assert.ok(!JSON.stringify(status).includes("synthetic-"));
  if (process.platform !== "win32") assert.equal((await stat(f.identity.recordFile)).mode & 0o777, 0o600);
  f.state.release.add(1);
  await until(() => children.every((child) => child.has("complete")));
  assert.equal(new Set(children.map((child) => child.get("complete").generation)).size, 1);
  assert.equal(f.state.starts, 1);
});

test("different targets and storage directories do not join pending flows", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const a = f.child();
  const b = f.child({ workerUrl: other.workerUrl });
  const c = f.child({ tokenDir: other.storage });
  await until(() => [a, b, c].every((child) => child.has("pending")));
  assert.equal(f.state.starts, 2);
  assert.equal(other.state.starts, 1);
  assert.notEqual(a.get("pending").pending.authorize_url, b.get("pending").pending.authorize_url);
});

test("owner death releases kernel ownership and two waiters elect one replacement", async (t) => {
  const f = await fixture(t);
  const owner = f.child();
  await until(() => owner.has("pending"));
  const followers = [f.child(), f.child()];
  await until(() => followers.every((child) => child.has("pending")));
  owner.process.kill();
  await until(() => f.state.browsers === 2);
  f.state.release.add(2);
  await until(() => followers.every((child) => child.has("complete")));
  assert.equal(f.state.starts, 2);
  assert.equal(new Set(followers.map((child) => child.get("complete").generation)).size, 1);
});

test("expiry fences an old callback and cannot overwrite or clean a successor generation", async (t) => {
  const f = await fixture(t);
  const old = f.child({ lifetimeMs: 350, ignoreAbort: true });
  await until(() => old.has("pending"));
  await until(() => old.has("error"));
  const next = f.child();
  await until(() => f.state.browsers === 2);
  f.state.release.add(2);
  await until(() => next.has("complete"));
  const saved = await readFile(f.identity.tokenFile, "utf8");
  const record = await readFile(f.identity.recordFile, "utf8");
  f.state.release.add(1);
  await until(() => old.has("stale-rejected"));
  assert.equal(await readFile(f.identity.tokenFile, "utf8"), saved);
  assert.equal(await readFile(f.identity.recordFile, "utf8"), record);
});

test("partial/corrupt records recover without another owner while a healthy listener holds the scope", async (t) => {
  const f = await fixture(t);
  await writeFile(f.identity.recordFile, '{"partial":');
  const a = f.child();
  await until(() => a.has("pending"));
  await writeFile(f.identity.recordFile, '{"partial":');
  const b = f.child();
  const c = f.child();
  await until(() => [b, c].every((child) => child.has("pending")));
  assert.equal(f.state.starts, 1);
  f.state.release.add(1);
  await until(() => [a, b, c].every((child) => child.has("complete")));
});

test("unknown listener fails closed boundedly without discovery/browser or fallback port", async (t) => {
  const f = await fixture(t);
  const unknown = createServer((_req, res) => res.writeHead(403).end());
  await new Promise((resolve) => unknown.listen(f.identity.port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => unknown.close(resolve)));
  const c = f.child({ startMs: 300 });
  await until(() => c.has("error"));
  assert.equal(c.has("owner"), false);
  assert.equal(f.state.starts, 0);
});

test("acquisition failure releases ownership for a later call", async (t) => {
  const f = await fixture(t);
  f.state.deny = true;
  const first = f.child();
  await until(() => first.has("error"));
  f.state.deny = false;
  const second = f.child();
  await until(() => second.has("pending"));
  f.state.release.add(1);
  await until(() => second.has("complete"));
});

test("completion rejects stale, cross-scope and cross-generation credentials", async (t) => {
  const f = await fixture(t);
  const owner = f.child();
  await until(() => owner.has("pending"));
  f.state.release.add(1);
  await until(() => owner.has("complete"));
  const record = JSON.parse(await readFile(f.identity.recordFile, "utf8"));
  for (const marker of [{ scope: "other", generation: record.generation },
    { scope: record.scope, generation: "old" }, undefined]) {
    await writeFile(f.identity.tokenFile, JSON.stringify({ flow: "web", access_token: "stale", web_auth: marker }));
    await writeFile(f.identity.recordFile, JSON.stringify({ ...record, completed_at: Date.now() + 1000 }));
    await assert.rejects(coordinateWebAuth({ workerUrl: f.workerUrl, tokenDir: f.storage,
      runOwner: async () => { throw new Error("unexpected owner"); }, onPending() {} }), /completion did not match/);
  }
  assert.equal(WEB_AUTH_START_MS, 15_000);
  assert.equal(WEB_AUTH_LIFETIME_MS, 600_000);
});
