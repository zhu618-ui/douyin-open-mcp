# 架构说明（对照 Socialync 式 TikTok MCP）

## 为什么不能直接复用 TikTok 开源项目

| 维度 | TikTok MCP（如 Socialync / aaronckj） | 本项目（抖音） |
|------|----------------------------------------|----------------|
| 开放平台 | developers.tiktok.com | open.douyin.com |
| OAuth / token | TikTok Login Kit / Content Posting | 抖音 OAuth2（code → access_token） |
| 发布 API | Content Posting API | `/api/douyin/v1/video/upload_video/` → `create_video/` |
| Scope | `video.upload` 等 | `video.create.bind` / `video.list` / `user_info` |
| 定时 | 部分官方或 Studio | **无公开 schedule 字段** → Phase 3 自建队列 |
| Grok Bot 接入 | 远程 HTTPS + Bearer/OAuth | 同左（本服务实现 Bearer） |

产品形态相似（短视频创作），但 **密钥、域名、字段、审核、限流全部不互通**。可抄的是「远程 MCP 壳」，不可抄的是「调哪家 HTTP」。

## 从 Socialync 抄来的设计

1. **远程 Streamable HTTP**，路径 `/mcp`，而非本地 stdio（Grok Bot 硬性要求）。  
2. **Bot→MCP 用 Bearer API Key**，避免依赖云端 OAuth 回调不稳定问题。  
3. **写操作标注人工确认**：`create_post` 强制 `user_confirmed: true`，对齐「destructive 需审批」。  
4. **媒体先上传拿 id，再创建帖子**：`upload_video` → `video_id` → `create_post`。  
5. **分阶段工具面**：发布先上线，定时/评论先占位，避免一口吃成。

## 本服务分层

```
src/index.ts          Express：/health、/oauth/callback、/mcp(+Bearer)
src/auth/bearer.ts    Bot → MCP 鉴权
src/mcp/server.ts     MCP 工具注册（薄封装）
src/douyin/oauth.ts   授权 URL、换票、刷新
src/douyin/client.ts  上传（含分片）、创建、列表、状态
src/douyin/tokens.ts  本地 JSON token 仓（./data）
src/config.ts         环境变量
```

## 鉴权双层

1. **Grok Bot → 本 MCP**：`Authorization: Bearer ${DOUYIN_MCP_API_KEY}`  
2. **本 MCP → 抖音**：用户 OAuth 的 `access-token` 请求头 + `open_id` 查询参数  

Token 只存服务端 `data/tokens.json`，工具响应不回传明文 access_token。

## 传输选型说明

选用 **TypeScript + `@modelcontextprotocol/sdk` v1 + Express + `StreamableHTTPServerTransport`**：

- 与多数远程 MCP 示例一致，便于 Grok Bot / Cursor 类客户端对接；  
- 有会话（`mcp-session-id`）的 initialize 流程；  
- `/health` 无鉴权，方便探针。

若未来要迁 MCP SDK v2，可换成 `@modelcontextprotocol/server` + `@modelcontextprotocol/node` 的 `NodeStreamableHTTPServerTransport`，业务层（`douyin/*`）无需改动。

## Phase 3 定时将如何做（预告）

官方 `create_video` 无「未来时刻发布」字段。计划：

- DB/JSON 存 `{ video_id, text, publish_at, status }`  
- Worker/cron 到点调用现有 `createVideo()`  
- MCP 工具 `schedule_post` / `list_scheduled` / `cancel_scheduled` 操作队列  

默认不做创作者中心非官方 `timing` 接口，以免 ToS/封号风险。
