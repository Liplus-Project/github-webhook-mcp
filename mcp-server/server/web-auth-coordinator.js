/** Cross-process web-flow ownership. No OAuth credentials travel over IPC. */
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const random = () => randomBytes(32).toString("hex");
const failure = () => new Error("OAuth coordination unavailable; retry the tool call.");

// These defaults preserve the bridge's 15s phase-1 and 600s approval windows.
export const WEB_AUTH_START_MS = 15_000;
export const WEB_AUTH_LIFETIME_MS = 600_000;

export async function webAuthScope(workerUrl, tokenDir) {
  await mkdir(tokenDir, { recursive: true, mode: 0o700 });
  let storage = await realpath(tokenDir);
  if (process.platform === "win32") storage = storage.toLowerCase();
  const target = new URL(workerUrl).href.replace(/\/$/, "");
  const scope = createHash("sha256").update(JSON.stringify([target, storage])).digest("hex");
  // Avoid the default Windows dynamic client-port range (49152-65535).
  // A conflicting listener still fails closed; there is no fallback port.
  return { scope, port: 20000 + (parseInt(scope.slice(0, 8), 16) % 10000),
    recordFile: join(storage, `web-auth-${scope}.json`), tokenFile: join(storage, "oauth-tokens.json") };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

// The kernel-held listener fences synchronous writes. Readers may observe a
// partial record and retry its validation. Replacing a file with rename can
// fail with EPERM during concurrent Windows reads; no replacement is needed
// for ownership, and no cleanup deletes a successor's record.
function publish(file, value) {
  try {
    chmodSync(file, 0o600);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function validRecord(record, identity) {
  return record?.version === 1 && record.scope === identity.scope && record.port === identity.port &&
    /^[a-f0-9]{64}$/.test(record.generation) && /^[a-f0-9]{64}$/.test(record.capability) &&
    Number.isSafeInteger(record.owner_pid) && record.owner_pid > 0 &&
    Number.isFinite(record.expires_at) && record.expires_at > Date.now() &&
    record.expires_at <= Date.now() + WEB_AUTH_LIFETIME_MS + WEB_AUTH_START_MS;
}

function completedTokens(identity, generation) {
  const tokens = readJson(identity.tokenFile);
  if (tokens?.flow !== "web" || tokens.web_auth?.scope !== identity.scope ||
      tokens.web_auth?.generation !== generation ||
      typeof tokens.access_token !== "string" || !tokens.access_token.trim() ||
      (tokens.expires_at !== undefined && (!Number.isFinite(tokens.expires_at) || tokens.expires_at <= Date.now()))) {
    throw new Error("OAuth completion did not match the saved scope and generation; retry.");
  }
  return tokens;
}

async function status(identity, record) {
  const response = await fetch(`http://127.0.0.1:${identity.port}/status`, {
    method: "POST", headers: { "x-web-auth-capability": record.capability },
    signal: AbortSignal.timeout(500), redirect: "error",
  });
  if (!response.ok) throw failure();
  const value = await response.json();
  if (value?.scope !== identity.scope || value.generation !== record.generation ||
      value.expires_at !== record.expires_at) throw failure();
  return value;
}

/**
 * runOwner receives {signal, assertOwner, pending}. It alone performs discovery,
 * registration, browser launch and polling, then returns tokens to publish.
 * The optional timing values are a test seam; production uses the defaults.
 */
export async function coordinateWebAuth({ workerUrl, tokenDir, runOwner, onPending,
  startMs = WEB_AUTH_START_MS, lifetimeMs = WEB_AUTH_LIFETIME_MS, settleMs = 1500 }) {
  const startedAt = Date.now();
  const identity = await webAuthScope(workerUrl, tokenDir);
  const startDeadline = Date.now() + startMs;
  let followedGeneration = null;
  let followDeadline = 0;

  while (Date.now() < Math.min(startedAt + startMs + lifetimeMs, Math.max(startDeadline, followDeadline))) {
    const last = readJson(identity.recordFile);
    if (validRecord(last, identity) && last.status === "complete" &&
        (last.generation === followedGeneration || last.completed_at >= startedAt)) {
      return completedTokens(identity, last.generation);
    }
    if (last?.scope === identity.scope && last.generation === followedGeneration && last.status === "failed") {
      throw new Error("OAuth owner failed; retry.");
    }
    const record = { version: 1, ...identity, generation: random(), capability: random(),
      owner_pid: process.pid, expires_at: Date.now() + lifetimeMs };
    // Paths never leave this process, including in the private IPC response.
    delete record.recordFile;
    delete record.tokenFile;
    let snapshot = { scope: identity.scope, generation: record.generation,
      expires_at: record.expires_at, status: "starting" };
    let released = false;
    let finished = false;
    const abort = new AbortController();
    const server = createServer((req, res) => {
      const supplied = req.headers["x-web-auth-capability"];
      if (req.method !== "POST" || req.url !== "/status" || typeof supplied !== "string" ||
          !/^[a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(record.capability))) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(snapshot));
    });
    server.requestTimeout = 1000;
    server.headersTimeout = 1000;
    server.timeout = 1000;
    const acquired = await new Promise((resolve, reject) => {
      server.once("error", (err) => err.code === "EADDRINUSE" ? resolve(false) : reject(failure()));
      server.listen({ host: "127.0.0.1", port: identity.port, exclusive: true }, () => resolve(true));
    });
    if (acquired) {
      let repair;
      let expiry;
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(repair);
        clearTimeout(expiry);
        abort.abort(failure());
        server.close();
        server.closeAllConnections?.();
      };
      const assertOwner = () => {
        if (released || finished || Date.now() >= record.expires_at) throw failure();
      };
      try {
        // The previous owner may finish/release while this process is paused
        // between its pre-bind read and the asynchronous listen callback.
        // Recheck under exclusive ownership before overwriting that evidence.
        const completed = readJson(identity.recordFile);
        if (validRecord(completed, identity) && completed.status === "complete" &&
            (completed.generation === followedGeneration || completed.completed_at >= startedAt)) {
          try { return completedTokens(identity, completed.generation); } finally { release(); }
        }
        publish(identity.recordFile, record);
        repair = setInterval(() => {
          if (!released) {
            try { publish(identity.recordFile, record); } catch { release(); }
          }
        }, 500);
        const interrupted = new Promise((_, reject) => {
          // Storage failure also releases ownership. Even an uncooperative
          // outstanding callback must not leave this promise pending forever.
          abort.signal.addEventListener("abort", () => reject(failure()), { once: true });
          expiry = setTimeout(release, lifetimeMs);
        });
        const tokens = await Promise.race([runOwner({ signal: abort.signal, assertOwner,
          pending(value) {
            assertOwner();
            const url = new URL(value.authorize_url);
            if (!["http:", "https:"].includes(url.protocol)) throw failure();
            snapshot = { ...snapshot, status: "pending", pending: {
              authorize_url: url.href, expires_at: record.expires_at } };
            onPending(snapshot.pending);
          },
        }), interrupted]);
        assertOwner();
        if (typeof tokens?.access_token !== "string" || !tokens.access_token.trim()) {
          throw new Error("Token response missing access_token");
        }
        const saved = { ...tokens, web_auth: { scope: identity.scope, generation: record.generation } };
        // Retain the existing credential file's ACL/protection, as saveTokens
        // did before coordination. Completion is published only after this
        // synchronous write; followers never treat a partial file as success.
        writeFileSync(identity.tokenFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
        finished = true;
        record.status = "complete";
        record.completed_at = Date.now();
        publish(identity.recordFile, record);
        snapshot = { ...snapshot, status: "complete", completed_at: record.completed_at };
        // Give followers time to observe completion. No credential IPC.
        clearTimeout(expiry);
        setTimeout(release, settleMs).unref();
        return saved;
      } catch (err) {
        finished = true;
        snapshot = { ...snapshot, status: "failed" };
        if (!released) {
          record.status = "failed";
          try { publish(identity.recordFile, record); } catch {}
        }
        release();
        throw err;
      }
    }

    // An unknown service/hash collision, unpublished or damaged record never
    // licenses another port/owner. Wait boundedly and fail closed.
    const existing = readJson(identity.recordFile);
    if (validRecord(existing, identity)) {
      try {
        const current = await status(identity, existing);
        if (followedGeneration && followedGeneration !== current.generation) {
          followedGeneration = null;
          followDeadline = 0;
        }
        if (current.status === "complete") {
          if (current.generation !== followedGeneration && current.completed_at < startedAt) throw failure();
          return completedTokens(identity, current.generation);
        }
        if (current.status === "failed") throw new Error("OAuth owner failed; retry.");
        if (current.status === "pending") {
          if (typeof current.pending?.authorize_url !== "string" ||
              current.pending.expires_at !== existing.expires_at ||
              !["http:", "https:"].includes(new URL(current.pending.authorize_url).protocol)) throw failure();
          onPending(current.pending);
          followedGeneration = current.generation;
          followDeadline = existing.expires_at;
        }
      } catch (err) {
        // A matching completed generation with bad/stale credentials is an
        // error, not permission to elect a second live owner.
        if (err.message?.startsWith("OAuth completion") || err.message === "OAuth owner failed; retry.") throw err;
      }
    }
    await wait(100);
  }
  throw failure();
}
