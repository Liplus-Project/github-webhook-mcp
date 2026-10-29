/**
 * OAuth client identity for the bridge (#254).
 *
 * MCP 2026-07-28 client-registration priority: use a Client ID Metadata Document
 * when the authorization server advertises `client_id_metadata_document_supported`,
 * fall back to Dynamic Client Registration otherwise. The bridge's document is
 * served by the Worker itself at CLIENT_METADATA_PATH, so the client_id is
 * derived from the Worker's issuer and nothing has to be hosted elsewhere.
 * Shared by mcp-server/server/index.js and local-mcp/src/index.ts.
 */

/** Must match worker/src/client-metadata.ts CLIENT_METADATA_PATH. */
export const CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/**
 * The CIMD client_id to use against this authorization server, or null when
 * DCR must be used: support is not advertised, or the issuer is not https
 * (a Client Identifier URL MUST use https; e.g. `wrangler dev` on http).
 */
export function clientMetadataUrl(metadata, workerUrl) {
  if (!metadata || metadata.client_id_metadata_document_supported !== true) return null;
  const base = typeof metadata.issuer === "string" && metadata.issuer ? metadata.issuer : workerUrl;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return `${url.origin}${CLIENT_METADATA_PATH}`;
}

/**
 * Pick the client_id for a new web authorization. `registerDcr` is only called
 * on the fallback path, so a Worker that supports CIMD never sees a
 * registration request and the saved DCR registration is left untouched.
 */
export async function selectOAuthClient(metadata, workerUrl, registerDcr) {
  const cimd = clientMetadataUrl(metadata, workerUrl);
  if (cimd) return { client_id: cimd, method: "client_id_metadata_document" };
  const registration = await registerDcr();
  return { client_id: registration.client_id, method: "dynamic_client_registration" };
}

/**
 * The client_id a refresh must present: the one the grant was issued to. Tokens
 * saved from #254 on carry it; older tokens files were always issued to the DCR
 * registration on disk, so that stays their client.
 */
export function refreshClientId(tokenClientId, registration) {
  if (typeof tokenClientId === "string" && tokenClientId) return tokenClientId;
  if (registration && typeof registration.client_id === "string" && registration.client_id) {
    return registration.client_id;
  }
  return null;
}
