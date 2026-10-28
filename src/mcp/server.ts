import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { buildAuthorizeUrl, exchangeCodeForToken } from '../douyin/oauth.js';
import {
  createVideo,
  DouyinApiError,
  getPublishStatus,
  listVideos,
  uploadVideo,
} from '../douyin/client.js';
import { describeAuthStatus, getToken } from '../douyin/tokens.js';

function text(result: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

function errText(e: unknown) {
  const msg =
    e instanceof DouyinApiError
      ? `${e.message}${e.body ? `\n${JSON.stringify(e.body, null, 2)}` : ''}`
      : e instanceof Error
        ? e.message
        : String(e);
  return {
    content: [{ type: 'text' as const, text: `错误: ${msg}` }],
    isError: true as const,
  };
}

const phaseStub = (phase: string, name: string) =>
  text({
    implemented: false,
    phase,
    tool: name,
    message: `${phase} — 尚未实现。Phase 1 仅覆盖 OAuth + 上传 + 创建 + 列表/状态。`,
  });

/**
 * Create a fresh McpServer with all tools registered.
 * Prefer one server instance per MCP session.
 */
export function createDouyinMcpServer(): McpServer {
  const server = new McpServer({
    name: 'douyin-open-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'auth_status',
    {
      description: '查看当前抖音 OAuth token 是否存在、是否过期（不返回明文 token）',
    },
    async () => {
      try {
        const record = await getToken();
        return text(describeAuthStatus(record));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'get_auth_url',
    {
      description:
        '生成抖音 OAuth 授权 URL。用户用抖音 App 扫码授权后，回调会带 code；再用 complete_oauth。Scopes 见 README / DOUYIN_SCOPES。',
      inputSchema: {
        state: z.string().optional().describe('可选 state，原样回传，防 CSRF'),
      },
    },
    async ({ state }) => {
      try {
        const url = buildAuthorizeUrl(state);
        return text({
          authorize_url: url,
          redirect_uri: config.douyin.redirectUri,
          scopes: config.douyin.scopes,
          instructions:
            '1) 在浏览器打开 authorize_url\n2) 抖音扫码授权\n3) 从回调 URL 或页面拿到 code\n4) 调用 complete_oauth({ code })',
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'complete_oauth',
    {
      description:
        '用授权码 code 换取 access_token / refresh_token / open_id，并保存到本地 data/tokens.json',
      inputSchema: {
        code: z.string().describe('OAuth 回调拿到的 code'),
      },
    },
    async ({ code }) => {
      try {
        const record = await exchangeCodeForToken(code);
        return text({
          ok: true,
          open_id: record.open_id,
          scope: record.scope,
          access_token_expires_at: new Date(record.expires_at).toISOString(),
          refresh_token_expires_at: new Date(record.refresh_expires_at).toISOString(),
          message: '已保存 token（明文不会回传）。可用 auth_status 复查。',
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'upload_video',
    {
      description:
        '上传视频到抖音文件服务器，返回加密 video_id（尚未发布）。可传本机路径或可下载 URL。>50MB 自动分片。',
      inputSchema: {
        file_path: z.string().optional().describe('服务器本机视频路径'),
        url: z.string().url().optional().describe('可公开下载的视频 URL'),
        open_id: z
          .string()
          .optional()
          .describe('多账号时指定 open_id；默认最近授权账号'),
      },
    },
    async ({ file_path, url, open_id }) => {
      try {
        const result = await uploadVideo({
          filePath: file_path,
          url,
          openId: open_id,
        });
        return text({
          video_id: result.video_id,
          width: result.width,
          height: result.height,
          next: '调用 create_post 并带上 video_id 与标题；发布前请向用户确认文案与可见性。',
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'create_post',
    {
      description:
        '【需人工确认】使用已上传的 video_id 创建/发布抖音视频。平台要求代发须用户明确感知；请先在对话中展示标题/可见性，用户确认后再调用。创建后会有审核期，期间可能仅自见。',
      inputSchema: {
        video_id: z.string().describe('upload_video 返回的加密 video_id'),
        text: z
          .string()
          .max(1000)
          .describe('标题文案，可含 #话题 与 @昵称，总长 ≤1000'),
        cover_tsp: z.number().optional().describe('封面时间点（秒），取该帧作封面'),
        private_status: z
          .number()
          .int()
          .min(0)
          .max(2)
          .optional()
          .describe('0=全部可见 1=仅自己 2=好友可见；建议首次用 1 自见测试'),
        open_id: z.string().optional(),
        user_confirmed: z
          .boolean()
          .describe('必须为 true，表示用户已在对话中确认要发布'),
      },
      annotations: {
        title: 'Create Douyin Post',
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (!args.user_confirmed) {
          return errText(
            new Error(
              '拒绝发布：user_confirmed 必须为 true。请先向用户展示标题与可见性并获得确认。'
            )
          );
        }
        const result = await createVideo({
          videoId: args.video_id,
          text: args.text,
          coverTsp: args.cover_tsp,
          privateStatus: args.private_status,
          openId: args.open_id,
        });
        return text({
          ok: true,
          item_id: result.item_id,
          video_id: result.video_id,
          note: '已提交创建；审核完成前可能仅作者可见。可用 get_publish_status / list_my_videos 查看。',
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'list_my_videos',
    {
      description: '分页列出当前授权账号的作品（含审核状态与基础统计，视权限而定）',
      inputSchema: {
        cursor: z.number().int().optional().describe('分页游标，默认 0'),
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('每页条数，默认 10，最大 20'),
        open_id: z.string().optional(),
      },
    },
    async ({ cursor, count, open_id }) => {
      try {
        const result = await listVideos({ cursor, count, openId: open_id });
        return text(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'get_publish_status',
    {
      description: '查询作品状态：可传 item_ids；若不传则返回最近作品列表供核对',
      inputSchema: {
        item_ids: z
          .array(z.string())
          .optional()
          .describe('create_post 返回的 item_id 列表'),
        open_id: z.string().optional(),
      },
    },
    async ({ item_ids, open_id }) => {
      try {
        const result = await getPublishStatus({ itemIds: item_ids, openId: open_id });
        return text(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    'schedule_post',
    {
      description:
        '【Phase 3 占位】自建定时队列到点再调 create_video（官方无 schedule 字段）',
      inputSchema: {
        video_id: z.string().optional(),
        text: z.string().optional(),
        publish_at: z.string().optional().describe('ISO8601 计划发布时间'),
      },
    },
    async () => phaseStub('Phase 3', 'schedule_post')
  );

  server.registerTool(
    'list_scheduled',
    {
      description: '【Phase 3 占位】列出本地调度队列中的待发任务',
    },
    async () => phaseStub('Phase 3', 'list_scheduled')
  );

  server.registerTool(
    'cancel_scheduled',
    {
      description: '【Phase 3 占位】取消本地调度任务',
      inputSchema: {
        job_id: z.string().optional(),
      },
    },
    async () => phaseStub('Phase 3', 'cancel_scheduled')
  );

  server.registerTool(
    'list_comments',
    {
      description:
        '【Phase 4 占位】列出作品评论（需互动管理权限 item.comment / video.comment）',
      inputSchema: {
        item_id: z.string().optional(),
        cursor: z.number().optional(),
      },
    },
    async () => phaseStub('Phase 4', 'list_comments')
  );

  server.registerTool(
    'reply_comment',
    {
      description: '【Phase 4 占位】回复评论（需人工确认或规则引擎）',
      inputSchema: {
        comment_id: z.string().optional(),
        content: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async () => phaseStub('Phase 4', 'reply_comment')
  );

  server.registerTool(
    'get_video_stats',
    {
      description: '【Phase 2 占位】拉取作品详细数据用于优化建议（需数据权限）',
      inputSchema: {
        item_id: z.string().optional(),
      },
    },
    async () => phaseStub('Phase 2', 'get_video_stats')
  );

  return server;
}
