import type { FunnelConfig } from '@funnel/shared';
import type { Db } from '../db/index.js';
import { listConfigLibrary, publishVersion } from './versions.js';

export interface SeedResult {
  published: { file: string; version: number; activated: boolean }[];
  skipped: boolean;
}

/**
 * Publishes the configs bundled in `configs/` in filename order and leaves the
 * *second* one active, which reproduces the task's starting point: two configs
 * exist, one of them is live, and there is already a version to roll back to.
 *
 * `funnel.v3.json` is the second-iteration config. It is deliberately left
 * unpublished so publishing it is a visible action on the admin page rather than
 * something that already happened at boot.
 */
export function seedVersions(db: Db, opts: { files?: string[]; activateIndex?: number } = {}): SeedResult {
  const library = listConfigLibrary().filter((c) => c.issues.every((i) => i.level !== 'error'));
  const wanted = opts.files ?? ['funnel.v1.json', 'funnel.v2.json'];
  const selected = wanted
    .map((file) => library.find((c) => c.file === file))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  if (selected.length === 0) {
    return { published: [], skipped: true };
  }

  const activateIndex = opts.activateIndex ?? selected.length - 1;
  const published: SeedResult['published'] = [];

  selected.forEach((entry, index) => {
    const result = publishVersion(db, {
      config: entry.config as FunnelConfig,
      notes: `Загружено из ${entry.file} при инициализации`,
      sourceFile: entry.file,
      actor: 'seed',
      activate: index === activateIndex,
    });
    published.push({ file: entry.file, version: result.version, activated: result.activated });
  });

  return { published, skipped: false };
}

export function seedVersionsIfEmpty(db: Db): SeedResult {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM funnel_versions').get() as { n: number }).n;
  if (count > 0) return { published: [], skipped: true };
  return seedVersions(db);
}
