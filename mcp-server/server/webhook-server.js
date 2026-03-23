import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const NOTIFICATION_EVENT_ACTIONS = {
  issues: new Set(["assigned", "closed", "opened", "reopened", "unassigned"]),
  issue_comment: new Set(["created"]),
  pull_request: new Set([
    "assigned",
    "closed",
    "converted_to_draft",
    "opened",
    "ready_for_review",
    "reopened",
    "review_requested",
    "review_request_removed",
    "synchronize",
    "unassigned",
  ]),
  pull_request_review: new Set(["dismissed", "submitted"]),
  pull_request_review_comment: new Set(["created"]),
  check_run: new Set(["completed"]),
  workflow_run: new Set(["completed"]),
  discussion: new Set(["answered", "closed", "created", "reopened"]),
  discussion_comment: new Set(["created"]),
};

export function normalizeEventProfile(profile) {
  const normalized = (profile || "all").trim().toLowerCase();
  if (normalized !== "all" && normalized !== "notifications") {
    throw new Error(`Unknown event profile: ${profile}`);
  }
  return normalized;
}

export function shouldStoreEvent(eventType, payload, profile) {
  const normalized = normalizeEventProfile(profile);
  if (normalized === "all") return true;
  const actions = NOTIFICATION_EVENT_ACTIONS[eventType];
  if (!actions) return false;
  return actions.has(payload?.action);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function verifySignature(body, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = Buffer.from(signatureHeader, "utf-8");
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "utf-8",
  );
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function startWebhookServer({
  host,
  port,
  secret,
  eventProfile,
  onEvent,
  logger = console,
}) {
  const normalizedProfile = normalizeEventProfile(eventProfile);
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        jsonResponse(res, 200, { status: "ok" });
        return;
      }

      if (req.method !== "POST" || req.url !== "/webhook") {
        jsonResponse(res, 404, { detail: "Not found" });
        return;
      }

      const body = await readRequestBody(req);
      const signature = req.headers["x-hub-signature-256"];
      if (!verifySignature(body, Array.isArray(signature) ? signature[0] : signature, secret)) {
        jsonResponse(res, 401, { detail: "Invalid signature" });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body.toString("utf-8"));
      } catch {
        jsonResponse(res, 400, { detail: "Invalid JSON" });
        return;
      }

      const eventType = Array.isArray(req.headers["x-github-event"])
        ? req.headers["x-github-event"][0]
        : req.headers["x-github-event"] || "";

      if (!shouldStoreEvent(eventType, payload, normalizedProfile)) {
        jsonResponse(res, 200, {
          ignored: true,
          type: eventType,
          profile: normalizedProfile,
        });
        return;
      }

      const event = await onEvent(eventType, payload);
      jsonResponse(res, 200, { id: event.id, type: eventType });
    } catch (error) {
      logger.error?.("[github-webhook-mcp] embedded webhook listener failed", error);
      if (!res.headersSent) {
        jsonResponse(res, 500, { detail: "internal_error" });
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  logger.error?.(
    `[github-webhook-mcp] embedded webhook listener started at http://${host}:${port}`,
  );

  return server;
}
