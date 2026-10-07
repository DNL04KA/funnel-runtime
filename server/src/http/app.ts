import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ADMIN_TOKEN, FUNNEL_ID, WEB_DIST } from '../env.js';
import type { Db } from '../db/index.js';
import { DomainError } from '../domain/versions.js';
import { registerFunnelRoutes } from './routes/funnel.js';
import { registerEventRoutes } from './routes/events.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';

export interface AppContext {
  db: Db;
  funnelId: string;
}

export function createApp(db: Db, opts: { serveStatic?: boolean; funnelId?: string } = {}): Express {
  const ctx: AppContext = { db, funnelId: opts.funnelId ?? FUNNEL_ID };
  const app = express();

  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, funnel_id: ctx.funnelId, now: new Date().toISOString() });
  });

  registerFunnelRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Эндпоинт не найден' });
  });

  if (opts.serveStatic !== false && existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    // SPA fallback: the client router owns every non-/api path.
    app.get('*', (_req, res) => {
      res.sendFile(resolve(WEB_DIST, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
      return;
    }
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return app;
}

/** Wraps a sync handler so thrown DomainErrors reach the error middleware. */
export function handler(
  fn: (req: Request, res: Response) => void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_TOKEN) {
    next();
    return;
  }
  const presented = req.header('x-admin-token') ?? '';
  if (presented !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'Требуется заголовок x-admin-token' });
    return;
  }
  next();
}
