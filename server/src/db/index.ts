import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { DB_PATH, ensureDataDir } from '../env.js';
import { migrate } from './schema.js';

export type Db = Database;

export function openDatabase(path: string = DB_PATH): Db {
  ensureDataDir(path);
  const db = new SqliteDatabase(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
