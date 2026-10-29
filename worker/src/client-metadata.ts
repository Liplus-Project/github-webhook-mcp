/**
 * OAuth Client ID Metadata Documents (CIMD) — authorization-server side (#254).
 *
 * Spec basis:
 *   draft-ietf-oauth-client-id-metadata-document-02 (2026-07-06)
 *     §3   Client Identifier URL format
 *     §4   document contents (client_id MUST equal the URL), §4.1 no secrets
 *     §5   200 only, no automatic redirects; §5.1 abort on failure
 *     §5.2 caching (MUST NOT cache errors / invalid documents; bounds allowed)
 *     §6   `client_id_metadata_document_supported`
 *     §7.1 AS-generated client_ids must not start with https://
 *     §8.6 SSRF: never fetch special-use addresses (RFC 6890)
 *     §8.7 read at most ~5 KB
 *   MCP 2026-07-28 basic/authorization/client-registration:
 *     document MUST carry client_id, client_name, redirect_uris; AS MUST
 *     validate client_id equality and the document's required fields.
 *
 * The Worker accepts two kinds of client_id side by side:
 *   - opaque ids issued by RFC 7591 registration (`/oauth/register`, kept for
 *     backwards compatibility) — base64url, never containing ":"
 *   - https URLs, resolved here
 *
 * The bridges shipped in this repository identify themselves with a document
 * the Worker serves itself at CLIENT_METADATA_PATH. A Worker resolves a client_id
 * equal to its own document URL locally (§5 allows associating metadata "through
 * other means"), so the first-party path makes no outbound request at all. Any
 * other https client_id goes through the guarded fetch below.
 */

/** Fixed path of the first-party bridge document on every Worker origin. */
export const CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/** §8.7 recommended maximum read size. */
export const CIMD_MAX_BYTES = 5 * 1024;
/** Budget for DNS check + fetch + body read of one document. */
export const CIMD_FETCH_TIMEOUT_MS = 5_000;
/** Keeps cache keys and log lines bounded. */
export const CIMD_MAX_URL_LENGTH = 2048;
/** Cache lifetime bounds (seconds). KV's own minimum TTL is 60s. */
export const CIMD_CACHE_MIN_TTL = 60;
export const CIMD_CACHE_MAX_TTL = 3600;
export const CIMD_CACHE_DEFAULT_TTL = 300;

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const SHARED_SECRET_AUTH_METHODS = new Set([
  "client_secret_post",
  "client_secret_basic",
  "client_secret_jwt",
]);
/** JWK members that only appear in private (or symmetric) keys. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** Special-use DNS names (RFC 6761 / 6762 / 7686 / 8375) and `internal`. */
const BLOCKED_DNS_SUFFIXES = [
  "localhost", "local", "internal", "home.arpa", "invalid", "test", "example", "onion", "alt",
];

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  /** RFC 7591 default (`authorization_code`) applied when absent. */
  grant_types: string[];
  token_endpoint_auth_method: "none";
}

/** Every rejection carries a message safe to return in `error_description`. */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientMetadataError";
  }
}

export type HostResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

export interface ClientMetadataDeps {
  fetch?: typeof fetch;
  resolve?: HostResolver;
  now?: () => number;
}

export interface ClientMetadataCache {
  get(clientId: string): Promise<ClientMetadataDocument | null>;
  put(clientId: string, document: ClientMetadataDocument, ttlSeconds: number): Promise<void>;
}

/**
 * True when the client_id is URL-shaped and must take the CIMD path. Ids issued
 * by `/oauth/register` are base64url and never contain ":" (§7.1), so the two
 * kinds cannot collide.
 */
export function isUrlClientId(clientId: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clientId);
}

export function firstPartyClientId(origin: string): string {
  return `${origin}${CLIENT_METADATA_PATH}`;
}

/** The document served at CLIENT_METADATA_PATH for the in-repo bridges. */
export function firstPartyClientMetadata(origin: string): ClientMetadataDocument & {
  client_uri: string;
  response_types: string[];
} {
  return {
    client_id: firstPartyClientId(origin),
    client_name: "github-webhook-mcp bridge",
    client_uri: "https://github.com/Liplus-Project/github-webhook-mcp",
    // The bridge's grant never redirects back to the client: GitHub returns to
    // the Worker's own /oauth/callback and the bridge polls /oauth/token.
    redirect_uris: [],
    grant_types: ["urn:ietf:params:oauth:grant-type:web_authorization_poll", "refresh_token"],
    response_types: [],
    token_endpoint_auth_method: "none",
  };
}

// ── Client Identifier URL (§3) ────────────────────────────────────

export function parseClientIdUrl(raw: string): URL {
  if (raw.length > CIMD_MAX_URL_LENGTH) {
    throw new ClientMetadataError(`client_id URL exceeds ${CIMD_MAX_URL_LENGTH} characters`);
  }
  if (/[\s\x00-\x1f\x7f\\]/.test(raw)) {
    throw new ClientMetadataError("client_id URL contains whitespace, control characters or backslashes");
  }
  if (!raw.startsWith("https://")) {
    throw new ClientMetadataError("client_id URL must use the https scheme");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClientMetadataError("client_id is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ClientMetadataError("client_id URL must use the https scheme");
  }
  const afterScheme = raw.slice("https://".length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const rest = authorityEnd === -1 ? "" : afterScheme.slice(authorityEnd);
  if (authority.includes("@") || url.username || url.password) {
    throw new ClientMetadataError("client_id URL must not contain userinfo");
  }
  if (raw.includes("#")) {
    throw new ClientMetadataError("client_id URL must not contain a fragment");
  }
  if (!rest.startsWith("/")) {
    throw new ClientMetadataError("client_id URL must contain a path component");
  }
  const path = rest.split("?")[0];
  for (const segment of path.split("/")) {
    const decoded = segment.toLowerCase().replace(/%2e/g, ".");
    if (decoded === "." || decoded === "..") {
      throw new ClientMetadataError("client_id URL must not contain dot path segments");
    }
  }
  assertPublicHostname(url.hostname);
  return url;
}

function assertPublicHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new ClientMetadataError("client_id URL host must be a DNS name, not an IP address literal");
  }
  if (!host.includes(".")) {
    throw new ClientMetadataError("client_id URL host must be a fully qualified DNS name");
  }
  for (const suffix of BLOCKED_DNS_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      throw new ClientMetadataError(`client_id URL host is under the special-use name "${suffix}"`);
    }
  }
}

// ── Special-use addresses (RFC 6890 and successors) ───────────────

const SPECIAL_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function ipv6ToGroups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) becomes the last two groups.
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((g) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return NaN;
    return parseInt(g, 16);
  }));
  const head = parse(halves[0]);
  const rear = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rear].some(Number.isNaN)) return null;
  const known = head.length + rear.length + tail.length;
  if (halves.length === 1 && known !== 8) return null;
  if (halves.length === 2 && known > 7) return null;
  const fill = new Array(8 - known).fill(0);
  return halves.length === 2 ? [...head, ...fill, ...rear, ...tail] : [...head, ...tail];
}

/**
 * True for any address the Worker must never fetch from (§8.6). IPv6 is
 * allow-listed to global unicast 2000::/3 minus its special-use blocks, so
 * loopback, unspecified, IPv4-mapped/translated, ULA, link-local and multicast
 * all fall outside. Unparseable input counts as special-use (fail closed).
 */
export function isSpecialUseAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return SPECIAL_IPV4_CIDRS.some(([net, prefix]) => {
      const size = 2 ** (32 - prefix);
      return Math.floor(v4 / size) === Math.floor(ipv4ToInt(net)! / size);
    });
  }
  const g = ipv6ToGroups(ip);
  if (!g) return true;
  if ((g[0] & 0xe000) !== 0x2000) return true; // outside 2000::/3
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

// ── DNS check via DNS-over-HTTPS ──────────────────────────────────

/**
 * Workers cannot resolve names directly, so the host is resolved through
 * Cloudflare's DoH JSON API and every A / AAAA answer is checked before the
 * document fetch. The fetch itself resolves again (rebinding between the two
 * lookups is a residual risk documented in docs/0-requirements.md F7.14).
 */
export function dohResolver(fetchImpl: typeof fetch = (...args) => fetch(...args)): HostResolver {
  return async (hostname, signal) => {
    const addresses: string[] = [];
    for (const [type, code] of [["A", 1], ["AAAA", 28]] as const) {
      const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
      const res = await fetchImpl(url, {
        headers: { Accept: "application/dns-json" },
        redirect: "manual",
        signal,
      });
      if (res.status !== 200) {
        throw new ClientMetadataError(`DNS lookup for the client_id host failed (HTTP ${res.status})`);
      }
      const body = await res.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      if (body.Status !== 0 && body.Status !== 3) {
        throw new ClientMetadataError(`DNS lookup for the client_id host failed (status ${body.Status})`);
      }
      for (const answer of body.Answer ?? []) {
        if (answer.type === code && typeof answer.data === "string") addresses.push(answer.data);
      }
    }
    return addresses;
  };
}

// ── Document validation (§4, §4.1, MCP required fields) ───────────

export function validateClientMetadataDocument(
  doc: unknown,
  clientId: string,
): ClientMetadataDocument {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ClientMetadataError("Client ID Metadata Document must be a JSON object");
  }
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) {
    throw new ClientMetadataError("Client ID Metadata Document client_id does not match the client_id URL");
  }
  if (typeof d.client_name !== "string" || !d.client_name.trim()) {
    throw new ClientMetadataError("Client ID Metadata Document is missing client_name");
  }
  if (!isStringArray(d.redirect_uris)) {
    throw new ClientMetadataError("Client ID Metadata Document is missing redirect_uris (array of strings)");
  }
  if (d.grant_types !== undefined && !isStringArray(d.grant_types)) {
    throw new ClientMetadataError("Client ID Metadata Document grant_types must be an array of strings");
  }
  if ("client_secret" in d || "client_secret_expires_at" in d) {
    throw new ClientMetadataError("Client ID Metadata Document must not contain client_secret");
  }
  const method = d.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    if (typeof method === "string" && SHARED_SECRET_AUTH_METHODS.has(method)) {
      throw new ClientMetadataError(`token_endpoint_auth_method ${method} is a shared-secret method and is not allowed`);
    }
    throw new ClientMetadataError("Only public clients (token_endpoint_auth_method=none) are supported");
  }
  if (d.jwks !== undefined) {
    const keys = (d.jwks as { keys?: unknown })?.keys;
    if (!Array.isArray(keys) || keys.some((k) =>
      !k || typeof k !== "object" || PRIVATE_JWK_MEMBERS.some((m) => m in (k as object)))) {
      throw new ClientMetadataError("Client ID Metadata Document jwks must contain public keys only");
    }
  }
  return {
    client_id: clientId,
    client_name: d.client_name,
    redirect_uris: d.redirect_uris,
    grant_types: (d.grant_types as string[] | undefined) ?? ["authorization_code"],
    token_endpoint_auth_method: "none",
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// ── Fetch (§5, §8.6, §8.7) ────────────────────────────────────────

export function cacheTtlFrom(cacheControl: string | null): number {
  if (!cacheControl) return CIMD_CACHE_DEFAULT_TTL;
  const directives = cacheControl.toLowerCase().split(",").map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache")) return CIMD_CACHE_MIN_TTL;
  const maxAge = directives.find((d) => d.startsWith("max-age="));
  if (!maxAge) return CIMD_CACHE_DEFAULT_TTL;
  const seconds = Number(maxAge.slice("max-age=".length).replace(/"/g, ""));
  if (!Number.isFinite(seconds)) return CIMD_CACHE_DEFAULT_TTL;
  return Math.min(CIMD_CACHE_MAX_TTL, Math.max(CIMD_CACHE_MIN_TTL, Math.floor(seconds)));
}

function isJsonContentType(header: string | null): boolean {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json" || /^application\/[a-z0-9!#$&^_.-]+\+json$/.test(type);
}

async function readLimited(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ClientMetadataError(`Client ID Metadata Document exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ClientMetadataError("Client ID Metadata Document is not valid UTF-8");
  }
}

export async function fetchClientMetadataDocument(
  clientId: string,
  deps: ClientMetadataDeps = {},
): Promise<{ document: ClientMetadataDocument; ttl: number }> {
  const url = parseClientIdUrl(clientId);
  const fetchImpl = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const resolve = deps.resolve ?? dohResolver(fetchImpl);
  const signal = AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS);

  try {
    const addresses = await resolve(url.hostname, signal);
    if (addresses.length === 0) {
      throw new ClientMetadataError("client_id URL host does not resolve to any address");
    }
    if (addresses.some(isSpecialUseAddress)) {
      throw new ClientMetadataError("client_id URL host resolves to a special-use (private, loopback or reserved) address");
    }

    const res = await fetchImpl(clientId, {
      method: "GET",
      headers: { Accept: "application/json" },
      // §5: never follow redirects; a 3xx is just a non-200 error below.
      redirect: "manual",
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new ClientMetadataError(`Client ID Metadata Document fetch returned HTTP ${res.status}`);
    }
    if (!isJsonContentType(res.headers.get("Content-Type"))) {
      await res.body?.cancel().catch(() => {});
      throw new ClientMetadataError("Client ID Metadata Document must be served as application/json");
    }
    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > CIMD_MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new ClientMetadataError(`Client ID Metadata Document exceeds ${CIMD_MAX_BYTES} bytes`);
    }
    const text = await readLimited(res, CIMD_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ClientMetadataError("Client ID Metadata Document is not valid JSON");
    }
    return {
      document: validateClientMetadataDocument(parsed, clientId),
      ttl: cacheTtlFrom(res.headers.get("Cache-Control")),
    };
  } catch (err) {
    if (err instanceof ClientMetadataError) throw err;
    if (signal.aborted) {
      throw new ClientMetadataError(`Client ID Metadata Document fetch timed out after ${CIMD_FETCH_TIMEOUT_MS} ms`);
    }
    throw new ClientMetadataError("Client ID Metadata Document could not be fetched");
  }
}

/**
 * Resolve a URL client_id to its validated metadata. The Worker's own document
 * resolves locally; anything else is served from the bounded cache or fetched.
 * Errors and invalid documents are never cached (§5.2).
 */
export async function resolveClientMetadata(
  clientId: string,
  origin: string,
  cache: ClientMetadataCache,
  deps: ClientMetadataDeps = {},
): Promise<ClientMetadataDocument> {
  if (origin.startsWith("https://") && clientId === firstPartyClientId(origin)) {
    const doc = firstPartyClientMetadata(origin);
    return validateClientMetadataDocument(doc, clientId);
  }
  parseClientIdUrl(clientId);
  const cached = await cache.get(clientId).catch(() => null);
  if (cached) return cached;
  const { document, ttl } = await fetchClientMetadataDocument(clientId, deps);
  try {
    await cache.put(clientId, document, ttl);
  } catch (err) {
    console.log(`[oauth] client metadata cache write failed: ${err instanceof Error ? err.message : err}`);
  }
  return document;
}
