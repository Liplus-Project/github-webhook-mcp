/**
 * OAuth KV store — bespoke schema for Worker-hosted web OAuth flow.
 *
 * v0.11.1 reverts the device-authorization-grant layout (#203) in favour of a
 * Worker-hosted web OAuth flow. The Worker acts as the redirect_uri target
 * (`https://<worker>/oauth/callback`) so the client never needs a localhost
 * listener. Issued bearer tokens and refresh rotation semantics stay identical
 * to v0.11.0 — only the approval path is new.
 *
 * Key layout:
 *   client:{client_id}                  → ClientRecord (dynamic client registration)
 *   web_auth_state:{state}              → WebAuthStateRecord (web OAuth polling state)
 *   token:{access_token}                → TokenRecord (access token → grant ref)
 *   refresh:{refresh_token}             → RefreshRecord (refresh token → grant ref)
 *   grant:{grant_id}                    → GrantRecord (GitHub props + issued tokens)
 *
 * grant_id format = `{userId}:{random}` — same general shape as the legacy provider
 * used, which keeps `wrangler tail` diagnostics familiar.
 */

import type { GitHubUserProps } from "./oauth.js";

export interface ClientRecord {
  client_id: string;
  /** Optional for public clients. */
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  /** Always includes "authorization_code" + "refresh_token". */
  grant_types: string[];
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  created_at: string;
}

/**
 * Web OAuth polling state.
 *
 * The MCP bridge obtains a `state` by calling GET /oauth/authorize, opens the
 * browser to let the user complete GitHub's web OAuth, and polls
 * POST /oauth/token with grant_type=urn:ietf:params:oauth:grant-type:web_authorization_poll
 * against that `state`. The callback handler flips the record to `approved` and
 * attaches the freshly-issued access/refresh tokens; the next poll consumes
 * them and the record is deleted.
 */
export interface WebAuthStateRecord {
  state: string;
  client_id: string;
  /** Scope requested by the client, space-separated. May be empty. */
  scope: string;
  /** Absolute expiry time (epoch seconds). */
  expires_at: number;
  /**
   * Approval state:
   *   pending   — user has not completed authorization yet
   *   approved  — user authorized; access_token / refresh_token populated
   *   denied    — user denied authorization
   */
  status: "pending" | "approved" | "denied";
  /** Populated once the callback handler completes the GitHub exchange. */
  access_token?: string;
  /** Populated alongside access_token. */
  refresh_token?: string;
}

export interface TokenRecord {
  access_token: string;
  grant_id: string;
  /** Absolute expiry time (epoch seconds). */
  expires_at: number;
}

export interface RefreshRecord {
  refresh_token: string;
  grant_id: string;
  /** Absolute expiry time (epoch seconds). */
  expires_at: number;
}

export interface GrantRecord {
  grant_id: string;
  client_id: string;
  user_id: string;
  scope: string;
  props: GitHubUserProps;
  /** Currently-valid access token id (for revocation). */
  access_token: string;
  /** Currently-valid refresh token id (for revocation and rotation). */
  refresh_token: string;
  created_at: string;
  updated_at: string;
}

/** Token lifetimes (seconds). */
export const ACCESS_TOKEN_TTL = 3600;            // 1 hour
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 days
/** Web auth state lifetime (seconds). */
export const WEB_AUTH_STATE_TTL = 600;
/** Default client poll interval (seconds). */
export const WEB_AUTH_POLL_INTERVAL = 2;

const nowSec = () => Math.floor(Date.now() / 1000);

async function putJson(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ttl: number,
): Promise<void> {
  // KV requires at least 60s for expirationTtl. Clamp defensively.
  const expirationTtl = Math.max(60, ttl);
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}

async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Client records (dynamic registration) ─────────────────────────

export async function putClient(kv: KVNamespace, record: ClientRecord): Promise<void> {
  // Clients persist indefinitely. Use a long TTL (1 year) as a soft ceiling.
  await putJson(kv, `client:${record.client_id}`, record, 365 * 24 * 3600);
}

export async function getClient(kv: KVNamespace, clientId: string): Promise<ClientRecord | null> {
  return getJson<ClientRecord>(kv, `client:${clientId}`);
}

// ── Web auth state records (Worker-hosted web OAuth polling) ──────

export async function putWebAuthState(
  kv: KVNamespace,
  record: WebAuthStateRecord,
): Promise<void> {
  const remaining = record.expires_at - nowSec();
  await putJson(kv, `web_auth_state:${record.state}`, record, remaining);
}

export async function getWebAuthState(
  kv: KVNamespace,
  state: string,
): Promise<WebAuthStateRecord | null> {
  return getJson<WebAuthStateRecord>(kv, `web_auth_state:${state}`);
}

export async function deleteWebAuthState(
  kv: KVNamespace,
  state: string,
): Promise<void> {
  await kv.delete(`web_auth_state:${state}`);
}

// ── Grant + token records ─────────────────────────────────────────

export async function putGrant(kv: KVNamespace, record: GrantRecord): Promise<void> {
  await putJson(kv, `grant:${record.grant_id}`, record, REFRESH_TOKEN_TTL);
}

export async function getGrant(kv: KVNamespace, grantId: string): Promise<GrantRecord | null> {
  return getJson<GrantRecord>(kv, `grant:${grantId}`);
}

export async function deleteGrant(kv: KVNamespace, grantId: string): Promise<void> {
  await kv.delete(`grant:${grantId}`);
}

export async function putAccessToken(kv: KVNamespace, record: TokenRecord): Promise<void> {
  const remaining = record.expires_at - nowSec();
  await putJson(kv, `token:${record.access_token}`, record, remaining);
}

export async function getAccessToken(kv: KVNamespace, token: string): Promise<TokenRecord | null> {
  return getJson<TokenRecord>(kv, `token:${token}`);
}

export async function deleteAccessToken(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(`token:${token}`);
}

export async function putRefreshToken(kv: KVNamespace, record: RefreshRecord): Promise<void> {
  const remaining = record.expires_at - nowSec();
  await putJson(kv, `refresh:${record.refresh_token}`, record, remaining);
}

export async function getRefreshToken(kv: KVNamespace, token: string): Promise<RefreshRecord | null> {
  return getJson<RefreshRecord>(kv, `refresh:${token}`);
}

export async function deleteRefreshToken(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(`refresh:${token}`);
}

// ── Identifier helpers ────────────────────────────────────────────

/** Generate a random URL-safe token of n bytes. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export function grantIdFor(userId: string): string {
  return `${userId}:${randomToken(12)}`;
}

function base64UrlEncode(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
