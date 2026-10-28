import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function requiredInProd(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    // Allow empty at boot so /health works with placeholders; tools will error clearly.
    return '';
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`,
  mcpApiKey: requiredInProd('DOUYIN_MCP_API_KEY', 'test'),
  douyin: {
    clientKey: requiredInProd('DOUYIN_CLIENT_KEY', 'placeholder_client_key'),
    clientSecret: requiredInProd('DOUYIN_CLIENT_SECRET', 'placeholder_client_secret'),
    redirectUri:
      process.env.DOUYIN_REDIRECT_URI ??
      `${process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`}/oauth/callback`,
    scopes: (process.env.DOUYIN_SCOPES ?? 'user_info,video.create.bind,video.list')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    apiBase: 'https://open.douyin.com',
  },
  tokenStorePath: path.resolve(
    rootDir,
    process.env.DOUYIN_TOKEN_STORE ?? './data/tokens.json'
  ),
  rootDir,
};

export type AppConfig = typeof config;
