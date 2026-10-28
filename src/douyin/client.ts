import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { refreshAccessToken } from './oauth.js';
import {
  getToken,
  upsertToken,
  type DouyinTokenRecord,
} from './tokens.js';

const CHUNK_THRESHOLD = 50 * 1024 * 1024; // 50MB — Douyin recommends chunked above this
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB

export class DouyinApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'DouyinApiError';
  }
}

async function ensureFreshToken(openId?: string): Promise<DouyinTokenRecord> {
  let record = await getToken(openId);
  if (!record) {
    throw new DouyinApiError(
      '未授权：请先 get_auth_url → 用户扫码授权 → complete_oauth'
    );
  }
  const skew = 60_000;
  if (record.expires_at > Date.now() + skew) {
    return record;
  }
  if (record.refresh_expires_at <= Date.now()) {
    throw new DouyinApiError('refresh_token 已过期，请重新 OAuth');
  }
  const refreshed = await refreshAccessToken(record.refresh_token);
  const merged: DouyinTokenRecord = {
    ...record,
    ...refreshed,
    open_id: refreshed.open_id || record.open_id,
    refresh_token: refreshed.refresh_token || record.refresh_token,
    refresh_expires_at:
      refreshed.refresh_expires_at || record.refresh_expires_at,
  };
  await upsertToken(merged);
  return merged;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function assertOk(json: any, label: string): void {
  const code =
    json?.data?.error_code ?? json?.extra?.error_code ?? json?.error_code;
  const n = code === undefined || code === null || code === '' ? 0 : Number(code);
  if (!Number.isNaN(n) && n !== 0) {
    const desc =
      json?.data?.description ??
      json?.extra?.description ??
      json?.description ??
      '';
    throw new DouyinApiError(`${label} 失败: error_code=${n} ${desc}`, undefined, json);
  }
}

/**
 * Upload video (simple or auto-chunked).
 * POST /api/douyin/v1/video/upload_video/
 */
export async function uploadVideo(opts: {
  filePath?: string;
  url?: string;
  openId?: string;
}): Promise<{ video_id: string; width?: number; height?: number; raw: unknown }> {
  if (!opts.filePath && !opts.url) {
    throw new DouyinApiError('需要提供 file_path 或 url');
  }

  let localPath = opts.filePath;
  let cleanup: string | undefined;

  if (opts.url && !opts.filePath) {
    const tmpDir = path.join(config.rootDir, 'tmp');
    await fsPromises.mkdir(tmpDir, { recursive: true });
    const ext = guessExt(opts.url);
    cleanup = path.join(tmpDir, `dl-${Date.now()}${ext}`);
    await downloadToFile(opts.url, cleanup);
    localPath = cleanup;
  }

  try {
    const token = await ensureFreshToken(opts.openId);
    const stat = await fsPromises.stat(localPath!);
    if (stat.size > CHUNK_THRESHOLD) {
      return uploadVideoChunked(localPath!, token, stat.size);
    }
    return uploadVideoSimple(localPath!, token);
  } finally {
    if (cleanup) {
      await fsPromises.unlink(cleanup).catch(() => undefined);
    }
  }
}

async function uploadVideoSimple(
  filePath: string,
  token: DouyinTokenRecord
): Promise<{ video_id: string; width?: number; height?: number; raw: unknown }> {
  const buf = await fsPromises.readFile(filePath);
  const form = new FormData();
  form.append(
    'video',
    new Blob([buf], { type: 'video/mp4' }),
    path.basename(filePath)
  );

  const url = `${config.douyin.apiBase}/api/douyin/v1/video/upload_video/?open_id=${encodeURIComponent(token.open_id)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'access-token': token.access_token,
    },
    body: form,
  });

  const json: any = await parseJson(res);
  if (!res.ok) {
    throw new DouyinApiError(`上传 HTTP ${res.status}`, res.status, json);
  }
  assertOk(json, 'upload_video');
  const video = json?.data?.video;
  if (!video?.video_id) {
    throw new DouyinApiError('上传成功但未返回 video_id', res.status, json);
  }
  return {
    video_id: video.video_id,
    width: video.width,
    height: video.height,
    raw: json,
  };
}

/**
 * Chunked upload for >50MB (required >128MB).
 */
async function uploadVideoChunked(
  filePath: string,
  token: DouyinTokenRecord,
  size: number
): Promise<{ video_id: string; width?: number; height?: number; raw: unknown }> {
  const base = config.douyin.apiBase;
  const openId = encodeURIComponent(token.open_id);
  const headers = { 'access-token': token.access_token };

  const initRes = await fetch(
    `${base}/api/douyin/v1/video/init_video_part_upload/?open_id=${openId}`,
    { method: 'POST', headers }
  );
  const initJson: any = await parseJson(initRes);
  assertOk(initJson, 'init_video_part_upload');
  const uploadId = initJson?.data?.upload_id;
  if (!uploadId) {
    throw new DouyinApiError('分片初始化未返回 upload_id', undefined, initJson);
  }

  const fd = await fsPromises.open(filePath, 'r');
  try {
    let partNumber = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CHUNK_SIZE, size - offset);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, offset);
      const form = new FormData();
      form.append('upload_id', uploadId);
      form.append('part_number', String(partNumber));
      form.append(
        'video',
        new Blob([buf], { type: 'application/octet-stream' }),
        `part${partNumber}.mp4`
      );
      const partUrl = `${base}/api/douyin/v1/video/upload_video_part/?open_id=${openId}`;
      const partRes = await fetch(partUrl, {
        method: 'POST',
        headers,
        body: form,
      });
      const partJson: any = await parseJson(partRes);
      assertOk(partJson, `upload_video_part#${partNumber}`);
      offset += len;
      partNumber += 1;
    }
  } finally {
    await fd.close();
  }

  const finishRes = await fetch(
    `${base}/api/douyin/v1/video/complete_video_part_upload/?open_id=${openId}`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ upload_id: uploadId }),
    }
  );
  const finishJson: any = await parseJson(finishRes);
  assertOk(finishJson, 'complete_video_part_upload');
  const video = finishJson?.data?.video;
  if (!video?.video_id) {
    throw new DouyinApiError('分片完成未返回 video_id', undefined, finishJson);
  }
  return {
    video_id: video.video_id,
    width: video.width,
    height: video.height,
    raw: finishJson,
  };
}

/**
 * Create / publish a video.
 * POST /api/douyin/v1/video/create_video/
 */
export async function createVideo(opts: {
  videoId: string;
  text: string;
  coverTsp?: number;
  privateStatus?: number;
  openId?: string;
}): Promise<{ item_id?: string; video_id?: string; raw: unknown }> {
  const token = await ensureFreshToken(opts.openId);
  const url = `${config.douyin.apiBase}/api/douyin/v1/video/create_video/?open_id=${encodeURIComponent(token.open_id)}`;
  const body: Record<string, unknown> = {
    video_id: opts.videoId,
    text: opts.text,
  };
  if (opts.coverTsp !== undefined) body.cover_tsp = opts.coverTsp;
  if (opts.privateStatus !== undefined) body.private_status = opts.privateStatus;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'access-token': token.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json: any = await parseJson(res);
  if (!res.ok) {
    throw new DouyinApiError(`create_video HTTP ${res.status}`, res.status, json);
  }
  assertOk(json, 'create_video');
  return {
    item_id: json?.data?.item_id,
    video_id: json?.data?.video_id,
    raw: json,
  };
}

/**
 * List authorized account videos.
 */
export async function listVideos(opts: {
  cursor?: number;
  count?: number;
  openId?: string;
}): Promise<{ list: unknown[]; cursor: number; has_more: boolean; raw: unknown }> {
  const token = await ensureFreshToken(opts.openId);
  const cursor = opts.cursor ?? 0;
  const count = Math.min(opts.count ?? 10, 20);
  const qs = new URLSearchParams({
    open_id: token.open_id,
    cursor: String(cursor),
    count: String(count),
  });

  const tryUrls = [
    `${config.douyin.apiBase}/api/douyin/v1/video/video_list/?${qs}`,
    `${config.douyin.apiBase}/video/list/?${qs}`,
  ];

  let lastErr: unknown;
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'access-token': token.access_token,
          'Content-Type': 'application/json',
        },
      });
      const json: any = await parseJson(res);
      if (!res.ok) {
        lastErr = new DouyinApiError(`list HTTP ${res.status}`, res.status, json);
        continue;
      }
      assertOk(json, 'video_list');
      return {
        list: json?.data?.list ?? [],
        cursor: Number(json?.data?.cursor ?? 0),
        has_more: Boolean(json?.data?.has_more),
        raw: json,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new DouyinApiError(String(lastErr));
}

export async function getPublishStatus(opts: {
  itemIds?: string[];
  openId?: string;
}): Promise<{ items: unknown[]; raw: unknown }> {
  const token = await ensureFreshToken(opts.openId);
  if (opts.itemIds?.length) {
    const qs = new URLSearchParams({ open_id: token.open_id });
    const url = `${config.douyin.apiBase}/api/douyin/v1/video/video_data/?${qs}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'access-token': token.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ item_ids: opts.itemIds }),
      });
      const json: any = await parseJson(res);
      if (res.ok) {
        const code = Number(json?.data?.error_code ?? json?.extra?.error_code ?? 0);
        if (code === 0) {
          return { items: json?.data?.list ?? json?.data ?? [], raw: json };
        }
      }
    } catch {
      // fall through
    }
  }

  const listed = await listVideos({ count: 20, openId: opts.openId });
  let items = listed.list;
  if (opts.itemIds?.length) {
    const set = new Set(opts.itemIds);
    items = items.filter((it: any) => set.has(it?.item_id) || set.has(it?.video_id));
  }
  return { items, raw: listed.raw };
}

function guessExt(url: string): string {
  try {
    const p = new URL(url).pathname;
    const ext = path.extname(p);
    if (ext && ext.length <= 5) return ext;
  } catch {
    /* ignore */
  }
  return '.mp4';
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new DouyinApiError(`下载视频失败 HTTP ${res.status}`);
  }
  const file = fs.createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(
      res.body as import('stream/web').ReadableStream
    );
    nodeStream.pipe(file);
    nodeStream.on('error', reject);
    file.on('finish', () => resolve());
    file.on('error', reject);
  });
}
