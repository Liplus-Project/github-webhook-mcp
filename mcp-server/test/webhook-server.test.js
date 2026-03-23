import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { startWebhookServer, shouldStoreEvent } from "../server/webhook-server.js";

function httpRequest({ port, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("notifications profile filters noisy events", () => {
  assert.equal(shouldStoreEvent("issues", { action: "opened" }, "notifications"), true);
  assert.equal(shouldStoreEvent("workflow_job", { action: "completed" }, "notifications"), false);
});

test("embedded webhook listener verifies signature and stores allowed events", async () => {
  const calls = [];
  const server = await startWebhookServer({
    host: "127.0.0.1",
    port: 18080,
    secret: "test-secret",
    eventProfile: "notifications",
    onEvent: async (eventType, payload) => {
      calls.push({ eventType, payload });
      return { id: "evt-1" };
    },
    logger: { error() {} },
  });

  try {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 1, title: "hello" },
      repository: { full_name: "Liplus-Project/github-webhook-mcp" },
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

    const response = await httpRequest({
      port: 18080,
      path: "/webhook",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, "issues");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
