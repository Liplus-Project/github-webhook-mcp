/** Client identity selection shared by both bridges (#254, docs F7.15). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_METADATA_PATH, clientMetadataUrl, refreshClientId, selectOAuthClient,
} from "../server/oauth-client.js";

const WORKER = "https://github-webhook.example.org";

test("CIMD is chosen only when advertised and the issuer is https", () => {
  assert.equal(CLIENT_METADATA_PATH, "/oauth/client-metadata.json");
  assert.equal(clientMetadataUrl({ issuer: WORKER, client_id_metadata_document_supported: true }, WORKER),
    `${WORKER}/oauth/client-metadata.json`);
  assert.equal(clientMetadataUrl({ issuer: `${WORKER}/`, client_id_metadata_document_supported: true }, WORKER),
    `${WORKER}/oauth/client-metadata.json`);
  assert.equal(clientMetadataUrl({ client_id_metadata_document_supported: true }, WORKER),
    `${WORKER}/oauth/client-metadata.json`, "missing issuer falls back to the Worker URL");
  assert.equal(clientMetadataUrl({ issuer: WORKER }, WORKER), null);
  assert.equal(clientMetadataUrl({ issuer: WORKER, client_id_metadata_document_supported: "true" }, WORKER), null);
  assert.equal(clientMetadataUrl({ issuer: "http://localhost:8787", client_id_metadata_document_supported: true }, WORKER), null);
  assert.equal(clientMetadataUrl({ issuer: "not a url", client_id_metadata_document_supported: true }, WORKER), null);
  assert.equal(clientMetadataUrl(null, WORKER), null);
});

test("DCR registration runs only on the fallback path", async () => {
  let registrations = 0;
  const register = async () => { registrations++; return { client_id: "dcr-id" }; };
  const cimd = await selectOAuthClient({ issuer: WORKER, client_id_metadata_document_supported: true }, WORKER, register);
  assert.deepEqual(cimd, { client_id: `${WORKER}/oauth/client-metadata.json`, method: "client_id_metadata_document" });
  assert.equal(registrations, 0);
  const dcr = await selectOAuthClient({ issuer: WORKER }, WORKER, register);
  assert.deepEqual(dcr, { client_id: "dcr-id", method: "dynamic_client_registration" });
  assert.equal(registrations, 1);
});

test("refresh presents the client the grant was issued to", () => {
  assert.equal(refreshClientId("https://w.example/oauth/client-metadata.json", { client_id: "dcr" }),
    "https://w.example/oauth/client-metadata.json");
  assert.equal(refreshClientId(undefined, { client_id: "dcr" }), "dcr");
  assert.equal(refreshClientId("", null), null);
});
