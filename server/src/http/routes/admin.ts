import type { Express } from 'express';
import { z } from 'zod';
import { resolveVariantConfig, validateConfig, type FunnelConfig } from '@funnel/shared';
import { DEMO_MODE } from '../../env.js';
import { handler, requireAdmin, type AppContext } from '../app.js';
import {
  activateVersion,
  getActiveVersionNumber,
  listAudit,
  listConfigLibrary,
  listVersions,
  publishVersion,
  readLibraryConfig,
  requireVersion,
} from '../../domain/versions.js';
import { listSessions } from '../../domain/sessions.js';
import { listRejects } from '../../domain/events.js';

const publishSchema = z
  .object({
    /** Either publish an inline config… */
    config: z.record(z.unknown()).optional(),
    /** …or one of the JSON files bundled in `configs/`. */
    file: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(500).optional(),
    activate: z.boolean().optional(),
    actor: z.string().trim().max(80).optional(),
  })
  .refine((v) => Boolean(v.config) !== Boolean(v.file), {
    message: 'Укажите либо config, либо file',
  });

const activateSchema = z.object({
  version: z.coerce.number().int().positive(),
  note: z.string().trim().max(500).optional(),
  actor: z.string().trim().max(80).optional(),
});

export function registerAdminRoutes(app: Express, ctx: AppContext): void {
  const { db } = ctx;

  app.get(
    '/api/admin/overview',
    requireAdmin,
    handler((_req, res) => {
      res.json({
        funnel_id: ctx.funnelId,
        demo_mode: DEMO_MODE,
        active_version: getActiveVersionNumber(db, ctx.funnelId),
        versions: listVersions(db, ctx.funnelId),
        audit: listAudit(db, ctx.funnelId),
        library: listConfigLibrary().map(({ config, ...rest }) => ({
          ...rest,
          experiment: config?.experiment ?? null,
        })),
        recent_sessions: listSessions(db, ctx.funnelId, 25),
        rejects: listRejects(db, 15),
      });
    }),
  );

  app.get(
    '/api/admin/versions/:version',
    requireAdmin,
    handler((req, res) => {
      const stored = requireVersion(db, Number(req.params.version));
      res.json({
        version: stored.version,
        name: stored.name,
        notes: stored.notes,
        created_at: stored.createdAt,
        config_hash: stored.configHash,
        source_file: stored.sourceFile,
        is_active: getActiveVersionNumber(db, stored.funnelId) === stored.version,
        issues: validateConfig(stored.config),
        config: stored.config,
        resolved: Object.fromEntries(
          stored.config.experiment.variants.map((v) => [v, resolveVariantConfig(stored.config, v)]),
        ),
      });
    }),
  );

  /** Publishing writes a new row and (optionally) flips the pointer. No redeploy. */
  app.post(
    '/api/admin/versions',
    requireAdmin,
    handler((req, res) => {
      const body = publishSchema.parse(req.body ?? {});
      const config = (body.file ? readLibraryConfig(body.file) : (body.config as unknown)) as FunnelConfig;
      const result = publishVersion(db, {
        config,
        notes: body.notes ?? null,
        sourceFile: body.file ?? null,
        actor: body.actor ?? 'admin',
        ...(body.activate === undefined ? {} : { activate: body.activate }),
      });
      res.status(201).json(result);
    }),
  );

  /** Same endpoint serves rollback: it is just activation of a lower version. */
  app.post(
    '/api/admin/activate',
    requireAdmin,
    handler((req, res) => {
      const body = activateSchema.parse(req.body ?? {});
      res.json(activateVersion(db, ctx.funnelId, body.version, body.actor ?? 'admin', body.note ?? null));
    }),
  );
}
