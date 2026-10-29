/** Production stdio entrypoints, isolated home, fake OAuth server/browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, "bridge fixture timed out"); await wait(25); }
}

async function fixture(t, twin, { slow = false, cimd = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "web-auth-bridge-"));
  const tokenDir = join(home, ".github-webhook-mcp");
  await mkdir(tokenDir);
  const tokenFile = join(tokenDir, "oauth-tokens.json");
  const browserFile = join(home, "browser.log");
  const preload = join(home, "sandbox.cjs");
  await writeFile(preload, `const os=require('node:os'), cp=require('node:child_process'), fs=require('node:fs');
const spawn=cp.spawn;
os.homedir=()=>${JSON.stringify(home)};
cp.spawn=(command,args)=>{ if(['esbuild','esbuild.exe'].includes(require('node:path').basename(command))) return spawn(command,args);
fs.appendFileSync(${JSON.stringify(browserFile)}, JSON.stringify({pid:process.pid,command,args})+'\\n');
const child=new(require('node:events').EventEmitter)(); child.unref=()=>{}; return child; };
const fetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{ if(new URL(new Request(input,init).url).hostname!=='127.0.0.1') throw new Error('non-fixture network forbidden'); return fetch(input,init); };
require('node:module').syncBuiltinESMExports();`);
  const state = { discovery: 0, registration: 0, polls: [], refreshes: [], approve: false, malformed: false, started: Date.now() };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/oauth-authorization-server") {
      state.discovery++;
      if (slow) { while (!res.destroyed) await wait(20); return; }
      res.end(JSON.stringify({ authorization_endpoint: `${workerUrl}/authorize`,
        token_endpoint: `${workerUrl}/oauth/token`, registration_endpoint: `${workerUrl}/register`,
        // The issuer is never fetched by the bridge; it only names the https
        // origin the Worker serves the bridge's metadata document from.
        ...(cimd ? { issuer: "https://worker.example", client_id_metadata_document_supported: true } : {}) }));
    } else if (req.url === "/register") {
      state.registration++;
      res.end(JSON.stringify({ client_id: "synthetic-client", grant_types: [
        "urn:ietf:params:oauth:grant-type:web_authorization_poll", "refresh_token"] }));
    } else if (req.url === "/oauth/token") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        state.refreshes.push({ client_id: params.get("client_id"), refresh_token: params.get("refresh_token") });
        res.end(JSON.stringify({ access_token: "synthetic-bridge-access", refresh_token: "synthetic-bridge-refresh", expires_in: 3600 }));
        return;
      }
      state.polls.push({ grant: params.get("grant_type"), state: params.get("state"), client_id: params.get("client_id") });
      if (state.malformed) { res.end("{}"); return; }
      if (!state.approve) { res.writeHead(400).end(JSON.stringify({ error: "authorization_pending" })); return; }
      res.end(JSON.stringify({ access_token: "synthetic-bridge-access", refresh_token: "synthetic-bridge-refresh", expires_in: 3600 }));
    } else if (req.url === "/mcp") {
      const rpc = JSON.parse(body);
      const result = rpc.method === "server/discover"
        ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
        : { resultType: "complete", content: [{ type: "text", text: JSON.stringify({ pending_count: 0, types: {}, latest_received_at: null }) }] };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } else res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const workerUrl = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  async function bridge() {
    const root = resolve(import.meta.dirname, "../..");
    const args = ["--require", preload];
    if (twin) args.push("--import", pathToFileURL(join(root, "local-mcp/node_modules/tsx/dist/loader.mjs")).href);
    args.push(join(root, twin ? "local-mcp/src/index.ts" : "mcp-server/server/index.js"));
    const transport = new StdioClientTransport({ command: process.execPath, args, stderr: "pipe",
      env: { WEBHOOK_WORKER_URL: workerUrl, WEBHOOK_CHANNEL: "0", WEBHOOK_OBSERVER: "0" } });
    let stderr = "";
    transport.stderr.on("data", (chunk) => { stderr += chunk; });
    const client = new Client({ name: "web-auth-contract", version: "1.0.0" });
    clients.push({ client, transport, stderr: () => stderr });
    await client.connect(transport);
    return () => client.callTool({ name: "get_pending_status", arguments: {} });
  }
  t.after(async () => {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const child of clients) {
      assert.ok(!child.stderr().includes("synthetic-bridge-access"));
      assert.ok(!child.stderr().includes("synthetic-bridge-refresh"));
      assert.ok(!child.stderr().includes("unhandledRejection"));
    }
    await rm(home, { recursive: true, force: true });
  });
  return { bridge, state, tokenFile, tokenDir, browsers: async () =>
    (await readFile(browserFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean) };
}

for (const twin of process.env.WEBHOOK_TEST_TWIN === "1" ? [false, true] : [false]) {
  const label = twin ? "development twin" : "published bridge";
  test(`${label}: three stdio bridges return shared pending immediately and all resume after approval`, async (t) => {
    const f = await fixture(t, twin);
    const calls = await Promise.all([f.bridge(), f.bridge(), f.bridge()]);
    const started = Date.now();
    const results = await Promise.all(calls.map((call) => call()));
    assert.ok(Date.now() - started < 5000, "tool waited for the 600s approval poll");
    for (const result of results) assert.equal(result.isError, true);
    const urls = results.map((result) => result.content[0].text.match(/Open this URL in your browser: (\S+)/)[1]);
    assert.equal(new Set(urls).size, 1);
    assert.equal(f.state.discovery, 1);
    assert.equal(f.state.registration, 1);
    assert.equal((await f.browsers()).length, 1);
    assert.ok(results.every((result) => /retry the same tool call/.test(result.content[0].text)));
    const repeated = await calls[1]();
    assert.ok(repeated.content[0].text.includes(urls[0]));
    f.state.approve = true;
    await until(async () => JSON.parse(await readFile(f.tokenFile, "utf8").catch(() => "null"))?.web_auth);
    await wait(250);
    const completed = await Promise.all(calls.map((call) => call()));
    for (const result of completed) assert.ok(!result.isError, JSON.stringify(result).replace(/synthetic-bridge-(access|refresh)/g, "[redacted]"));
    assert.equal(new Set(f.state.polls.map((poll) => poll.state)).size, 1);
    assert.equal((await f.browsers()).length, 1);
  });

  test(`${label}: failed polling releases the in-process promise and a later tool retries`, async (t) => {
    const f = await fixture(t, twin);
    const call = await f.bridge();
    f.state.malformed = true;
    const first = await call();
    assert.equal(first.isError, true);
    await until(() => f.state.polls.length > 0);
    await wait(150);
    f.state.malformed = false;
    const retry = await call();
    assert.equal(retry.isError, true);
    await until(async () => (await f.browsers()).length === 2);
    assert.notEqual(retry.content[0].text, first.content[0].text);
    f.state.approve = true;
    await until(async () => JSON.parse(await readFile(f.tokenFile, "utf8").catch(() => "null"))?.web_auth);
    assert.ok(!(await call()).isError);
  });
}

const CIMD_CLIENT_ID = "https://worker.example/oauth/client-metadata.json";
const POLL_GRANT = "urn:ietf:params:oauth:grant-type:web_authorization_poll";
const readJson = async (file) => JSON.parse(await readFile(file, "utf8").catch(() => "null"));

for (const twin of process.env.WEBHOOK_TEST_TWIN === "1" ? [false, true] : [false]) {
  const label = twin ? "development twin" : "published bridge";
  test(`${label}: a CIMD-advertising Worker gets the metadata-document client_id and no registration`, async (t) => {
    const f = await fixture(t, twin, { cimd: true });
    const call = await f.bridge();
    const pending = await call();
    assert.equal(pending.isError, true);
    const url = new URL(pending.content[0].text.match(/Open this URL in your browser: (\S+)/)[1]);
    assert.equal(url.searchParams.get("client_id"), CIMD_CLIENT_ID);
    await until(() => f.state.polls.length > 0);
    assert.ok(f.state.polls.every((poll) => poll.client_id === CIMD_CLIENT_ID));
    f.state.approve = true;
    await until(async () => (await readJson(f.tokenFile))?.web_auth);
    assert.equal((await readJson(f.tokenFile)).client_id, CIMD_CLIENT_ID);
    assert.equal(f.state.registration, 0);
    assert.equal(await readJson(join(f.tokenDir, "oauth-client.json")), null, "no DCR registration is saved");
    assert.ok(!(await call()).isError);
  });

  test(`${label}: a Worker without CIMD support falls back to dynamic client registration`, async (t) => {
    const f = await fixture(t, twin);
    const call = await f.bridge();
    const pending = await call();
    const url = new URL(pending.content[0].text.match(/Open this URL in your browser: (\S+)/)[1]);
    assert.equal(url.searchParams.get("client_id"), "synthetic-client");
    assert.equal(f.state.registration, 1);
    f.state.approve = true;
    await until(async () => (await readJson(f.tokenFile))?.web_auth);
    assert.equal((await readJson(f.tokenFile)).client_id, "synthetic-client");
    assert.ok(f.state.polls.every((poll) => poll.client_id === "synthetic-client"));
  });

  for (const [name, saved, expected] of [
    ["pre-#254 tokens refresh with the saved DCR registration", undefined, "legacy-dcr-client"],
    ["CIMD-issued tokens refresh with their metadata-document client_id", CIMD_CLIENT_ID, CIMD_CLIENT_ID],
  ]) {
    test(`${label}: ${name}`, async (t) => {
      const f = await fixture(t, twin, { cimd: true });
      await writeFile(join(f.tokenDir, "oauth-client.json"), JSON.stringify({
        client_id: "legacy-dcr-client", grant_types: [POLL_GRANT, "refresh_token"] }));
      await writeFile(f.tokenFile, JSON.stringify({ flow: "web", ...(saved ? { client_id: saved } : {}),
        access_token: "synthetic-stale-access", refresh_token: "synthetic-seed-refresh", expires_at: 1 }));
      const call = await f.bridge();
      const result = await call();
      assert.ok(!result.isError, JSON.stringify(result).replace(/synthetic-bridge-(access|refresh)/g, "[redacted]"));
      assert.deepEqual(f.state.refreshes, [{ client_id: expected, refresh_token: "synthetic-seed-refresh" }]);
      assert.equal((await readJson(f.tokenFile)).client_id, expected);
      assert.equal(f.state.registration, 0);
      assert.equal((await f.browsers()).length, 0);
    });
  }
}

test("published bridge keeps the 15s phase-1 limit when discovery is stalled", { timeout: 25_000 }, async (t) => {
  const f = await fixture(t, false, { slow: true });
  const call = await f.bridge();
  const started = Date.now();
  const result = await call();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 14_500 && elapsed < 18_000, "phase-1 deadline changed");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not produce an authorize URL in time/);
  assert.equal((await f.browsers()).length, 0);
});
