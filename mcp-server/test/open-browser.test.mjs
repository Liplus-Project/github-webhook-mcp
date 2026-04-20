/**
 * Argument-construction tests for openBrowser() platform branches.
 *
 * Root cause of #211: on Windows the previous implementation passed the
 * OAuth authorize URL to `cmd.exe /c start "" <URL>` unquoted. cmd.exe
 * interprets `&` as a command separator, truncating URLs like
 *   https://worker/oauth/authorize?client_id=X&state=Y
 * at `&state=...`, dropping the state parameter and breaking the Worker's
 * `/oauth/authorize` handler (`invalid_request: state parameter is required`).
 *
 * The v0.11.2 fix wraps the URL in double quotes and runs through a shell
 * so that cmd.exe treats the quoted `&` as literal. macOS (`open`) and
 * Linux (`xdg-open`) branches are unaffected because both launchers accept
 * `&` as a normal argv character.
 *
 * We re-implement openBrowser() inline for the same reason migration.test.mjs
 * and web-auth-required.test.mjs do: server/index.js cannot be imported
 * without starting an MCP server (top-level await on server.connect).
 * The assertions below lock down the argv shape for each platform and
 * verify the `&`-containing URL survives intact to the spawn boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Platform-parameterised mirror of openBrowser() from server/index.js.
 * Returns the exact { command, args, options } tuple that would be passed
 * to child_process.spawn, without actually spawning anything.
 */
function buildSpawnArgsForPlatform(plat, url) {
  let command;
  let args;
  const options = { detached: true, stdio: "ignore" };

  if (plat === "win32") {
    command = `start "" "${url}"`;
    args = [];
    options.shell = true;
  } else if (plat === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return { command, args, options };
}

const AUTHORIZE_URL_WITH_AMPERSAND =
  "https://github-webhook.smgjp.com/oauth/authorize?client_id=abc123&state=xyz789";

test("windows branch wraps URL in double quotes and runs through shell", () => {
  const { command, args, options } = buildSpawnArgsForPlatform(
    "win32",
    AUTHORIZE_URL_WITH_AMPERSAND,
  );

  // The command string must quote the URL so cmd.exe treats `&` as literal.
  assert.equal(
    command,
    `start "" "${AUTHORIZE_URL_WITH_AMPERSAND}"`,
    "windows command must be `start \"\" \"<url>\"` with the URL in quotes",
  );
  assert.ok(
    command.includes(`"${AUTHORIZE_URL_WITH_AMPERSAND}"`),
    "authorize URL must appear inside the outer double-quote pair",
  );
  assert.deepEqual(args, [], "no separate argv when using shell: true");
  assert.equal(options.shell, true, "shell: true is required for the cmd.exe builtin `start`");
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
});

test("windows branch preserves the state parameter across & (regression for #211)", () => {
  const { command } = buildSpawnArgsForPlatform(
    "win32",
    AUTHORIZE_URL_WITH_AMPERSAND,
  );

  // The whole URL, including everything after `&`, must appear verbatim in
  // the command string — this is the condition that lets cmd.exe's quote
  // handling keep `&state=xyz789` attached to the authorize URL instead of
  // treating it as a second command.
  assert.ok(
    command.includes("&state=xyz789"),
    "state parameter must survive on the Windows command line",
  );
  assert.ok(
    command.includes("client_id=abc123"),
    "client_id must also survive on the Windows command line",
  );
});

test("darwin branch uses `open` with the URL as a plain argv", () => {
  const { command, args, options } = buildSpawnArgsForPlatform(
    "darwin",
    AUTHORIZE_URL_WITH_AMPERSAND,
  );

  assert.equal(command, "open");
  assert.deepEqual(args, [AUTHORIZE_URL_WITH_AMPERSAND]);
  assert.notEqual(options.shell, true, "no shell needed on macOS");
});

test("linux branch uses `xdg-open` with the URL as a plain argv", () => {
  const { command, args, options } = buildSpawnArgsForPlatform(
    "linux",
    AUTHORIZE_URL_WITH_AMPERSAND,
  );

  assert.equal(command, "xdg-open");
  assert.deepEqual(args, [AUTHORIZE_URL_WITH_AMPERSAND]);
  assert.notEqual(options.shell, true, "no shell needed on Linux");
});

test("non-win32 platforms pass URL as single argv element (no cmd interpretation)", () => {
  for (const plat of ["darwin", "linux", "freebsd", "openbsd"]) {
    const { args } = buildSpawnArgsForPlatform(plat, AUTHORIZE_URL_WITH_AMPERSAND);
    assert.equal(args.length, 1, `${plat}: URL must be a single argv element`);
    assert.equal(
      args[0],
      AUTHORIZE_URL_WITH_AMPERSAND,
      `${plat}: URL must survive verbatim (argv bypasses shell interpretation)`,
    );
  }
});

/**
 * Integration-style test: swap in a fake spawn and verify openBrowser's
 * caller-visible side effects. The inline openBrowser mirrors server/index.js
 * exactly; the fake spawn captures the call shape and exposes a `.on` hook so
 * the error-handler wiring is exercised too.
 */
test("openBrowser dispatches to spawn with platform-correct arguments", () => {
  const calls = [];

  function fakeSpawn(command, args, options) {
    calls.push({ command, args, options });
    return {
      on: () => {},
      unref: () => {},
    };
  }

  function openBrowser(url, plat) {
    if (!url || typeof url !== "string") return;
    const { command, args, options } = buildSpawnArgsForPlatform(plat, url);
    const child = fakeSpawn(command, args, options);
    child.on("error", () => {});
    if (typeof child.unref === "function") child.unref();
  }

  openBrowser(AUTHORIZE_URL_WITH_AMPERSAND, "win32");
  openBrowser(AUTHORIZE_URL_WITH_AMPERSAND, "darwin");
  openBrowser(AUTHORIZE_URL_WITH_AMPERSAND, "linux");

  assert.equal(calls.length, 3);

  // win32
  assert.equal(calls[0].command, `start "" "${AUTHORIZE_URL_WITH_AMPERSAND}"`);
  assert.equal(calls[0].options.shell, true);

  // darwin
  assert.equal(calls[1].command, "open");
  assert.deepEqual(calls[1].args, [AUTHORIZE_URL_WITH_AMPERSAND]);

  // linux
  assert.equal(calls[2].command, "xdg-open");
  assert.deepEqual(calls[2].args, [AUTHORIZE_URL_WITH_AMPERSAND]);
});

test("openBrowser is a no-op on empty/invalid input", () => {
  const calls = [];
  function fakeSpawn() {
    calls.push("called");
    return { on: () => {}, unref: () => {} };
  }
  function openBrowser(url, plat) {
    if (!url || typeof url !== "string") return;
    const { command, args, options } = buildSpawnArgsForPlatform(plat, url);
    fakeSpawn(command, args, options);
  }

  openBrowser("", "win32");
  openBrowser(null, "win32");
  openBrowser(undefined, "win32");
  openBrowser(42, "win32");

  assert.equal(calls.length, 0, "invalid URLs must short-circuit before spawn");
});
