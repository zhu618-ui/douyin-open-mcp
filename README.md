# douyin-open-mcp

面向 **Grok Bot** 的抖音（Douyin）远程 MCP 服务：用 **抖音开放平台官方 OpenAPI**（`open.douyin.com`）完成授权、上传、创建视频与作品列表。

> **重要**：TikTok MCP（Socialync / Composio / 各类 `tiktok-mcp`）**不能改名即用**。账号体系、域名、scope、审核与限流完全是另一套。本项目只**借鉴其远程 HTTP + Bearer + 工具面架构**，业务层全部换成抖音 OpenAPI。

当前版本：**Phase 1 脚手架**（OAuth + 上传 + 创建 + 列表/状态）。定时发布、评论回复、深度数据为占位工具。

---

## 1. 这是什么

```
Grok Bot  ──HTTPS + Authorization: Bearer <DOUYIN_MCP_API_KEY>──▶  本服务 /mcp
                                                                       │
                                                                       ▼
                                                              抖音开放平台 OpenAPI
                                                         （用户 OAuth access_token）
```

- 传输：MCP **Streamable HTTP**（`POST/GET/DELETE /mcp`）
- Bot→MCP 鉴权：Bearer API Key（对齐 Socialync「云端 OAuth 不稳就用 Bearer」的实践）
- MCP→抖音：OAuth2 授权码模式，token 落盘 `./data/tokens.json`

技术栈：Node 20+ · TypeScript · `@modelcontextprotocol/sdk` · Express

---

## 2. 在 open.douyin.com 要做的事

1. 打开 [抖音开放平台](https://open.douyin.com) → 创建应用（网站应用即可）。
2. 在应用详情记录 **Client Key / Client Secret**。
3. 配置 **授权回调域名/URI**，与本服务一致，例如：  
   `https://your-mcp.example.com/oauth/callback`
4. 在「能力管理」申请（名称可能微调，以控制台为准）：
   - **视频发布及管理**（对应 scope：`video.create.bind` 或旧版 `video.create`，以及 `video.list`）
   - **用户信息**（`user_info`）
   - 后续 Phase 4：**互动管理**（评论 list/reply，如 `item.comment` / 企业号 `video.comment`）
   - 后续 Phase 2：数据相关权限
5. 等待权限审核通过后再做真实发布联调。

### 建议 scope（环境变量 `DOUYIN_SCOPES`）

```text
user_info,video.create.bind,video.list
```

若控制台仍展示旧 scope，可改为 `user_info,video.create,video.list`。以你应用「已开通」列表为准。

---

## 3. 环境变量

复制 `.env.example` 为 `.env`：

| 变量 | 说明 |
|------|------|
| `DOUYIN_MCP_API_KEY` | Grok Bot 连接时的 Bearer |
| `PORT` / `HOST` | 默认 `8787` / `0.0.0.0` |
| `PUBLIC_BASE_URL` | 公网 HTTPS 基址 |
| `DOUYIN_CLIENT_KEY` / `DOUYIN_CLIENT_SECRET` | 开放平台应用凭证 |
| `DOUYIN_REDIRECT_URI` | 须与控制台回调一致 |
| `DOUYIN_SCOPES` | 逗号分隔 |
| `DOUYIN_TOKEN_STORE` | 默认 `./data/tokens.json` |

**不要把 `.env` 或 `data/*.json` 提交进 Git。**

---

## 4. 本地运行

```bash
cd douyin-open-mcp
cp .env.example .env
# 至少设置 DOUYIN_MCP_API_KEY=test（联调抖音时再填真实 Client Key/Secret）

npm install
npm run dev
# 或：npm run build && npm start
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/health
```

Docker：

```bash
docker compose up --build
```

---

## 5. 部署注意（Grok Bot 必看）

Grok Bot **只能接公网远程 HTTPS MCP**，不能挂本机 `stdio` / `localhost`。

你需要把本服务部署到有 TLS 的公网（Fly.io、Cloudflare Tunnel、自有 VPS + Caddy/Nginx 等），保证：

- `https://your-domain/mcp` 可从公网访问
- `https://your-domain/health` 返回 `ok`
- 回调 `DOUYIN_REDIRECT_URI` 指向同一域名下的 `/oauth/callback`

---

## 6. Grok Bot 连接示例

在自定义 MCP / Add MCP Server 中填写（字段名以产品 UI 为准）：

```json
{
  "mcpServers": {
    "douyin-open": {
      "url": "https://your-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer 替换为与 DOUYIN_MCP_API_KEY 相同的值"
      }
    }
  }
}
```

### Phase 1 推荐对话流程

1. `auth_status` → 若未授权  
2. `get_auth_url` → 浏览器打开 → 抖音扫码  
3. `complete_oauth`（或访问 `/oauth/callback` 自动换票）  
4. `upload_video`（`file_path` 或 `url`）→ 得到 `video_id`  
5. **向用户确认标题 / 可见性** 后 `create_post`（`user_confirmed: true`）  
6. `get_publish_status` / `list_my_videos`

---

## 7. 工具一览

| 工具 | 阶段 | 说明 |
|------|------|------|
| `auth_status` | P1 | token 是否存在/过期 |
| `get_auth_url` | P1 | 生成授权 URL |
| `complete_oauth` | P1 | code → token 落盘 |
| `upload_video` | P1 | 上传，>50MB 自动分片 |
| `create_post` | P1 | 创建视频（需 `user_confirmed`） |
| `list_my_videos` | P1 | 作品列表 |
| `get_publish_status` | P1 | 状态查询 |
| `get_video_stats` | P2 stub | 深度数据 |
| `schedule_post` / `list_scheduled` / `cancel_scheduled` | P3 stub | 自建定时 |
| `list_comments` / `reply_comment` | P4 stub | 评论 |

---

## 8. 路线图

1. **Phase 1（本仓库）**：OAuth + 上传 + 立即发布 + 列表  
2. **Phase 2**：作品数据 / 选题优化辅助  
3. **Phase 3**：本地调度队列到点再 `create_video`（官方无定时字段）  
4. **Phase 4**：评论列表与规则化回复（人工确认）

广告投放（巨量引擎）是另一条产品线，不在本 MCP 范围内。

---

## 9. 官方文档入口

- 上传视频：https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video  
- 创建视频：https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create  
- WEB 授权：https://open.douyin.com/platform/resource/docs/develop/permission/web/permission  

架构对照见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
