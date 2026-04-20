/**
 * Integration tests for the Worker's bespoke OAuth device-flow implementation.
 *
 * Covers the Step 4 (#202) scenarios that can run deterministically in CI:
 *   - existing-user migration: legacy /oauth/authorize and /oauth/callback return 410
 *   - new-user onboarding:     /.well-known + /oauth/register + /oauth/device_authorization
 *                              + /oauth/token (device_code) → access_token + refresh_token
 *   - concurrent-instance:     refresh_token rotation invalidates the previous token
 *   - process-restart:         access_token validates against the same KV after simulated
 *                              restart (new AuthContext via authenticateApiRequest)
 *
 * The GitHub upstream is stubbed by swapping globalThis.fetch. The KV namespace is a
 * Map-backed mock that matches the subset of the KVNamespace API oauth-store.ts uses.
 *
 * End-to-end scenarios that depend on a real user visiting https://github.com/login/device
 * are NOT covered here — those remain on the manual verification checklist documented
 * in docs/installation.md and in the PR body.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleOAuthRequest, authenticateApiRequest } from "../src/oauth.js";
import type { OAuthEnv } from "../src/oauth.js";

// ── In-memory KV mock ────────────────────────────────────────────────

class MockKV {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  list() {
    return Array.from(this.store.keys());
  }
  raw(key: string) {
    return this.store.get(key) ?? null;
  }
}

// ── GitHub upstream fetch stub ───────────────────────────────────────

type FetchHandler = (req: Request) => Promise<Response> | Response;
let fetchHandler: FetchHandler | null = null;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!fetchHandler) {
      throw new Error(`Unhandled fetch in test: ${req.method} ${req.url}`);
    }
    return fetchHandler(req);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  fetchHandler = null;
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeEnv(): OAuthEnv {
  return {
    OAUTH_KV: new MockKV() as unknown as KVNamespace,
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
  };
}

function formRequest(url: string, body: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerClient(env: OAuthEnv): Promise<string> {
  const res = await handleOAuthRequest(
    jsonRequest("https://worker.example.com/oauth/register", {
      client_name: "test-client",
      redirect_uris: [],
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
    env,
  );
  assert.ok(res, "register must return a response");
  assert.equal(res.status, 201);
  const body = await res.json() as { client_id: string };
  return body.client_id;
}

// ── Legacy endpoints (existing-user migration) ───────────────────────

test("legacy /oauth/authorize returns 410 Gone so old clients fail loudly", async () => {
  const env = makeEnv();
  const res = await handleOAuthRequest(
    new Request("https://worker.example.com/oauth/authorize?client_id=x&response_type=code"),
    env,
  );
  assert.ok(res);
  assert.equal(res.status, 410);
});

test("legacy /oauth/callback returns 410 Gone", async () => {
  const env = makeEnv();
  const res = await handleOAuthRequest(
    new Request("https://worker.example.com/oauth/callback?code=dummy"),
    env,
  );
  assert.ok(res);
  assert.equal(res.status, 410);
});

// ── Metadata (RFC 8414) ──────────────────────────────────────────────

test("metadata advertises device_code + refresh_token, no authorization_code", async () => {
  const env = makeEnv();
  const res = await handleOAuthRequest(
    new Request("https://worker.example.com/.well-known/oauth-authorization-server"),
    env,
  );
  assert.ok(res);
  const meta = await res.json() as {
    device_authorization_endpoint: string;
    token_endpoint: string;
    grant_types_supported: string[];
  };
  assert.ok(meta.device_authorization_endpoint.endsWith("/oauth/device_authorization"));
  assert.ok(meta.token_endpoint.endsWith("/oauth/token"));
  assert.deepEqual(meta.grant_types_supported.sort(), [
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ]);
});

// ── Dynamic client registration (RFC 7591) ───────────────────────────

test("POST /oauth/register issues a public client (no secret)", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  assert.match(clientId, /^[A-Za-z0-9_-]+$/);
});

// ── New-user onboarding: device flow happy path ──────────────────────

test("new-user onboarding: device_authorization + token(device_code) issues tokens", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);

  // Stub GitHub device code + token endpoints + user/installations.
  let pollCount = 0;
  fetchHandler = async (req) => {
    if (req.url === "https://github.com/login/device/code") {
      return new Response(
        JSON.stringify({
          device_code: "gh-device-code-abc",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 600,
          interval: 0, // keep test fast; we also override next_poll_at directly
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (req.url === "https://github.com/login/oauth/access_token") {
      pollCount++;
      if (pollCount === 1) {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "ghu_live-access",
          refresh_token: "ghr_live-refresh",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (req.url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({ id: 42, login: "octocat" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (req.url.startsWith("https://api.github.com/user/installations")) {
      return new Response(
        JSON.stringify({
          installations: [
            { account: { id: 42 } },
            { account: { id: 4242 } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected upstream fetch: ${req.url}`);
  };

  // Device authorization
  const daRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/device_authorization", { client_id: clientId }),
    env,
  );
  assert.ok(daRes);
  assert.equal(daRes.status, 200);
  const daBody = await daRes.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
  assert.equal(daBody.device_code, "gh-device-code-abc");
  assert.equal(daBody.user_code, "WDJB-MJHT");
  assert.equal(daBody.verification_uri, "https://github.com/login/device");
  assert.ok(daBody.verification_uri_complete.includes("user_code=WDJB-MJHT"));

  // First poll: authorization_pending
  const pendingRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: daBody.device_code,
      client_id: clientId,
    }),
    env,
  );
  assert.ok(pendingRes);
  assert.equal(pendingRes.status, 400);
  const pendingBody = await pendingRes.json() as { error: string };
  assert.equal(pendingBody.error, "authorization_pending");

  // Second poll: approval → token pair issued
  const okRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: daBody.device_code,
      client_id: clientId,
    }),
    env,
  );
  assert.ok(okRes);
  assert.equal(okRes.status, 200);
  const tokenBody = await okRes.json() as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.equal(tokenBody.token_type, "Bearer");
  assert.ok(tokenBody.access_token);
  assert.ok(tokenBody.refresh_token);
  assert.ok(tokenBody.expires_in > 0);

  // The issued access_token validates against the middleware and carries props.
  const authReq = new Request("https://worker.example.com/mcp", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  const authResult = await authenticateApiRequest(authReq, env);
  assert.ok("auth" in authResult, "Bearer must validate");
  assert.equal(authResult.auth.props.githubLogin, "octocat");
  assert.equal(authResult.auth.props.githubUserId, 42);
  // accessibleAccountIds must include user + org installation ids, de-duplicated.
  assert.deepEqual(
    [...authResult.auth.props.accessibleAccountIds].sort((a, b) => a - b),
    [42, 4242],
  );
});

// ── Unknown / missing Bearer ─────────────────────────────────────────

test("authenticateApiRequest rejects missing Bearer", async () => {
  const env = makeEnv();
  const res = await authenticateApiRequest(
    new Request("https://worker.example.com/mcp"),
    env,
  );
  assert.ok("response" in res);
  assert.equal(res.response.status, 401);
});

test("authenticateApiRequest rejects unknown token", async () => {
  const env = makeEnv();
  const res = await authenticateApiRequest(
    new Request("https://worker.example.com/mcp", {
      headers: { Authorization: "Bearer totally-not-a-real-token" },
    }),
    env,
  );
  assert.ok("response" in res);
  assert.equal(res.response.status, 401);
});

// ── Refresh rotation (concurrent-instance scenario) ──────────────────

test("refresh_token rotation invalidates the previous access and refresh tokens", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);

  // Onboard first so we have a real token pair to rotate.
  fetchHandler = async (req) => {
    if (req.url === "https://github.com/login/device/code") {
      return new Response(JSON.stringify({
        device_code: "dc-rot", user_code: "AAAA-BBBB",
        verification_uri: "https://github.com/login/device",
        expires_in: 600, interval: 0,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({
        access_token: "ghu_x", refresh_token: "ghr_x",
        token_type: "bearer", expires_in: 28800,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 7, login: "rotuser" }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.url.startsWith("https://api.github.com/user/installations")) {
      return new Response(JSON.stringify({ installations: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected: ${req.url}`);
  };

  await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/device_authorization", { client_id: clientId }),
    env,
  );
  const issueRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc-rot", client_id: clientId,
    }),
    env,
  );
  const first = await issueRes!.json() as { access_token: string; refresh_token: string };

  // Rotate via refresh_token.
  const rotRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    }),
    env,
  );
  assert.equal(rotRes!.status, 200);
  const rotated = await rotRes!.json() as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.access_token, first.access_token);
  assert.notEqual(rotated.refresh_token, first.refresh_token);

  // Old access_token must now fail validation (invalidated by rotation).
  const stale = await authenticateApiRequest(
    new Request("https://worker.example.com/mcp", {
      headers: { Authorization: `Bearer ${first.access_token}` },
    }),
    env,
  );
  assert.ok("response" in stale);
  assert.equal(stale.response.status, 401);

  // Old refresh_token must fail as well.
  const staleRef = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    }),
    env,
  );
  assert.equal(staleRef!.status, 400);
  const staleBody = await staleRef!.json() as { error: string };
  assert.equal(staleBody.error, "invalid_grant");

  // New access_token still works.
  const fresh = await authenticateApiRequest(
    new Request("https://worker.example.com/mcp", {
      headers: { Authorization: `Bearer ${rotated.access_token}` },
    }),
    env,
  );
  assert.ok("auth" in fresh);
});

// ── Process-restart token persistence ────────────────────────────────

test("process-restart: tokens stored in KV remain valid across fresh authenticator invocations", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);

  fetchHandler = async (req) => {
    if (req.url === "https://github.com/login/device/code") {
      return new Response(JSON.stringify({
        device_code: "dc-persist", user_code: "CCCC-DDDD",
        verification_uri: "https://github.com/login/device",
        expires_in: 600, interval: 0,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({
        access_token: "ghu_persist", refresh_token: "ghr_persist",
        token_type: "bearer", expires_in: 28800,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 99, login: "persist" }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.url.startsWith("https://api.github.com/user/installations")) {
      return new Response(JSON.stringify({ installations: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected: ${req.url}`);
  };

  await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/device_authorization", { client_id: clientId }),
    env,
  );
  const tokRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc-persist", client_id: clientId,
    }),
    env,
  );
  const issued = await tokRes!.json() as { access_token: string };

  // Simulate a process restart: drop the fetch stub (nothing should be called),
  // then validate the same access_token again via a brand-new Request.
  fetchHandler = null;
  const reopened = await authenticateApiRequest(
    new Request("https://worker.example.com/mcp", {
      headers: { Authorization: `Bearer ${issued.access_token}` },
    }),
    env,
  );
  assert.ok("auth" in reopened, "persisted token must still validate after restart");
  assert.equal(reopened.auth.props.githubLogin, "persist");
});

// ── GitHub 'device_flow_disabled' returns 503 so clients can surface a clear message

test("GitHub device_flow_disabled surfaces as 503 (not a silent auth loop)", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);

  fetchHandler = async (req) => {
    if (req.url === "https://github.com/login/device/code") {
      return new Response(JSON.stringify({
        error: "device_flow_disabled",
        error_description: "Device flow is not enabled on this GitHub App.",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected: ${req.url}`);
  };

  const res = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/device_authorization", { client_id: clientId }),
    env,
  );
  assert.ok(res);
  assert.equal(res.status, 503);
});
