import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  configErrors,
  resolveVariantConfig,
  validateConfig,
  type ConfigIssue,
  type FunnelConfig,
  type VariantId,
  type VersionAuditEntry,
  type VersionSummary,
} from '@funnel/shared';
import { CONFIG_DIR } from '../env.js';
import { nowIso, parseJson, type Db } from '../db/index.js';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface VersionRow {
  version: number;
  funnel_id: string;
  name: string;
  config_json: string;
  config_hash: string;
  source_file: string | null;
  notes: string | null;
  created_at: string;
}

export interface StoredVersion {
  version: number;
  funnelId: string;
  name: string;
  config: FunnelConfig;
  configHash: string;
  sourceFile: string | null;
  notes: string | null;
  createdAt: string;
}

function toStored(row: VersionRow): StoredVersion {
  return {
    version: row.version,
    funnelId: row.funnel_id,
    name: row.name,
    config: JSON.parse(row.config_json) as FunnelConfig,
    configHash: row.config_hash,
    sourceFile: row.source_file,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export function hashConfig(config: FunnelConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

export function getVersion(db: Db, version: number): StoredVersion | null {
  const row = db
    .prepare('SELECT * FROM funnel_versions WHERE version = ?')
    .get(version) as VersionRow | undefined;
  return row ? toStored(row) : null;
}

export function requireVersion(db: Db, version: number): StoredVersion {
  const found = getVersion(db, version);
  if (!found) throw new DomainError(`Версия ${version} не найдена`, 404);
  return found;
}

export function getActiveVersionNumber(db: Db, funnelId: string): number | null {
  const row = db
    .prepare('SELECT version FROM funnel_active WHERE funnel_id = ?')
    .get(funnelId) as { version: number } | undefined;
  return row?.version ?? null;
}

export function getActiveVersion(db: Db, funnelId: string): StoredVersion {
  const version = getActiveVersionNumber(db, funnelId);
  if (version === null) {
    throw new DomainError(
      `Для воронки "${funnelId}" нет активной версии. Запустите npm run seed:versions`,
      503,
    );
  }
  return requireVersion(db, version);
}

export function listVersions(db: Db, funnelId: string): VersionSummary[] {
  const active = getActiveVersionNumber(db, funnelId);
  const rows = db
    .prepare('SELECT * FROM funnel_versions WHERE funnel_id = ? ORDER BY version DESC')
    .all(funnelId) as VersionRow[];

  const sessionCounts = new Map<number, number>(
    (
      db
        .prepare('SELECT funnel_version AS v, COUNT(*) AS n FROM sessions WHERE funnel_id = ? GROUP BY v')
        .all(funnelId) as { v: number; n: number }[]
    ).map((r) => [r.v, r.n]),
  );
  const eventCounts = new Map<number, number>(
    (
      db
        .prepare('SELECT funnel_version AS v, COUNT(*) AS n FROM events WHERE funnel_id = ? GROUP BY v')
        .all(funnelId) as { v: number; n: number }[]
    ).map((r) => [r.v, r.n]),
  );

  return rows.map((row) => {
    const stored = toStored(row);
    return {
      version: stored.version,
      name: stored.name,
      notes: stored.notes,
      created_at: stored.createdAt,
      is_active: stored.version === active,
      session_count: sessionCounts.get(stored.version) ?? 0,
      event_count: eventCounts.get(stored.version) ?? 0,
      step_count: stored.config.steps.length,
      source_file: stored.sourceFile,
    };
  });
}

export function listAudit(db: Db, funnelId: string, limit = 50): VersionAuditEntry[] {
  return db
    .prepare('SELECT * FROM version_audit WHERE funnel_id = ? ORDER BY id DESC LIMIT ?')
    .all(funnelId, limit) as VersionAuditEntry[];
}

export interface PublishInput {
  config: FunnelConfig;
  notes?: string | null;
  sourceFile?: string | null;
  actor?: string;
  /** Publish without switching live traffic over. */
  activate?: boolean;
}

export interface PublishResult {
  version: number;
  activated: boolean;
  issues: ConfigIssue[];
}

/**
 * Publishing is append-only: a new row with the next version number. Nothing
 * about running sessions changes until `activate` flips the pointer, and no
 * redeploy is involved — the config lives in the database, not in the bundle.
 */
export function publishVersion(db: Db, input: PublishInput): PublishResult {
  const { config } = input;
  const issues = validateConfig(config);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) {
    throw new DomainError('Конфиг не прошёл валидацию', 422, { issues });
  }

  // Every variant must also resolve to a valid, non-stranded funnel.
  for (const variant of config.experiment.variants) {
    const resolved = resolveVariantConfig(config, variant);
    const variantErrors = configErrors(resolved);
    if (variantErrors.length) {
      throw new DomainError(`Вариант ${variant} не прошёл валидацию`, 422, {
        issues: variantErrors.map((i) => ({ ...i, message: `[вариант ${variant}] ${i.message}` })),
      });
    }
  }

  const tx = db.transaction((): PublishResult => {
    const next =
      ((
        db
          .prepare('SELECT COALESCE(MAX(version), 0) AS max FROM funnel_versions')
          .get() as { max: number }
      ).max ?? 0) + 1;

    db.prepare(
      `INSERT INTO funnel_versions
         (version, funnel_id, name, config_json, config_hash, source_file, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next,
      config.funnelId,
      config.name,
      JSON.stringify(config),
      hashConfig(config),
      input.sourceFile ?? null,
      input.notes ?? null,
      nowIso(),
    );

    const previous = getActiveVersionNumber(db, config.funnelId);
    const shouldActivate = input.activate !== false;

    if (shouldActivate) {
      setActive(db, config.funnelId, next, previous, 'publish', input.actor ?? 'admin', input.notes ?? null);
    } else {
      db.prepare(
        `INSERT INTO version_audit (funnel_id, action, from_version, to_version, actor, note, at)
         VALUES (?, 'publish', ?, ?, ?, ?, ?)`,
      ).run(config.funnelId, previous, next, input.actor ?? 'admin', input.notes ?? null, nowIso());
    }

    return { version: next, activated: shouldActivate, issues };
  });

  return tx();
}

function setActive(
  db: Db,
  funnelId: string,
  version: number,
  previous: number | null,
  action: VersionAuditEntry['action'],
  actor: string,
  note: string | null,
): void {
  db.prepare(
    `INSERT INTO funnel_active (funnel_id, version, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(funnel_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
  ).run(funnelId, version, nowIso());

  db.prepare(
    `INSERT INTO version_audit (funnel_id, action, from_version, to_version, actor, note, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(funnelId, action, previous, version, actor, note, nowIso());
}

/**
 * Switches live traffic to an already-published version. Rolling back is the
 * same operation pointed at a lower version number: nothing is deleted, so the
 * analytics collected under the rolled-back version survive intact and sessions
 * pinned to it keep running.
 */
export function activateVersion(
  db: Db,
  funnelId: string,
  version: number,
  actor = 'admin',
  note: string | null = null,
): { version: number; previous: number | null; action: VersionAuditEntry['action'] } {
  const target = requireVersion(db, version);
  if (target.funnelId !== funnelId) {
    throw new DomainError(`Версия ${version} принадлежит другой воронке (${target.funnelId})`, 400);
  }

  const tx = db.transaction(() => {
    const previous = getActiveVersionNumber(db, funnelId);
    if (previous === version) {
      throw new DomainError(`Версия ${version} уже активна`, 409);
    }
    const action: VersionAuditEntry['action'] =
      previous !== null && version < previous ? 'rollback' : 'activate';
    setActive(db, funnelId, version, previous, action, actor, note);
    return { version, previous, action };
  });

  return tx();
}

/** Serves the config a given variant should see, with variant patches applied. */
export function resolveConfigFor(stored: StoredVersion, variant: VariantId): FunnelConfig {
  return resolveVariantConfig(stored.config, variant);
}

/* --------------------------------------------------- bundled config library */

export interface LibraryConfig {
  file: string;
  name: string;
  funnelId: string;
  schemaVersion: number;
  stepCount: number;
  issues: ConfigIssue[];
  config: FunnelConfig;
}

/**
 * The JSON configs shipped in `configs/`. The admin page publishes from this
 * list, which is what makes "publish a new version without a redeploy" a
 * two-click operation rather than a file edit.
 */
export function listConfigLibrary(): LibraryConfig[] {
  let files: string[] = [];
  try {
    files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const out: LibraryConfig[] = [];
  for (const file of files) {
    try {
      const config = JSON.parse(readFileSync(resolve(CONFIG_DIR, file), 'utf8')) as FunnelConfig;
      out.push({
        file,
        name: config.name,
        funnelId: config.funnelId,
        schemaVersion: config.schemaVersion,
        stepCount: config.steps?.length ?? 0,
        issues: validateConfig(config),
        config,
      });
    } catch (err) {
      out.push({
        file,
        name: `${file} — не удалось прочитать`,
        funnelId: '',
        schemaVersion: 0,
        stepCount: 0,
        issues: [{ level: 'error', message: String((err as Error).message) }],
        config: { steps: [] } as unknown as FunnelConfig,
      });
    }
  }
  return out;
}

export function readLibraryConfig(file: string): FunnelConfig {
  if (!/^[\w.-]+\.json$/.test(file)) throw new DomainError('Недопустимое имя файла конфига', 400);
  const found = listConfigLibrary().find((c) => c.file === file);
  if (!found) throw new DomainError(`Конфиг "${file}" не найден в configs/`, 404);
  return found.config;
}

export { parseJson };
