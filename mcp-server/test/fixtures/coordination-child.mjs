import { coordinateWebAuth } from "../../server/web-auth-coordinator.js";

const options = JSON.parse(process.env.COORDINATION_TEST_OPTIONS);
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
