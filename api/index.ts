/**
 * VERCEL SERVERLESS ENTRY (Vercel deployment support).
 *
 * Vercel routes every /api/* request here (see vercel.json). This is a thin
 * adapter over the EXISTING server routing — same ToolGate, ProviderRouter,
 * safety rules and graceful degradation; nothing is duplicated.
 *
 * Because classic `routes` rewrite the URL, the original request path is
 * forwarded via the `bkpath` query parameter and restored here, so the shared
 * router sees exactly what the user asked for.
 *
 * Note (honest limitation): serverless instances recycle, so in-memory
 * conversation state persists only per warm instance — single questions and
 * live data are unaffected; long multi-turn chats may occasionally restart.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandleDeps, handleRequest } from './server.js';

// Init once per instance (keys arrive as server-side env vars on Vercel).
const deps = createHandleDeps();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Restore the original public path (e.g. /api/chat) for the shared router.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headerPath = String(req.headers['x-invoke-path'] ?? req.headers['x-vercel-original-path'] ?? '');
    const originalPath = url.searchParams.get('bkpath')
      || (headerPath.startsWith('/api/') ? headerPath : '')
      || (url.pathname.startsWith('/api/') && url.pathname !== '/api' && url.pathname !== '/api/index' ? url.pathname : '');
    if (originalPath && originalPath.startsWith('/api/')) {
      url.searchParams.delete('bkpath');
      req.url = originalPath + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '');
    }
    await handleRequest(req, res, deps);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    }
    res.end(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' }));
  }
}
