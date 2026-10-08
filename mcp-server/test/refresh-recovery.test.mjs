/** Executes the shipped authentication functions in isolation (docs F7.11).
 * File reads, refresh transport, clock and OAuth entry are synthetic dependencies;
 * the bridge's top-level stdio startup is deliberately excluded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';

const sources = [
  ['JS', new URL('../server/index.js', import.meta.url)],
  ['TS', new URL('../../local-mcp/src/index.ts', import.meta.url)],
];
const invalidGrant = () => Object.assign(new Error('synthetic invalid_grant'), {
  status: 400, bodyText: '{"error":"invalid_grant"}',
});
const expired = (refresh_token = 'old') => ({
  flow: 'web', access_token: 'expired', refresh_token, expires_at: 1,
});
const usable = (refresh_token = 'rotated') => ({
  flow: 'web', access_token: 'recovered', refresh_token, expires_at: 10_000_000,
});

async function harness(url, { disk, refresh } = {}) {
  let now = 10_000;
  let reads = 0;
  let fallbacks = 0;
  const waits = [];
  const calls = [];
  const source = await readFile(url, 'utf8');
  const storage = source.slice(source.indexOf('async function loadTokens'), source.indexOf('async function saveTokens'));
  const start = source.indexOf('function isInvalidGrantError');
  const end = source.indexOf('// \u2500\u2500 Remote MCP Client', start);
  assert.ok(start >= 0 && end > start);
  let code = storage + source.slice(start, end);
  if (url.pathname.endsWith('.ts')) {
    code = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
  }
  const context = vm.createContext({
    console: { error() {} },
    Date: { now: () => now },
    setImmediate,
    TOKEN_FILE: 'synthetic-only', TOKENS_FLOW_MARKER: 'web',
    readFile: async () => {
      reads++;
      const value = disk ? disk(now, reads) : expired();
      if (value === null) throw new Error('synthetic missing file');
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    sleep: async (ms) => { waits.push(ms); now += ms; },
    refreshAccessToken: async (token) => {
      calls.push(token);
      return refresh ? refresh(token, calls.length) : usable();
    },
    performOAuthFlow: async () => {
      fallbacks++;
      vm.runInContext('_pendingWebAuth = { authorize_url: "https://example.invalid/synthetic" };', context);
      return usable('fallback');
    },
  });
  vm.runInContext(`let _cachedTokens = ${JSON.stringify(expired())};
    let _refreshLock = null, _webAuthLock = null;
    let _pendingWebAuth = null, _pendingWebAuthError = null;
    ${code}`, context);
  return {
    get: (name) => vm.runInContext(`${name}()`, context),
    setCache: (tokens) => vm.runInContext(`_cachedTokens = ${JSON.stringify(tokens)}`, context),
    lock: () => vm.runInContext('_refreshLock', context),
    calls, waits,
    reads: () => reads, fallbacks: () => fallbacks, now: () => now,
  };
}

for (const [language, url] of sources) {
  for (const entry of ['getAccessToken', 'getAccessTokenForToolCall']) {
    test(`${language} ${entry}: delayed disk generation and concurrent callers share recovery`, async () => {
      const h = await harness(url, {
        disk: (now) => expired(now >= 10_150 ? 'new' : 'old'),
        refresh: async (token) => { if (token === 'old') throw invalidGrant(); return usable(); },
      });
      assert.deepEqual(await Promise.all([h.get(entry), h.get(entry)]), ['recovered', 'recovered']);
      assert.deepEqual(h.calls, ['old', 'new']);
      assert.equal(h.fallbacks(), 0);
      assert.equal(h.now(), 10_150);
      assert.equal(h.lock(), null);
    });
    for (const [name, disk] of [
      ['unchanged file', () => expired()],
      ['missing file', () => null],
      ['malformed file', () => '{'],
      ['legacy file', () => ({ ...expired(), flow: 'legacy' })],
    ]) {
      test(`${language} ${entry}: ${name} expires bounded wait and preserves fallback`, async () => {
        const h = await harness(url, { disk, refresh: async () => { throw invalidGrant(); } });
        if (entry === 'getAccessToken') assert.equal(await h.get(entry), 'recovered');
        else await assert.rejects(h.get(entry), { name: 'AuthRequiredError' });
        assert.equal(h.fallbacks(), 1);
        assert.equal(h.now(), 11_000);
        assert.equal(h.reads(), 21);
        assert.deepEqual(h.calls, ['old']);
        assert.equal(h.lock(), null);
      });
    }
    test(`${language} ${entry}: other refresh errors do not wait`, async () => {
      const h = await harness(url, { refresh: async () => { throw new Error('synthetic transport failure'); } });
      if (entry === 'getAccessToken') await h.get(entry);
      else await assert.rejects(h.get(entry), { name: 'AuthRequiredError' });
      assert.equal(h.reads(), 0);
      assert.deepEqual(h.waits, []);
      assert.equal(h.fallbacks(), 1);
      assert.equal(h.lock(), null);
    });
    test(`${language} ${entry}: usable newer disk token avoids redundant refresh`, async () => {
      const h = await harness(url, { disk: () => usable('new'), refresh: async () => { throw invalidGrant(); } });
      assert.equal(await h.get(entry), 'recovered');
      assert.deepEqual(h.calls, ['old']);
      assert.deepEqual(h.waits, []);
      assert.equal(h.fallbacks(), 0);
    });
    test(`${language} ${entry}: changing generations cannot cause unlimited refresh`, async () => {
      const h = await harness(url, { disk: (_, reads) => expired(`generation-${reads}`), refresh: async () => { throw invalidGrant(); } });
      if (entry === 'getAccessToken') await h.get(entry);
      else await assert.rejects(h.get(entry), { name: 'AuthRequiredError' });
      assert.deepEqual(h.calls, ['old', 'generation-1', 'generation-2']);
      assert.equal(h.fallbacks(), 1);
      assert.equal(h.lock(), null);
    });
    test(`${language} ${entry}: second rotated generation can recover after invalid_grant`, async () => {
      const h = await harness(url, {
        disk: (_, reads) => expired(reads < 3 ? 'new' : 'newer'),
        refresh: async (token) => { if (token !== 'newer') throw invalidGrant(); return usable(); },
      });
      assert.equal(await h.get(entry), 'recovered');
      assert.deepEqual(h.calls, ['old', 'new', 'newer']);
      assert.equal(h.fallbacks(), 0);
      assert.equal(h.lock(), null);
    });
    test(`${language} ${entry}: renewed token with no expiry can be adopted`, async () => {
      const h = await harness(url, {
        disk: () => ({ ...usable('new'), expires_at: undefined }),
        refresh: async () => { throw invalidGrant(); },
      });
      assert.equal(await h.get(entry), 'recovered');
      assert.deepEqual(h.calls, ['old']);
      assert.equal(h.fallbacks(), 0);
    });
    test(`${language} ${entry}: recovery transport failure stops further waits`, async () => {
      const h = await harness(url, {
        disk: () => expired('new'),
        refresh: async (token) => { throw token === 'old' ? invalidGrant() : new Error('synthetic transport failure'); },
      });
      if (entry === 'getAccessToken') await h.get(entry);
      else await assert.rejects(h.get(entry), { name: 'AuthRequiredError' });
      assert.deepEqual(h.calls, ['old', 'new']);
      assert.deepEqual(h.waits, []);
      assert.equal(h.fallbacks(), 1);
    });
    test(`${language} ${entry}: successful refresh and valid cache have no wait`, async () => {
      const h = await harness(url);
      assert.equal(await h.get(entry), 'recovered');
      assert.equal(await h.get(entry), 'recovered');
      assert.deepEqual(h.calls, ['old']);
      assert.deepEqual(h.waits, []);
      assert.equal(h.reads(), 0);
      assert.equal(h.fallbacks(), 0);
    });
    test(`${language} ${entry}: failed operation releases lock for later recovery`, async () => {
      let failing = true;
      const h = await harness(url, { refresh: async () => { if (failing) throw invalidGrant(); return usable(); } });
      if (entry === 'getAccessToken') await h.get(entry);
      else await assert.rejects(h.get(entry), { name: 'AuthRequiredError' });
      assert.equal(h.lock(), null);
      failing = false;
      h.setCache(expired('later'));
      assert.equal(await h.get(entry), 'recovered');
      assert.deepEqual(h.calls, ['old', 'later']);
      assert.equal(h.lock(), null);
    });
  }
  test(`${language}: both access-token entrances share one recovery operation`, async () => {
    const h = await harness(url, {
      disk: (now) => expired(now >= 10_100 ? 'new' : 'old'),
      refresh: async (token) => { if (token === 'old') throw invalidGrant(); return usable(); },
    });
    assert.deepEqual(await Promise.all([h.get('getAccessToken'), h.get('getAccessTokenForToolCall')]), ['recovered', 'recovered']);
    assert.deepEqual(h.calls, ['old', 'new']);
    assert.equal(h.fallbacks(), 0);
  });
}
