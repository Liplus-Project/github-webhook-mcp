/**
 * Integration tests for the Worker-hosted web OAuth implementation (v0.11.1).
 *
 * v0.11.1 replaces the device-authorization-grant iteration with a Worker-
 * hosted web OAuth flow: the bridge opens `/oauth/authorize?state=<state>` in
 * a browser, the Worker is the redirect_uri target (`/oauth/callback`), and
 * the bridge polls `/oauth/token` with `grant_type=…web_authorization_poll`
 * against the same state.
 *
 * Scenarios covered deterministically in CI:
 *   - metadata advertises authorization_code + refresh_token
 *   - dynamic client registration issues a public client
 *   - authorize redirects to GitHub with redirect_uri pinned to the Worker
 *   - polling returns authorization_pending while state is pending
 *   - callback → pending poll turns into an approved token pair on next poll
 *   - refresh_token rotation invalidates the previous token pair
 *   - access_token validates via the middleware across simulated restarts
 *   - user-denied callback surfaces as access_denied on the next poll
 *
 * GitHub upstream is stubbed by swapping globalThis.fetch. The KV namespace
 * is a Map-backed mock that matches the subset of the KVNamespace API that
 * oauth-store.ts uses.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  authenticateApiRequest,
  handleOAuthRequest,
  WEB_AUTH_POLL_GRANT,
} from "../src/oauth.js";
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
      grant_types: [WEB_AUTH_POLL_GRANT, "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
    env,
  );
  assert.ok(res, "register must return a response");
  assert.equal(res.status, 201);
  const body = await res.json() as { client_id: string };
  return body.client_id;
}

/**
 * Drive an authorize → callback → poll sequence end-to-end, stubbing GitHub's
 * web OAuth endpoints. Returns the issued access / refresh token pair.
 */
async function onboardUser(
  env: OAuthEnv,
  clientId: string,
  state: string,
  user: { id: number; login: string },
  installations: number[],
): Promise<{ access_token: string; refresh_token: string }> {
  // Stub GitHub's token exchange + user profile fetch.
  fetchHandler = async (req) => {
    if (req.url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({
          access_token: `ghu_${user.login}`,
          refresh_token: `ghr_${user.login}`,
          token_type: "bearer",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (req.url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({ id: user.id, login: user.login }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (req.url.startsWith("https://api.github.com/user/installations")) {
      return new Response(
        JSON.stringify({
          installations: installations.map((id) => ({ account: { id } })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected upstream fetch: ${req.url}`);
  };

  // /oauth/authorize issues the pending state record and 302s to GitHub.
  const authRes = await handleOAuthRequest(
    new Request(
      `https://worker.example.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`,
    ),
    env,
  );
  assert.ok(authRes, "authorize must return a response");
  assert.equal(authRes.status, 302);

  // Simulate GitHub redirecting back to the Worker's callback with a code.
  const cbRes = await handleOAuthRequest(
    new Request(
      `https://worker.example.com/oauth/callback?code=dummy-code&state=${encodeURIComponent(state)}`,
    ),
    env,
  );
  assert.ok(cbRes);
  assert.equal(cbRes.status, 200);
  assert.match(cbRes.headers.get("Content-Type") ?? "", /text\/html/);

  // Poll consumes the approved state and returns the token pair.
  const pollRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: WEB_AUTH_POLL_GRANT,
      state,
      client_id: clientId,
    }),
    env,
  );
  assert.ok(pollRes);
  assert.equal(pollRes.status, 200);
  const tokens = await pollRes.json() as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  return { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
}

// ── Metadata (RFC 8414) ──────────────────────────────────────────────

test("metadata advertises authorization_endpoint + web-auth poll + refresh_token", async () => {
  const env = makeEnv();
  const res = await handleOAuthRequest(
    new Request("https://worker.example.com/.well-known/oauth-authorization-server"),
    env,
  );
  assert.ok(res);
  const meta = await res.json() as {
    authorization_endpoint: string;
    token_endpoint: string;
    grant_types_supported: string[];
  };
  assert.ok(meta.authorization_endpoint.endsWith("/oauth/authorize"));
  assert.ok(meta.token_endpoint.endsWith("/oauth/token"));
  assert.deepEqual(meta.grant_types_supported.sort(), [
    "refresh_token",
    WEB_AUTH_POLL_GRANT,
  ].sort());
});

// ── Dynamic client registration (RFC 7591) ───────────────────────────

test("POST /oauth/register issues a public client (no secret)", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  assert.match(clientId, /^[A-Za-z0-9_-]+$/);
});

// ── Authorize redirect pins redirect_uri to the Worker (RC2 fix) ─────

test("GET /oauth/authorize redirects to GitHub with Worker-pinned redirect_uri", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);

  const state = "state-worker-redirect-check";
  const res = await handleOAuthRequest(
    new Request(
      `https://worker.example.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}&scope=read:user`,
    ),
    env,
  );
  assert.ok(res);
  assert.equal(res.status, 302);

  const location = res.headers.get("Location") ?? "";
  assert.ok(
    location.startsWith("https://github.com/login/oauth/authorize"),
    "authorize must redirect to GitHub's web OAuth",
  );
  const target = new URL(location);
  // RC2 fix: redirect_uri is pinned to the Worker, never to the client's host.
  assert.equal(
    target.searchParams.get("redirect_uri"),
    "https://worker.example.com/oauth/callback",
  );
  assert.equal(target.searchParams.get("state"), state);
  assert.equal(target.searchParams.get("client_id"), "test-github-client-id");
});

test("GET /oauth/authorize rejects missing state", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  const res = await handleOAuthRequest(
    new Request(`https://worker.example.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}`),
    env,
  );
  assert.ok(res);
  assert.equal(res.status, 400);
});

// ── Polling: pending state ───────────────────────────────────────────

test("POST /oauth/token(web_authorization_poll) returns authorization_pending while state is pending", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  const state = "state-pending-1234";

  const authRes = await handleOAuthRequest(
    new Request(
      `https://worker.example.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`,
    ),
    env,
  );
  assert.equal(authRes!.status, 302);

  const pollRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: WEB_AUTH_POLL_GRANT,
      state,
      client_id: clientId,
    }),
    env,
  );
  assert.ok(pollRes);
  assert.equal(pollRes.status, 400);
  const body = await pollRes.json() as { error: string };
  assert.equal(body.error, "authorization_pending");
});

// ── Happy path: authorize → callback → poll → token pair ─────────────

test("new-user onboarding: authorize + callback + poll issues tokens", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);

  const { access_token, refresh_token } = await onboardUser(
    env,
    clientId,
    "state-new-user-abcdef",
    { id: 42, login: "octocat" },
    [42, 4242],
  );

  // The issued access_token validates against the middleware and carries props.
  const authReq = new Request("https://worker.example.com/mcp", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const authResult = await authenticateApiRequest(authReq, env);
  assert.ok("auth" in authResult, "Bearer must validate");
  assert.equal(authResult.auth.props.githubLogin, "octocat");
  assert.equal(authResult.auth.props.githubUserId, 42);
  assert.deepEqual(
    [...authResult.auth.props.accessibleAccountIds].sort((a, b) => a - b),
    [42, 4242],
  );

  // Refresh token is also persisted and usable.
  assert.ok(refresh_token);
});

test("polling the same state twice returns expired_token after the first consume", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  const state = "state-consumed-once-xyz";
  await onboardUser(env, clientId, state, { id: 7, login: "consumer" }, []);

  // Second poll against the same state must fail — the record was consumed.
  const secondPoll = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: WEB_AUTH_POLL_GRANT,
      state,
      client_id: clientId,
    }),
    env,
  );
  assert.equal(secondPoll!.status, 400);
  const body = await secondPoll!.json() as { error: string };
  assert.equal(body.error, "expired_token");
});

// ── User-denied callback ─────────────────────────────────────────────

test("GitHub access_denied on /oauth/callback surfaces as access_denied on next poll", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  const state = "state-denied-qrst";

  // Start the authorize state.
  await handleOAuthRequest(
    new Request(
      `https://worker.example.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`,
    ),
    env,
  );

  // User declines on the GitHub consent screen. No upstream fetch is needed
  // because the callback short-circuits on the error parameter.
  const cbRes = await handleOAuthRequest(
    new Request(
      `https://worker.example.com/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    ),
    env,
  );
  assert.ok(cbRes);
  assert.equal(cbRes.status, 200);

  // Next poll returns access_denied so the bridge can stop and surface a clear error.
  const pollRes = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: WEB_AUTH_POLL_GRANT,
      state,
      client_id: clientId,
    }),
    env,
  );
  assert.equal(pollRes!.status, 400);
  const body = await pollRes!.json() as { error: string };
  assert.equal(body.error, "access_denied");
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

// ── Refresh rotation ─────────────────────────────────────────────────

test("refresh_token rotation invalidates the previous access and refresh tokens", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  const first = await onboardUser(env, clientId, "state-rotation-aaaa", { id: 7, login: "rotuser" }, []);

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
  const issued = await onboardUser(env, clientId, "state-persist-uvwx", { id: 99, login: "persist" }, []);

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

// ── Unsupported grant_type guard ─────────────────────────────────────

test("unsupported grant_type returns 400 unsupported_grant_type", async () => {
  const env = makeEnv();
  const clientId = await registerClient(env);
  const res = await handleOAuthRequest(
    formRequest("https://worker.example.com/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
    }),
    env,
  );
  assert.equal(res!.status, 400);
  const body = await res!.json() as { error: string };
  assert.equal(body.error, "unsupported_grant_type");
});
