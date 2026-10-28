import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export interface DouyinTokenRecord {
  open_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
  refresh_expires_at: number; // unix ms
  scope?: string;
  updated_at: string; // ISO
}

export interface TokenStoreFile {
  accounts: Record<string, DouyinTokenRecord>;
  default_open_id?: string;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(path.dirname(config.tokenStorePath), { recursive: true });
}

export async function loadStore(): Promise<TokenStoreFile> {
  await ensureDir();
  try {
    const raw = await fs.readFile(config.tokenStorePath, 'utf8');
    return JSON.parse(raw) as TokenStoreFile;
  } catch {
    return { accounts: {} };
  }
}

export async function saveStore(store: TokenStoreFile): Promise<void> {
  await ensureDir();
  const tmp = `${config.tokenStorePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, config.tokenStorePath);
}

export async function upsertToken(record: DouyinTokenRecord): Promise<void> {
  const store = await loadStore();
  store.accounts[record.open_id] = record;
  store.default_open_id = record.open_id;
  await saveStore(store);
}

export async function getDefaultToken(): Promise<DouyinTokenRecord | null> {
  const store = await loadStore();
  const id = store.default_open_id;
  if (!id) {
    const first = Object.values(store.accounts)[0];
    return first ?? null;
  }
  return store.accounts[id] ?? null;
}

export async function getToken(openId?: string): Promise<DouyinTokenRecord | null> {
  if (!openId) return getDefaultToken();
  const store = await loadStore();
  return store.accounts[openId] ?? null;
}

export function describeAuthStatus(record: DouyinTokenRecord | null) {
  if (!record) {
    return {
      authenticated: false,
      message: '尚未完成抖音 OAuth。请先调用 get_auth_url，用户授权后用 complete_oauth 换 token。',
    };
  }
  const now = Date.now();
  const accessValid = record.expires_at > now;
  const refreshValid = record.refresh_expires_at > now;
  return {
    authenticated: true,
    open_id: record.open_id,
    scope: record.scope,
    access_token_expires_at: new Date(record.expires_at).toISOString(),
    refresh_token_expires_at: new Date(record.refresh_expires_at).toISOString(),
    access_token_valid: accessValid,
    refresh_token_valid: refreshValid,
    updated_at: record.updated_at,
    message: accessValid
      ? 'access_token 有效'
      : refreshValid
        ? 'access_token 已过期，下次 API 调用会尝试 refresh'
        : 'token 均已过期，需要重新 OAuth',
  };
}
