export const WEB_AUTH_START_MS: number;
export const WEB_AUTH_LIFETIME_MS: number;
export interface PendingWebAuth { authorize_url: string; expires_at: number }
export interface CoordinatedTokens {
  flow: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  web_auth?: { scope: string; generation: string };
}
export function webAuthScope(workerUrl: string, tokenDir: string): Promise<{
  scope: string; port: number; recordFile: string; tokenFile: string;
}>;
export function coordinateWebAuth(options: {
  workerUrl: string; tokenDir: string;
  onPending: (pending: PendingWebAuth) => void;
  runOwner: (owner: {
    signal: AbortSignal; assertOwner: () => void;
    pending: (pending: { authorize_url: string }) => void;
  }) => Promise<CoordinatedTokens>;
  startMs?: number; lifetimeMs?: number; settleMs?: number;
}): Promise<CoordinatedTokens>;
