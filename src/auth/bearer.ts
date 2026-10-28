import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

/**
 * Bot → MCP: require Authorization: Bearer ${DOUYIN_MCP_API_KEY}
 */
export function requireMcpBearer(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? req.header('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();

  if (!config.mcpApiKey) {
    res.status(500).json({
      error: 'server_misconfigured',
      message: 'DOUYIN_MCP_API_KEY is not set',
    });
    return;
  }

  if (!token || token !== config.mcpApiKey) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid Authorization Bearer token',
    });
    return;
  }

  next();
}
