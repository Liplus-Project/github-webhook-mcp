export const CLIENT_METADATA_PATH: string;
export interface AuthorizationServerMetadata {
  issuer?: string;
  client_id_metadata_document_supported?: boolean;
}
export interface SelectedClient {
  client_id: string;
  method: "client_id_metadata_document" | "dynamic_client_registration";
}
export function clientMetadataUrl(
  metadata: AuthorizationServerMetadata | null | undefined,
  workerUrl: string,
): string | null;
export function selectOAuthClient(
  metadata: AuthorizationServerMetadata,
  workerUrl: string,
  registerDcr: () => Promise<{ client_id: string }>,
): Promise<SelectedClient>;
export function refreshClientId(
  tokenClientId: string | undefined,
  registration: { client_id?: string } | null | undefined,
): string | null;
