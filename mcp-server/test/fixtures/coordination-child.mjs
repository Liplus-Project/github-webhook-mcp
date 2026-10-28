import { coordinateWebAuth } from "../../server/web-auth-coordinator.js";
import { Server } from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const options = JSON.parse(process.env.COORDINATION_TEST_OPTIONS);
if (options.delayScopeMs) {
  const realpath = fsp.realpath;
  fsp.realpath = async (...args) => {
    process.send({ type: "before-scope" });
    await new Promise((resolve) => setTimeout(resolve, options.delayScopeMs));
    return await realpath(...args);
  };
}
const write = fs.writeFileSync;
fs.writeFileSync = (...args) => {
  try { return write(...args); } catch (err) {
    process.send({ type: "filesystem-error", code: err.code, syscall: err.syscall,
      role: /web-auth-[a-f0-9]{64}\.json/.test(String(args[0])) ? "record" : "tokens" });
    throw err;
  }
};
if (options.forbidRename) {
  fs.renameSync = () => {
    process.send({ type: "rename-attempt" });
    throw Object.assign(new Error("synthetic rename sharing failure"), { code: "EPERM" });
  };
}
syncBuiltinESMExports();
if (options.delayListenMs) {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    setTimeout(() => listen.apply(this, args), options.delayListenMs);
    process.send({ type: "before-listen" });
    return this;
  };
}
process.on("message", (message) => { if (message === "exit") process.exit(0); });
coordinateWebAuth({
  ...options,
  onPending: (pending) => process.send({ type: "pending", pending }),
  async runOwner({ signal, assertOwner, pending }) {
    process.send({ type: "owner" });
    const response = await fetch(`${options.workerUrl}/start`, { signal });
    if (!response.ok) throw new Error("synthetic acquisition failure");
    const start = await response.json();
    assertOwner();
    pending({ authorize_url: start.authorize_url });
    await fetch(`${options.workerUrl}/browser?id=${start.id}`, { signal });
    const result = await fetch(`${options.workerUrl}/poll?id=${start.id}`,
      options.ignoreAbort ? {} : { signal });
    const tokens = await result.json();
    if (options.ignoreAbort) {
      try { assertOwner(); } catch { process.send({ type: "stale-rejected" }); }
    }
    return tokens;
  },
}).then((tokens) => process.send({ type: "complete", generation: tokens.web_auth.generation }),
  () => process.send({ type: "error" }));
