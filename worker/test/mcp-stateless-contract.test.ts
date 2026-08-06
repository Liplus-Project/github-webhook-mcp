/**
 * Worker <-> bridge protocol contract (issue #249).
 *
 * The Worker's protocol revision is a private contract between the artifacts of
 * this repository: the Worker at `worker/src/` and the npx bridge at
 * `mcp-server/`. `server.json` declares stdio transport only, so no third-party
 * client reaches the Worker directly — which is exactly why nothing outside
 * this repository verifies the contract, and why it is asserted here.
 *
 * The two sides are wired to each other in-process: the bridge's real client
 * module talks to the real `createMcpHandler` wiring over a fetch that lands on
 * the handler instead of the network. The stores are faked at the DO stub
 * boundary, which is a plain fetch surface — that is what lets `tools/call` be
 * covered here, and it is the path that carries the change with the most reach:
 * tenant identity moved from an instance field on a per-tenant agent DO to the
 * props of the request being served.
 *
 * `local-mcp/src/index.ts` is the TypeScript twin of the bridge client and is
 * NOT covered here; it is the development bridge, and the published one is what
 * users run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteClient } from "../../mcp-server/server/remote-client.js";
import { createWebhookMcpServer } from "../src/mcp.js";

const ENDPOINT = "https://github-webhook.smgjp.com";

/** A grant that can read one personal store and one org store. */
const PROPS = {
  account_id: 4242,
  account_login: "smileygames",
  accessible_account_ids: [4242, 99],
};

/** One store's `/pending-status` reply, keyed by the DO name it was built from. */
const PENDING_BY_STORE: Record<string, unknown> = {
  "store-4242": {
    pending_count: 2,
    latest_received_at: "2026-08-06T09:00:00.000Z",
    types: { issues: 2 },
  },
  "store-99": {
    pending_count: 1,
    latest_received_at: "2026-08-06T11:00:00.000Z",
    types: { issues: 1, push: 1 },
  },
};

/**
 * A WEBHOOK_STORE binding whose stubs answer `/pending-status` from the table
 * above and record which DO names were reached. `idFromName` is the only place
 * tenant identity turns into a store, so recording there is what pins the
 * per-request props path.
 */
function fakeEnv(reached: string[]) {
  const namespace = {
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(request: Request) {
          reached.push(id.name);
          const body = PENDING_BY_STORE[id.name] ?? {
            pending_count: 0,
            latest_received_at: null,
            types: {},
          };
          return new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
          });
        },
      };
    },
  };
  return { WEBHOOK_STORE: namespace } as unknown as Parameters<
    typeof createWebhookMcpServer
  >[0];
}

/** The Worker's `/mcp` wiring, exactly as `index.ts` builds it. */
function workerHandler(env: ReturnType<typeof fakeEnv>) {
  return createMcpHandler(() => createWebhookMcpServer(env), {
    route: "/mcp",
    legacy: "reject",
  });
}

/**
 * A fetch that lands on the handler. The Host header is set explicitly because
 * a `Request` built in-process carries no Host of its own, and `ctx.props` is
 * what the handler republishes as the per-request auth context.
 */
function fetchInto(handler: ReturnType<typeof workerHandler>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const headers = new Headers(base.headers);
    headers.set("host", new URL(base.url).host);
    return handler(new Request(base, { headers }), {} as never, {
      props: PROPS,
    } as unknown as ExecutionContext);
  }) as typeof fetch;
}

test("serves the bridge's pinned client without a session handshake", async () => {
  const seen: Array<{
    method: string;
    sessionHeader: string | null;
    body: { method?: string; params?: { _meta?: Record<string, unknown> } } | null;
  }> = [];
  const into = fetchInto(workerHandler(fakeEnv([])));

  const recording: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const raw = await req.clone().text();
    seen.push({
      method: req.method,
      sessionHeader: req.headers.get("mcp-session-id"),
      body: raw ? JSON.parse(raw) : null,
    });
    return into(req);
  };

  const remote = createRemoteClient({
    workerUrl: ENDPOINT,
    clientVersion: "0.0.0-test",
    fetch: recording,
  });

  const client = await remote.getClient();
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t: { name: string }) => t.name).sort(),
    [
      "get_event",
      "get_pending_status",
      "get_webhook_events",
      "list_pending_events",
      "mark_processed",
    ],
  );

  // The whole exchange, connect included, is POST-only and session-free.
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "POST");
    assert.equal(call.sessionHeader, null);
  }

  // No `initialize`: connecting to a pinned modern endpoint probes with
  // `server/discover` instead of opening a session.
  const methods = seen.map((c) => c.body?.method);
  assert.ok(!methods.includes("initialize"));
  assert.equal(methods[0], "server/discover");

  // Every request carries the per-request envelope the revision requires.
  for (const call of seen) {
    const meta = call.body?.params?._meta;
    assert.equal(meta?.["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    assert.notEqual(meta?.["io.modelcontextprotocol/clientCapabilities"], undefined);
  }

  await remote.reset();
});

test("resolves tenant stores from the request's own props, not from instance state", async () => {
  const reached: string[] = [];
  const remote = createRemoteClient({
    workerUrl: ENDPOINT,
    clientVersion: "0.0.0-test",
    fetch: fetchInto(workerHandler(fakeEnv(reached))),
  });

  const client = await remote.getClient();
  const result = (await client.callTool({
    name: "get_pending_status",
    arguments: {},
  })) as { content: Array<{ type: string; text: string }> };

  // Both accessible accounts were fanned out to, and only those.
  assert.deepEqual(reached.sort(), ["store-4242", "store-99"]);

  // The merge is the same one the agent DO did — counts summed, latest wins,
  // per-type counts added.
  const merged = JSON.parse(result.content[0].text);
  assert.deepEqual(merged, {
    pending_count: 3,
    latest_received_at: "2026-08-06T11:00:00.000Z",
    types: { issues: 3, push: 1 },
  });

  await remote.reset();
});

test("rejects the pre-flip bridge instead of serving it a compatibility lane", async () => {
  const into = fetchInto(workerHandler(fakeEnv([])));

  // Byte-shape of what the pre-#249 bridge sent as its first request.
  const res = await into(`${ENDPOINT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "local-bridge", version: "1.0.0" },
      },
      id: "init",
    }),
  });

  assert.equal(res.status, 400);
  assert.equal(res.headers.get("mcp-session-id"), null);

  const body = (await res.json()) as {
    error: { code: number; data?: { supported?: string[] } };
  };
  assert.equal(body.error.code, -32022);
  // The endpoint names the one revision it serves — a single lane, stated.
  assert.deepEqual(body.error.data?.supported, ["2026-07-28"]);
});
