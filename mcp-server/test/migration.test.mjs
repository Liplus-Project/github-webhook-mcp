/**
 * Client-side migration contract tests for github-webhook-mcp (npm package).
 *
 * The Worker-side bespoke OAuth implementation (worker/src/oauth.ts) rejects tokens
 * that were not issued by the current flow. Clients signal "this file was written
 * by the v0.11.1+ web OAuth flow" with a `flow: "web"` marker on the tokens
 * file. Older files — whether from the v0.10.x localhost-callback flow, the v0.11.0
 * device flow, or any other prior iteration — lack that marker and must be
 * treated as stale on load so the client can re-authenticate through the
 * current flow.
 *
 * The semantics implemented in mcp-server/server/index.js (and its TypeScript twin
 * local-mcp/src/index.ts) are:
 *   - loadTokens()                returns null when `flow !== "web"`
 *   - saveTokens()                always writes `flow: "web"` on the way back out
 *
 * These tests are intentionally black-box over the JSON contract rather than
 * importing index.js directly — the module has top-level `await mcp.connect(...)`
 * that would start an MCP server on import. We re-implement the minimum predicate
 * here and verify it against sample payloads representative of each flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKENS_FLOW_MARKER = "web";
const WEB_AUTH_POLL_GRANT = "urn:ietf:params:oauth:grant-type:web_authorization_poll";

/** Predicate mirrored from mcp-server/server/index.js :: loadTokens(). */
function isActiveTokensFile(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  return parsed.flow === TOKENS_FLOW_MARKER;
}

/** Shape a v0.10.x (localhost-callback) tokens file would have on disk. */
const LEGACY_LOCALHOST_TOKENS = {
  access_token: "gho_legacylocalhostflow",
  refresh_token: "ghr_legacylocalhostflow",
  expires_at: Date.now() + 3600_000,
};

/** Shape a v0.11.0 (device-flow) tokens file would have on disk. */
const LEGACY_DEVICE_TOKENS = {
  flow: "device",
  access_token: "device_access_token_value",
  refresh_token: "device_refresh_token_value",
  expires_at: Date.now() + 3600_000,
};

/** Shape a v0.11.1+ (Worker-hosted web flow) tokens file has on disk. */
const WEB_TOKENS = {
  flow: TOKENS_FLOW_MARKER,
  access_token: "bespoke_access_token_value",
  refresh_token: "bespoke_refresh_token_value",
  expires_at: Date.now() + 3600_000,
};

test("v0.10.x localhost-flow tokens file (no flow marker) is rejected", () => {
  assert.equal(isActiveTokensFile(LEGACY_LOCALHOST_TOKENS), false);
});

test("v0.11.0 device-flow tokens file (flow=device) is rejected", () => {
  assert.equal(isActiveTokensFile(LEGACY_DEVICE_TOKENS), false);
});

test("v0.11.1+ web-flow tokens file (flow=web) is accepted", () => {
  assert.equal(isActiveTokensFile(WEB_TOKENS), true);
});

test("malformed files are treated as inactive", () => {
  assert.equal(isActiveTokensFile(null), false);
  assert.equal(isActiveTokensFile({}), false);
  assert.equal(isActiveTokensFile({ flow: "" }), false);
  assert.equal(isActiveTokensFile({ flow: "authorization_code" }), false);
  assert.equal(isActiveTokensFile({ access_token: "x" }), false); // no flow at all
});

test("round-trip: legacy file replaced by web-flow file on disk", async () => {
  // Simulate the sequence:
  //   1. A pre-v0.11.1 client wrote a tokens file to ~/.github-webhook-mcp/oauth-tokens.json
  //      (either localhost-flow or device-flow shape).
  //   2. The user upgrades to v0.11.1; on first run the client overwrites the
  //      existing file with a web-flow payload.
  // The key invariant: after migration, the file on disk parses as `flow === "web"`.
  const dir = await mkdtemp(join(tmpdir(), "github-webhook-mcp-migration-"));
  try {
    const tokenFile = join(dir, "oauth-tokens.json");

    for (const legacy of [LEGACY_LOCALHOST_TOKENS, LEGACY_DEVICE_TOKENS]) {
      await writeFile(tokenFile, JSON.stringify(legacy, null, 2), { mode: 0o600 });
      const before = JSON.parse(await readFile(tokenFile, "utf-8"));
      assert.equal(isActiveTokensFile(before), false);

      // Simulate post-migration overwrite with web-flow payload
      await writeFile(tokenFile, JSON.stringify(WEB_TOKENS, null, 2), { mode: 0o600 });
      const after = JSON.parse(await readFile(tokenFile, "utf-8"));
      assert.equal(isActiveTokensFile(after), true);
      assert.equal(after.access_token, WEB_TOKENS.access_token);
      assert.equal(after.flow, TOKENS_FLOW_MARKER);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client registration file shape: web-auth poll grant + refresh_token", () => {
  // The client re-registers when existing registration lacks the web-auth poll grant.
  // This test asserts the shape the Worker will accept (see worker/src/oauth.ts handleRegister).
  const webFlowClient = {
    client_id: "abc123",
    client_name: "github-webhook-mcp-cli",
    redirect_uris: [],
    grant_types: [WEB_AUTH_POLL_GRANT, "refresh_token"],
    token_endpoint_auth_method: "none",
  };
  const legacyDeviceClient = {
    client_id: "legacy456",
    grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  };
  const legacyAuthCodeClient = {
    client_id: "legacy789",
    grant_types: ["authorization_code", "refresh_token"],
  };

  const hasWebAuthGrant = (reg) =>
    Boolean(reg && Array.isArray(reg.grant_types) && reg.grant_types.includes(WEB_AUTH_POLL_GRANT));

  assert.equal(hasWebAuthGrant(webFlowClient), true);
  assert.equal(hasWebAuthGrant(legacyDeviceClient), false);
  assert.equal(hasWebAuthGrant(legacyAuthCodeClient), false);
  assert.equal(hasWebAuthGrant(null), false);
  assert.equal(hasWebAuthGrant({ grant_types: "not-an-array" }), false);
});

/**
 * RC1 regression guard: when refresh returns invalid_grant, the bridge should
 * re-read the tokens file and adopt any newer refresh_token before falling
 * back to a full web flow. This test covers the detection predicate only; the
 * full retry sequence is exercised manually on a real Worker.
 */
test("invalid_grant detection recognizes 400 responses with invalid_grant body", () => {
  function isInvalidGrantError(err) {
    if (!err) return false;
    if (err.status !== 400) return false;
    const body = typeof err.bodyText === "string" ? err.bodyText : "";
    return body.includes("invalid_grant");
  }

  assert.equal(isInvalidGrantError(null), false);
  assert.equal(isInvalidGrantError({ status: 500, bodyText: "invalid_grant" }), false);
  assert.equal(isInvalidGrantError({ status: 400, bodyText: "something else" }), false);
  assert.equal(
    isInvalidGrantError({
      status: 400,
      bodyText: '{"error":"invalid_grant","error_description":"rotated"}',
    }),
    true,
  );
});
