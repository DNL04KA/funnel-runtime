import type { Express } from 'express';
import { handler, type AppContext } from '../app.js';
import { eventBatchSchema, ingestEvents } from '../../domain/events.js';
import { DomainError } from '../../domain/versions.js';

export function registerEventRoutes(app: Express, ctx: AppContext): void {
  /**
   * Batch event intake.
   *
   * Always answers 200 with a per-event verdict rather than failing the request:
   * a client retrying after a timeout needs a definitive answer, and one bad
   * event must not cost the caller the rest of the batch. Replays are reported as
   * `duplicate`, which is a success for the caller — nothing is stored twice.
   */
  app.post(
    '/api/events',
    handler((req, res) => {
      const body = req.body;
      // A bare array is accepted too; several analytics clients send that shape.
      const raw = Array.isArray(body) ? { events: body } : body;
      const parsed = eventBatchSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DomainError('Ожидается { events: [...] } с 1–500 событиями', 400, {
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`),
        });
      }
      res.json(ingestEvents(ctx.db, parsed.data.events));
    }),
  );
}
