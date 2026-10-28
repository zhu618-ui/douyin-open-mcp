import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { requireMcpBearer } from './auth/bearer.js';
import { createDouyinMcpServer } from './mcp/server.js';
import { exchangeCodeForToken } from './douyin/oauth.js';

const app = express();
app.use(express.json({ limit: '4mb' }));

/** Health — no auth, for deploy probes */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'douyin-open-mcp',
    version: '0.1.0',
    phase: 1,
    mcp_path: '/mcp',
  });
});

/** Optional browser OAuth callback helper (also usable via complete_oauth tool) */
app.get('/oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const err = typeof req.query.error === 'string' ? req.query.error : '';
  if (err) {
    res.status(400).send(`<h1>授权失败</h1><pre>${err}</pre>`);
    return;
  }
  if (!code) {
    res
      .status(400)
      .send('<h1>缺少 code</h1><p>请从授权回调 URL 复制 code，或用 MCP 工具 complete_oauth。</p>');
    return;
  }
  try {
    // Only auto-exchange when Douyin credentials look configured
    if (
      config.douyin.clientKey &&
      config.douyin.clientKey !== 'placeholder_client_key'
    ) {
      const record = await exchangeCodeForToken(code);
      res.send(
        `<h1>授权成功</h1><p>open_id: <code>${record.open_id}</code></p><p>token 已写入服务器 data/tokens.json。可回到 Grok Bot 调用 auth_status。</p><p>state=${state}</p>`
      );
    } else {
      res.send(
        `<h1>拿到 code</h1><p>请把下面的 code 交给 MCP 工具 <code>complete_oauth</code>：</p><pre>${code}</pre><p>state=${state}</p>`
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).send(`<h1>换 token 失败</h1><pre>${msg}</pre><p>code 仍可用 complete_oauth 重试一次：</p><pre>${code}</pre>`);
  }
});

type Session = { transport: StreamableHTTPServerTransport };
const sessions = new Map<string, Session>();

async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!.transport;
    } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport: transport! });
        },
      });
      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid) sessions.delete(sid);
      };
      const server = createDouyinMcpServer();
      await server.connect(transport);
    } else if (sessionId) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    } else if (req.method === 'POST') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID; send initialize first',
        },
        id: null,
      });
      return;
    } else {
      res.status(400).send('Missing mcp-session-id');
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

app.post('/mcp', requireMcpBearer, (req, res) => {
  void handleMcp(req, res);
});
app.get('/mcp', requireMcpBearer, (req, res) => {
  void handleMcp(req, res);
});
app.delete('/mcp', requireMcpBearer, (req, res) => {
  void handleMcp(req, res);
});

app.listen(config.port, config.host, () => {
  console.log(
    `[douyin-open-mcp] listening on http://${config.host}:${config.port}  mcp=/mcp  health=/health`
  );
  console.log(`[douyin-open-mcp] public base: ${config.publicBaseUrl}`);
});
