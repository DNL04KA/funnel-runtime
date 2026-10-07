import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'configs/funnel.v1.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const REPO_ROOT = findRepoRoot(process.cwd());
export const CONFIG_DIR = resolve(REPO_ROOT, 'configs');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '0.0.0.0';

/** `:memory:` is used by the test suite. */
export const DB_PATH =
  process.env.DB_PATH ?? resolve(REPO_ROOT, 'data', 'funnel.db');

/** When set, every /api/admin/* call must present `x-admin-token`. */
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

/** Static SPA build served by the Node process in production. */
export const WEB_DIST = resolve(REPO_ROOT, 'web', 'dist');

export const FUNNEL_ID = process.env.FUNNEL_ID ?? 'sorter-wms-fit';

/**
 * Демо-стенд. Если задано, сервер при старте на пустой базе досевает столько
 * синтетических сессий — чтобы на хостинге с эфемерным диском дашборд никогда
 * не встречал проверяющего нулями.
 *
 * Для обычного запуска значение не нужно: локально данные создаёт
 * `npm run seed:traffic`, а на хостинге с постоянным диском они переживают
 * рестарт сами.
 */
export const DEMO_SEED_SESSIONS = Number(process.env.DEMO_SEED_SESSIONS ?? 0);

/** Стенд работает на эфемерном диске и пересоздаёт данные при рестарте. */
export const DEMO_MODE = DEMO_SEED_SESSIONS > 0;

export function ensureDataDir(dbPath = DB_PATH): void {
  if (dbPath === ':memory:') return;
  mkdirSync(dirname(dbPath), { recursive: true });
}
