import type { FunnelConfig } from '@funnel/shared';
import type { Db } from '../db/index.js';
import { generateTraffic } from './traffic.js';
import { activateVersion, getActiveVersionNumber, listConfigLibrary, listVersions, publishVersion } from './versions.js';

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

/* ────────────────────────── демо-стенд ────────────────────────── */

export interface DemoSeedOptions {
  baseUrl: string;
  funnelId: string;
  sessions: number;
  /** Сколько последних версий наполнить, чтобы сравнение версий не пустовало. */
  versions?: number;
  seed?: number;
}

/**
 * Досевает синтетический трафик, если событий ещё нет.
 *
 * Нужно только для стенда на эфемерном диске (Render free и подобные): там
 * файл базы исчезает при рестарте, и без этого проверяющий открыл бы дашборд
 * с нулями. Идемпотентно: при непустой таблице событий сразу выходит, поэтому
 * безопасно вызывать на каждом старте.
 */
export async function seedDemoTrafficIfEmpty(db: Db, opts: DemoSeedOptions): Promise<boolean> {
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  if (existing > 0) return false;

  const original = getActiveVersionNumber(db, opts.funnelId);
  const spread = listVersions(db, opts.funnelId)
    .map((v) => v.version)
    .sort((a, b) => a - b)
    .slice(-Math.max(1, opts.versions ?? 2));

  if (spread.length === 0) return false;

  const now = Date.now();
  const perVersion = Math.ceil(opts.sessions / spread.length);
  let produced = 0;

  for (const [i, version] of spread.entries()) {
    if (getActiveVersionNumber(db, opts.funnelId) !== version) {
      activateVersion(db, opts.funnelId, version, 'demo-seed', 'наполнение демо-стенда');
    }
    const target = Math.min(perVersion, opts.sessions - produced);
    if (target <= 0) break;
    await generateTraffic({
      baseUrl: opts.baseUrl,
      sessions: target,
      seed: (opts.seed ?? 20261007) + i,
      now,
    });
    produced += target;
  }

  // Активная версия возвращается на исходную: стенд должен встречать
  // проверяющего в том же состоянии, что и локальный запуск.
  if (original !== null && getActiveVersionNumber(db, opts.funnelId) !== original) {
    activateVersion(db, opts.funnelId, original, 'demo-seed', 'восстановление активной версии');
  }

  return true;
}
