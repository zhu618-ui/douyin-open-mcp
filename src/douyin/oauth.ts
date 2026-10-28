import { config } from '../config.js';
import { upsertToken, type DouyinTokenRecord } from './tokens.js';

export function buildAuthorizeUrl(state?: string): string {
  const { clientKey, redirectUri, scopes, apiBase } = config.douyin;
  if (!clientKey || clientKey === 'placeholder_client_key') {
    throw new Error(
      'DOUYIN_CLIENT_KEY 未配置。请在 open.douyin.com 创建应用后写入 .env'
    );
  }
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: scopes.join(','),
    redirect_uri: redirectUri,
  });
  if (state) params.set('state', state);
  return `${apiBase}/platform/oauth/connect/?${params.toString()}`;
}

interface TokenApiData {
  error_code?: number | string;
  description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  refresh_expires_in?: number | string;
  open_id?: string;
  scope?: string;
}

function toNumber(v: number | string | undefined, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseTokenPayload(data: TokenApiData): DouyinTokenRecord {
  const err = toNumber(data.error_code, 0);
  if (err !== 0 || !data.access_token || !data.open_id || !data.refresh_token) {
    throw new Error(
      `抖音换 token 失败: error_code=${data.error_code} ${data.description ?? ''}`
    );
  }
  const now = Date.now();
  const expiresIn = toNumber(data.expires_in, 15 * 24 * 3600);
  const refreshExpiresIn = toNumber(data.refresh_expires_in, 30 * 24 * 3600);
  return {
    open_id: data.open_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + expiresIn * 1000,
    refresh_expires_at: now + refreshExpiresIn * 1000,
    scope: data.scope,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Exchange authorization code for tokens and persist.
 * Docs: POST https://open.douyin.com/oauth/access_token/
 */
export async function exchangeCodeForToken(code: string): Promise<DouyinTokenRecord> {
  const { clientKey, clientSecret, apiBase } = config.douyin;
  if (!clientKey || clientKey === 'placeholder_client_key') {
    throw new Error('DOUYIN_CLIENT_KEY 未配置');
  }
  if (!clientSecret || clientSecret === 'placeholder_client_secret') {
    throw new Error('DOUYIN_CLIENT_SECRET 未配置');
  }

  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
  });

  const res = await fetch(`${apiBase}/oauth/access_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { data?: TokenApiData; message?: string };
  if (!json.data) {
    throw new Error(`换 token 无 data 字段: ${JSON.stringify(json)}`);
  }
  const record = parseTokenPayload(json.data);
  await upsertToken(record);
  return record;
}

/**
 * Refresh access_token using refresh_token.
 * Docs: POST https://open.douyin.com/oauth/refresh_token/
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<DouyinTokenRecord> {
  const { clientKey, apiBase } = config.douyin;
  const body = new URLSearchParams({
    client_key: clientKey,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(`${apiBase}/oauth/refresh_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { data?: TokenApiData };
  if (!json.data) {
    throw new Error(`refresh 无 data: ${JSON.stringify(json)}`);
  }
  // refresh response may omit open_id; caller merges
  const record = parseTokenPayload({
    ...json.data,
    open_id: json.data.open_id,
    refresh_token: json.data.refresh_token ?? refreshToken,
  });
  return record;
}
