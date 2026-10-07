import type { Express } from 'express';
import { z } from 'zod';
import { getStep, resolveOutcome, type AnswerValue, type ResultStep } from '@funnel/shared';
import { handler, type AppContext } from '../app.js';
import { getActiveVersion, resolveConfigFor, DomainError } from '../../domain/versions.js';
import {
  bootstrapFor,
  createSession,
  goBack,
  requireSession,
  submitAnswer,
} from '../../domain/sessions.js';

const utm = z.string().trim().max(120).optional().nullable();

const createSessionSchema = z.object({
  utm_source: utm,
  utm_medium: utm,
  utm_campaign: utm,
  utm_content: utm,
  utm_term: utm,
  variant: z.string().trim().max(8).optional().nullable(),
  /** Generator-only: makes synthetic traffic reproducible. */
  session_id: z.string().trim().min(8).max(120).optional(),
  created_at: z.string().trim().max(40).optional(),
});

const answerSchema = z.object({
  step_id: z.string().trim().min(1).max(80),
  value: z.union([z.string(), z.number(), z.array(z.string()), z.null()]),
  client_ts: z.string().trim().max(40).optional(),
  event_ids: z
    .object({ answer: z.string().max(120).optional(), completed: z.string().max(120).optional() })
    .optional(),
});

export function registerFunnelRoutes(app: Express, ctx: AppContext): void {
  const { db } = ctx;

  /** Public descriptor of the live funnel, used by the landing page. */
  app.get(
    '/api/funnel',
    handler((_req, res) => {
      const active = getActiveVersion(db, ctx.funnelId);
      res.json({
        funnel_id: active.funnelId,
        name: active.name,
        active_version: active.version,
        schema_version: active.config.schemaVersion,
        step_count: active.config.steps.length,
        experiment: active.config.experiment,
        theme: active.config.theme ?? null,
      });
    }),
  );

  app.post(
    '/api/session',
    handler((req, res) => {
      const body = createSessionSchema.parse(req.body ?? {});
      const bootstrap = createSession(db, {
        funnelId: ctx.funnelId,
        utm: {
          utm_source: body.utm_source ?? null,
          utm_medium: body.utm_medium ?? null,
          utm_campaign: body.utm_campaign ?? null,
          utm_content: body.utm_content ?? null,
          utm_term: body.utm_term ?? null,
        },
        variantOverride: body.variant ?? undefined,
        userAgent: req.header('user-agent') ?? null,
        ...(body.session_id ? { sessionId: body.session_id } : {}),
        ...(body.created_at ? { createdAt: body.created_at } : {}),
      });
      res.status(201).json(bootstrap);
    }),
  );

  app.get(
    '/api/session/:id',
    handler((req, res) => {
      const session = requireSession(db, String(req.params.id));
      res.json(bootstrapFor(db, session));
    }),
  );

  app.post(
    '/api/session/:id/answer',
    handler((req, res) => {
      const body = answerSchema.parse(req.body ?? {});
      const result = submitAnswer(db, String(req.params.id), {
        stepId: body.step_id,
        value: body.value as AnswerValue,
        ...(body.client_ts ? { clientTs: body.client_ts } : {}),
        ...(body.event_ids ? { eventIds: body.event_ids } : {}),
      });
      res.json(result);
    }),
  );

  app.post(
    '/api/session/:id/back',
    handler((req, res) => {
      const body = z
        .object({ event_id: z.string().max(120).optional(), client_ts: z.string().max(40).optional() })
        .parse(req.body ?? {});
      res.json(
        goBack(db, String(req.params.id), {
          ...(body.event_id ? { eventId: body.event_id } : {}),
          ...(body.client_ts ? { clientTs: body.client_ts } : {}),
        }),
      );
    }),
  );

  /**
   * Result content is resolved server-side: the outcome rules read the raw
   * answers, which stay on the server, and the client only ever sees the copy.
   */
  app.get(
    '/api/session/:id/result',
    handler((req, res) => {
      const session = requireSession(db, String(req.params.id));
      const { config } = bootstrapFor(db, session);
      const step = getStep(config, session.current_step);
      if (!step || step.type !== 'result') {
        throw new DomainError('Сессия ещё не дошла до результата', 409, {
          current_step: session.current_step,
        });
      }
      const resultStep = step as ResultStep;
      res.json({
        step_id: resultStep.id,
        title: resultStep.title,
        cta_label: resultStep.ctaLabel,
        cta_href: resultStep.ctaHref,
        secondary_cta_label: resultStep.secondaryCtaLabel ?? null,
        outcome: resolveOutcome(resultStep, session.answers),
        variant: session.variant,
        funnel_version: session.funnel_version,
      });
    }),
  );

  /** Lets the admin page preview exactly what each variant will be served. */
  app.get(
    '/api/funnel/preview',
    handler((req, res) => {
      const version = req.query.version ? Number(req.query.version) : null;
      const variant = String(req.query.variant ?? 'A') === 'B' ? 'B' : 'A';
      const active = getActiveVersion(db, ctx.funnelId);
      const stored =
        version === null || version === active.version
          ? active
          : (() => {
              const found = db
                .prepare('SELECT * FROM funnel_versions WHERE version = ?')
                .get(version) as { config_json: string; version: number; name: string; funnel_id: string } | undefined;
              if (!found) throw new DomainError(`Версия ${version} не найдена`, 404);
              return {
                version: found.version,
                funnelId: found.funnel_id,
                name: found.name,
                config: JSON.parse(found.config_json),
                configHash: '',
                sourceFile: null,
                notes: null,
                createdAt: '',
              };
            })();
      res.json({ version: stored.version, variant, config: resolveConfigFor(stored, variant) });
    }),
  );
}
