/**
 * Unit tests for the Client ID Metadata Document resolver (#254).
 *
 * Network is never touched: every fetch and DNS lookup goes through injected
 * stubs, so each guard (URL shape, special-use addresses, redirects, status,
 * content type, size, timeout, document contents, caching) is observed in
 * isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CIMD_CACHE_DEFAULT_TTL,
  CIMD_CACHE_MAX_TTL,
  CIMD_CACHE_MIN_TTL,
  CIMD_MAX_BYTES,
  CLIENT_METADATA_PATH,
  ClientMetadataError,
  cacheTtlFrom,
  dohResolver,
  fetchClientMetadataDocument,
  firstPartyClientMetadata,
  isSpecialUseAddress,
  isUrlClientId,
  parseClientIdUrl,
  resolveClientMetadata,
  validateClientMetadataDocument,
  type ClientMetadataCache,
  type ClientMetadataDocument,
} from "../src/client-metadata.js";

const CLIENT_ID = "https://client.example.org/oauth/client.json";
const POLL = "urn:ietf:params:oauth:grant-type:web_authorization_poll";

function goodDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: "Example client",
    redirect_uris: [],
    grant_types: [POLL, "refresh_token"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const publicResolver = async () => ["93.184.215.14"];

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ClientMetadataError, `expected ClientMetadataError, got ${err}`);
    assert.match((err as Error).message, pattern);
    return true;
  });
}

// ── client_id classification and URL shape (§3) ──────────────────────

test("opaque DCR ids are never treated as URL client_ids", () => {
  assert.equal(isUrlClientId("Zx1_-abcDEF0123456789"), false);
  assert.equal(isUrlClientId(CLIENT_ID), true);
  assert.equal(isUrlClientId("http://client.example.org/c.json"), true);
});

test("client_id URL shape follows draft §3", () => {
  assert.equal(parseClientIdUrl(CLIENT_ID).hostname, "client.example.org");
  assert.ok(parseClientIdUrl("https://client.example.org:8443/c.json?v=1"));
  const bad: Array<[string, RegExp]> = [
    ["http://client.example.org/c.json", /https scheme/],
    ["https://user:pw@client.example.org/c.json", /userinfo/],
    ["https://client.example.org/c.json#frag", /fragment/],
    ["https://client.example.org", /path component/],
    ["https://client.example.org?x=1", /path component/],
    ["https://client.example.org/a/../c.json", /dot path/],
    ["https://client.example.org/a/%2e%2E/c.json", /dot path/],
    ["https://client.example.org/./c.json", /dot path/],
    ["https://client.example.org/a\\b", /backslash/],
    [" https://client.example.org/c.json", /whitespace/],
    [`https://client.example.org/${"a".repeat(2100)}`, /exceeds/],
  ];
  for (const [raw, pattern] of bad) {
    assert.throws(() => parseClientIdUrl(raw), pattern, raw);
  }
});

test("client_id hosts that are IP literals or special-use names are refused before any fetch", () => {
  for (const raw of [
    "https://127.0.0.1/c.json",
    "https://2130706433/c.json",
    "https://0x7f.1/c.json",
    "https://[::1]/c.json",
    "https://localhost/c.json",
    "https://foo.localhost/c.json",
    "https://intranet/c.json",
    "https://printer.local/c.json",
    "https://svc.internal/c.json",
    "https://router.home.arpa/c.json",
  ]) {
    assert.throws(() => parseClientIdUrl(raw), ClientMetadataError, raw);
  }
});

test("special-use address classification covers RFC 6890 v4 and non-global v6", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "192.0.2.10", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fd12:3456::1", "fe80::1",
    "ff02::1", "64:ff9b::808:808", "2001:db8::1", "2001::1", "2002:7f00:1::", "not-an-ip",
  ]) {
    assert.equal(isSpecialUseAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.215.14", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) {
    assert.equal(isSpecialUseAddress(ip), false, ip);
  }
});

// ── Document validation (§4, §4.1, MCP required fields) ──────────────

test("a complete public-client document validates and defaults grant_types per RFC 7591", () => {
  assert.deepEqual(validateClientMetadataDocument(goodDoc(), CLIENT_ID).grant_types, [POLL, "refresh_token"]);
  const noGrants = goodDoc();
  delete noGrants.grant_types;
  delete noGrants.token_endpoint_auth_method;
  const doc = validateClientMetadataDocument(noGrants, CLIENT_ID);
  assert.deepEqual(doc.grant_types, ["authorization_code"]);
  assert.equal(doc.token_endpoint_auth_method, "none");
});

test("document validation rejects mismatches, missing fields and secrets", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /JSON object/],
    [null, /JSON object/],
    [goodDoc({ client_id: `${CLIENT_ID}?x` }), /does not match/],
    [goodDoc({ client_id: "https://Client.example.org/oauth/client.json" }), /does not match/],
    [goodDoc({ client_name: "" }), /client_name/],
    [goodDoc({ redirect_uris: "https://x" }), /redirect_uris/],
    [goodDoc({ grant_types: "refresh_token" }), /grant_types/],
    [goodDoc({ client_secret: "s" }), /client_secret/],
    [goodDoc({ client_secret_expires_at: 0 }), /client_secret/],
    [goodDoc({ token_endpoint_auth_method: "client_secret_basic" }), /shared-secret/],
    [goodDoc({ token_endpoint_auth_method: "private_key_jwt" }), /public clients/],
    [goodDoc({ jwks: { keys: [{ kty: "EC", d: "secret" }] } }), /public keys only/],
  ];
  for (const [doc, pattern] of cases) {
    assert.throws(() => validateClientMetadataDocument(doc, CLIENT_ID), pattern);
  }
  const missingRedirects = goodDoc();
  delete missingRedirects.redirect_uris;
  assert.throws(() => validateClientMetadataDocument(missingRedirects, CLIENT_ID), /redirect_uris/);
});

test("the first-party bridge document passes the same validator", () => {
  const origin = "https://worker.example.org";
  const doc = firstPartyClientMetadata(origin);
  assert.equal(doc.client_id, `${origin}${CLIENT_METADATA_PATH}`);
  const validated = validateClientMetadataDocument(doc, doc.client_id);
  assert.ok(validated.grant_types.includes(POLL));
  assert.ok(validated.grant_types.includes("refresh_token"));
});

// ── Fetch guards (§5, §8.6, §8.7) ────────────────────────────────────

test("a valid document is fetched without following redirects and with a bounded TTL", async () => {
  const { fn, calls } = stubFetch(() => jsonResponse(goodDoc(), { "Cache-Control": "max-age=120" }));
  const result = await fetchClientMetadataDocument(CLIENT_ID, { fetch: fn, resolve: publicResolver });
  assert.equal(result.document.client_id, CLIENT_ID);
  assert.equal(result.ttl, 120);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLIENT_ID);
  assert.equal(calls[0].init?.redirect, "manual");
});

test("hosts resolving to special-use addresses are never fetched", async () => {
  for (const addresses of [["127.0.0.1"], ["93.184.215.14", "10.0.0.5"], ["::1"], []]) {
    const { fn, calls } = stubFetch(() => jsonResponse(goodDoc()));
    await rejects(
      fetchClientMetadataDocument(CLIENT_ID, { fetch: fn, resolve: async () => addresses }),
      addresses.length ? /special-use/ : /does not resolve/,
    );
    assert.equal(calls.length, 0, JSON.stringify(addresses));
  }
});

test("redirects and other non-200 statuses are errors", async () => {
  for (const status of [301, 302, 307, 404, 500]) {
    const { fn } = stubFetch(() => new Response(null, {
      status,
      headers: { Location: "https://127.0.0.1/" },
    }));
    await rejects(
      fetchClientMetadataDocument(CLIENT_ID, { fetch: fn, resolve: publicResolver }),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test("content type must be JSON", async () => {
  const { fn } = stubFetch(() => jsonResponse(goodDoc(), { "Content-Type": "text/plain" }));
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: fn, resolve: publicResolver }), /application\/json/);
  const vendor = stubFetch(() => jsonResponse(goodDoc(), { "Content-Type": "application/client-metadata+json; charset=utf-8" }));
  const ok = await fetchClientMetadataDocument(CLIENT_ID, { fetch: vendor.fn, resolve: publicResolver });
  assert.equal(ok.document.client_id, CLIENT_ID);
});

test("documents over the 5 KB read limit are rejected with or without Content-Length", async () => {
  const big = JSON.stringify(goodDoc({ client_uri: `https://client.example.org/${"x".repeat(CIMD_MAX_BYTES)}` }));
  const declared = stubFetch(() => jsonResponse(big, { "Content-Length": String(big.length) }));
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: declared.fn, resolve: publicResolver }), /exceeds 5120 bytes/);
  const streamed = stubFetch(() => {
    const bytes = new TextEncoder().encode(big);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 1000) controller.enqueue(bytes.slice(i, i + 1000));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: streamed.fn, resolve: publicResolver }), /exceeds 5120 bytes/);
});

test("malformed JSON, invalid documents and network failures surface as clear errors", async () => {
  const garbage = stubFetch(() => jsonResponse("{not json"));
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: garbage.fn, resolve: publicResolver }), /not valid JSON/);
  const mismatch = stubFetch(() => jsonResponse(goodDoc({ client_id: "https://other.example.org/c.json" })));
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: mismatch.fn, resolve: publicResolver }), /does not match/);
  const down = stubFetch(() => { throw new TypeError("network down"); });
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: down.fn, resolve: publicResolver }), /could not be fetched/);
});

test("a stalled server is cut off by the fetch timeout", { timeout: 15_000 }, async () => {
  const { fn } = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const started = Date.now();
  await rejects(fetchClientMetadataDocument(CLIENT_ID, { fetch: fn, resolve: publicResolver }), /timed out/);
  assert.ok(Date.now() - started < 10_000);
});

test("cache lifetime honours Cache-Control within the configured bounds", () => {
  assert.equal(cacheTtlFrom(null), CIMD_CACHE_DEFAULT_TTL);
  assert.equal(cacheTtlFrom("public, max-age=900"), 900);
  assert.equal(cacheTtlFrom("max-age=5"), CIMD_CACHE_MIN_TTL);
  assert.equal(cacheTtlFrom("max-age=86400"), CIMD_CACHE_MAX_TTL);
  assert.equal(cacheTtlFrom("no-store"), CIMD_CACHE_MIN_TTL);
  assert.equal(cacheTtlFrom("private"), CIMD_CACHE_DEFAULT_TTL);
});

// ── DNS-over-HTTPS resolver ──────────────────────────────────────────

test("the DoH resolver collects A and AAAA answers and ignores CNAME records", async () => {
  const { fn, calls } = stubFetch((url) => {
    const type = new URL(url).searchParams.get("type");
    return jsonResponse({
      Status: 0,
      Answer: type === "A"
        ? [{ type: 5, data: "alias.example.net." }, { type: 1, data: "93.184.215.14" }]
        : [{ type: 28, data: "2606:2800:21f:cb07:6820:80da:af6b:8b2c" }],
    }, { "Content-Type": "application/dns-json" });
  });
  const addresses = await dohResolver(fn)("client.example.org", AbortSignal.timeout(1000));
  assert.deepEqual(addresses, ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
  assert.ok(calls.every((c) => c.url.startsWith("https://cloudflare-dns.com/dns-query?name=client.example.org")));
  const failing = stubFetch(() => jsonResponse({ Status: 2 }));
  await rejects(dohResolver(failing.fn)("client.example.org", AbortSignal.timeout(1000)), /DNS lookup/);
});

// ── Resolution + cache (§5.2) ────────────────────────────────────────

function memoryCache() {
  const store = new Map<string, { doc: ClientMetadataDocument; ttl: number }>();
  const cache: ClientMetadataCache = {
    async get(id) { return store.get(id)?.doc ?? null; },
    async put(id, doc, ttl) { store.set(id, { doc, ttl }); },
  };
  return { cache, store };
}

test("resolved documents are cached and reused; failures are not cached", async () => {
  const { cache, store } = memoryCache();
  let mode: "ok" | "fail" = "fail";
  const { fn, calls } = stubFetch(() => mode === "ok"
    ? jsonResponse(goodDoc(), { "Cache-Control": "max-age=600" })
    : new Response("nope", { status: 404 }));
  const deps = { fetch: fn, resolve: publicResolver };

  await rejects(resolveClientMetadata(CLIENT_ID, "https://worker.example.org", cache, deps), /HTTP 404/);
  assert.equal(store.size, 0);

  mode = "ok";
  const first = await resolveClientMetadata(CLIENT_ID, "https://worker.example.org", cache, deps);
  assert.equal(first.client_name, "Example client");
  assert.equal(store.get(CLIENT_ID)?.ttl, 600);
  mode = "fail";
  const second = await resolveClientMetadata(CLIENT_ID, "https://worker.example.org", cache, deps);
  assert.equal(second.client_name, "Example client");
  assert.equal(calls.length, 2);
});

test("the Worker's own document resolves locally without any network access", async () => {
  const { cache, store } = memoryCache();
  const { fn, calls } = stubFetch(() => { throw new Error("must not fetch"); });
  const origin = "https://worker.example.org";
  const doc = await resolveClientMetadata(`${origin}${CLIENT_METADATA_PATH}`, origin, cache, {
    fetch: fn,
    resolve: async () => { throw new Error("must not resolve"); },
  });
  assert.ok(doc.grant_types.includes(POLL));
  assert.equal(calls.length, 0);
  assert.equal(store.size, 0);
});
