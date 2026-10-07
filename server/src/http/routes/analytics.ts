import type { Express } from 'express';
import { z } from 'zod';
import type { VariantId } from '@funnel/shared';
import { handler, type AppContext } from '../app.js';
import { getAnalytics } from '../../domain/analytics.js';

const querySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
  variant: z.enum(['A', 'B']).optional(),
  campaign: z.string().trim().max(120).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
});

export function registerAnalyticsRoutes(app: Express, ctx: AppContext): void {
  app.get(
    '/api/analytics',
    handler((req, res) => {
      // `all` is the UI's way of saying "no filter"; drop it before validation.
      const cleaned = Object.fromEntries(
        Object.entries(req.query).filter(([, v]) => v !== '' && v !== 'all' && v !== undefined),
      );
      const q = querySchema.parse(cleaned);
      res.json(
        getAnalytics(ctx.db, {
          funnelId: ctx.funnelId,
          version: q.version ?? null,
          variant: (q.variant as VariantId | undefined) ?? null,
          campaign: q.campaign ?? null,
          from: q.from ?? null,
          to: q.to ?? null,
        }),
      );
    }),
  );
}
