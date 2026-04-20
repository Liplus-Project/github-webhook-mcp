/**
 * OAuth KV store — bespoke schema for device authorization grant flow (RFC 8628).
 *
 * Replaces the opaque key format used by @cloudflare/workers-oauth-provider v0.3.1.
 * All records are JSON-encoded with explicit expiresAt timestamps so we can
 * detect expiry without relying solely on KV TTL.
 *
 * Key layout:
 *   client:{client_id}                  → ClientRecord (dynamic client registration)
 *   device:{device_code}                → DeviceRecord (device flow polling state)
 *   user_code:{user_code}               → {device_code} (user-code → device-code index)
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
  /** Optional for public clients using device flow. */
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  /** Always includes "urn:ietf:params:oauth:grant-type:device_code" + "refresh_token". */
  grant_types: string[];
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  created_at: string;
}

export interface DeviceRecord {
  device_code: string;
  user_code: string;
  client_id: string;
  /** Scope requested by the client, space-separated. May be empty. */
  scope: string;
  /** Absolute expiry time (epoch seconds). */
  expires_at: number;
  /** Minimum polling interval in seconds. Bumped on slow_down. */
  interval: number;
  /** Next allowed poll time (epoch seconds). Enforces interval + slow_down. */
  next_poll_at: number;
  /**
   * Approval state:
   *   pending   — user has not completed authorization yet
   *   approved  — user authorized; props populated; ready for token exchange
   *   denied    — user denied authorization
   */
  status: "pending" | "approved" | "denied";
  /** Populated once the user completes GitHub authorization. */
  props?: GitHubUserProps;
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
/** Device code lifetime (seconds). RFC 8628 §3.2 recommends ~600s. */
export const DEVICE_CODE_TTL = 600;
/** Default polling interval (seconds). RFC 8628 §3.5. */
export const DEVICE_POLL_INTERVAL = 5;

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

// ── Device records (RFC 8628 polling state) ───────────────────────

export async function putDevice(kv: KVNamespace, record: DeviceRecord): Promise<void> {
  const remaining = record.expires_at - nowSec();
  await putJson(kv, `device:${record.device_code}`, record, remaining);
  // user_code index for approval landing pages / lookups.
  await kv.put(`user_code:${record.user_code}`, record.device_code, {
    expirationTtl: Math.max(60, remaining),
  });
}

export async function getDevice(kv: KVNamespace, deviceCode: string): Promise<DeviceRecord | null> {
  return getJson<DeviceRecord>(kv, `device:${deviceCode}`);
}

export async function deleteDevice(kv: KVNamespace, record: DeviceRecord): Promise<void> {
  await kv.delete(`device:${record.device_code}`);
  await kv.delete(`user_code:${record.user_code}`);
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

/** Generate an RFC 8628 user_code: 8 uppercase alphanumeric chars grouped XXXX-XXXX. */
export function randomUserCode(): string {
  // Exclude ambiguous chars (0/O, 1/I) per RFC 8628 §6.1 guidance.
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[buf[i] % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

export function grantIdFor(userId: string): string {
  return `${userId}:${randomToken(12)}`;
}

function base64UrlEncode(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
