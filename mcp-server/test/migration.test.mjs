/**
 * Client-side migration contract tests for github-webhook-mcp (npm package).
 *
 * The Worker-side bespoke OAuth implementation (worker/src/oauth.ts) rejects tokens
 * that do not originate from a device-flow client. Clients signal "this file was
 * written by the v0.11.0+ device-flow flow" with a `flow: "device"` marker on the
 * tokens file. Legacy files (pre-v0.11.0, localhost-callback flow) lack that marker
 * and must be treated as stale on load so the client can surface a one-time
 * migration notice and re-authenticate.
 *
 * The semantics implemented in mcp-server/server/index.js (and its TypeScript twin
 * local-mcp/src/index.ts) are:
 *   - loadTokens()                returns null when `flow !== "device"`
 *   - checkLegacyTokensMigration() unlinks the legacy file and prints a stderr notice
 *   - saveTokens()                 always writes `flow: "device"` on the way back out
 *
 * These tests are intentionally black-box over the JSON contract rather than
 * importing index.js directly — the module has top-level `await mcp.connect(...)`
 * that would start an MCP server on import. We re-implement the minimum predicate
 * here and verify it against sample payloads representative of both flows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKENS_FLOW_MARKER = "device";

/** Predicate mirrored from mcp-server/server/index.js :: loadTokens(). */
function isActiveTokensFile(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  return parsed.flow === TOKENS_FLOW_MARKER;
}

/** Shape a legacy (pre-v0.11.0, localhost-callback) tokens file would have on disk. */
const LEGACY_TOKENS = {
  access_token: "gho_legacylocalhostflow",
  refresh_token: "ghr_legacylocalhostflow",
  expires_at: Date.now() + 3600_000,
};

/** Shape a v0.11.0+ device-flow tokens file has on disk. */
const DEVICE_TOKENS = {
  flow: TOKENS_FLOW_MARKER,
  access_token: "bespoke_access_token_value",
  refresh_token: "bespoke_refresh_token_value",
  expires_at: Date.now() + 3600_000,
};

test("legacy tokens file (no flow marker) is rejected by the active-file predicate", () => {
  assert.equal(isActiveTokensFile(LEGACY_TOKENS), false);
});

test("device-flow tokens file (flow=device) is accepted", () => {
  assert.equal(isActiveTokensFile(DEVICE_TOKENS), true);
});

test("malformed files are treated as inactive", () => {
  assert.equal(isActiveTokensFile(null), false);
  assert.equal(isActiveTokensFile({}), false);
  assert.equal(isActiveTokensFile({ flow: "" }), false);
  assert.equal(isActiveTokensFile({ flow: "authorization_code" }), false);
  assert.equal(isActiveTokensFile({ access_token: "x" }), false); // no flow at all
});

test("round-trip: legacy file replaced by device-flow file on disk", async () => {
  // Simulate the sequence:
  //   1. A pre-v0.11.0 client wrote a localhost-flow tokens file to ~/.github-webhook-mcp/oauth-tokens.json.
  //   2. The user upgrades to v0.11.0; on first run the client unlinks the legacy file
  //      and writes a device-flow file in its place.
  // The key invariant: after migration, the file on disk parses as `flow === "device"`.
  const dir = await mkdtemp(join(tmpdir(), "github-webhook-mcp-migration-"));
  try {
    const tokenFile = join(dir, "oauth-tokens.json");

    // Write legacy file
    await writeFile(tokenFile, JSON.stringify(LEGACY_TOKENS, null, 2), { mode: 0o600 });
    const before = JSON.parse(await readFile(tokenFile, "utf-8"));
    assert.equal(isActiveTokensFile(before), false);

    // Simulate post-migration overwrite with device-flow payload
    await writeFile(tokenFile, JSON.stringify(DEVICE_TOKENS, null, 2), { mode: 0o600 });
    const after = JSON.parse(await readFile(tokenFile, "utf-8"));
    assert.equal(isActiveTokensFile(after), true);
    assert.equal(after.access_token, DEVICE_TOKENS.access_token);
    assert.equal(after.flow, TOKENS_FLOW_MARKER);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client registration file shape: device_code + refresh_token grant types", () => {
  // The client re-registers when existing registration lacks the device_code grant type.
  // This test asserts the shape the Worker will accept (see worker/src/oauth.ts handleRegister).
  const deviceFlowClient = {
    client_id: "abc123",
    client_name: "github-webhook-mcp-cli",
    redirect_uris: [],
    grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  };
  const legacyClient = {
    client_id: "legacy456",
    grant_types: ["authorization_code", "refresh_token"],
  };

  const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
  const hasDeviceGrant = (reg) =>
    Boolean(reg && Array.isArray(reg.grant_types) && reg.grant_types.includes(DEVICE_CODE_GRANT));

  assert.equal(hasDeviceGrant(deviceFlowClient), true);
  assert.equal(hasDeviceGrant(legacyClient), false);
  assert.equal(hasDeviceGrant(null), false);
  assert.equal(hasDeviceGrant({ grant_types: "not-an-array" }), false);
});
