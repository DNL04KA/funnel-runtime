import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import type { FunnelConfig, SessionBootstrap } from '@funnel/shared';
import { openDatabase, type Db } from '../server/src/db/index.js';
import { createApp } from '../server/src/http/app.js';
import { publishVersion } from '../server/src/domain/versions.js';

export const FUNNEL_ID = 'sorter-wms-fit';
const ROOT = resolve(import.meta.dirname, '..');

export function loadConfig(file: string): FunnelConfig {
  return JSON.parse(readFileSync(resolve(ROOT, 'configs', file), 'utf8')) as FunnelConfig;
}

export interface Harness {
  db: Db;
  url: string;
  close: () => Promise<void>;
  get: <T>(path: string) => Promise<{ status: number; body: T }>;
  post: <T>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

/** Boots the real app against an in-memory database on an ephemeral port. */
export async function startHarness(opts: { configs?: string[] } = {}): Promise<Harness> {
  const db = openDatabase(':memory:');

  for (const [index, file] of (opts.configs ?? ['funnel.v1.json', 'funnel.v2.json']).entries()) {
    publishVersion(db, {
      config: loadConfig(file),
      sourceFile: file,
      notes: `test seed ${file}`,
      actor: 'test',
      activate: index === (opts.configs ?? ['funnel.v1.json', 'funnel.v2.json']).length - 1,
    });
  }

  const app = createApp(db, { serveStatic: false, funnelId: FUNNEL_ID });
  const server: Server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  return {
    db,
    url,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      db.close();
    },
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
  };
}

export async function createSession(
  h: Harness,
  payload: Record<string, unknown> = {},
): Promise<SessionBootstrap> {
  const res = await h.post<SessionBootstrap>('/api/session', payload);
  if (res.status !== 201) throw new Error(`createSession → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export interface AnswerResponse extends SessionBootstrap {
  next_step: string | null;
  previous_step: string;
}

export async function answer(
  h: Harness,
  sessionId: string,
  stepId: string,
  value: unknown,
): Promise<AnswerResponse> {
  const res = await h.post<AnswerResponse>(`/api/session/${sessionId}/answer`, {
    step_id: stepId,
    value,
    client_ts: new Date().toISOString(),
  });
  if (res.status !== 200) throw new Error(`answer(${stepId}) → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Picks a syntactically valid answer for whatever step type is current. */
export function autoAnswer(step: {
  type: string;
  options?: { value: string }[];
  minSelected?: number;
  min?: number;
}): unknown {
  switch (step.type) {
    case 'single_select':
      return step.options?.[0]?.value ?? null;
    case 'multi_select':
      return (step.options ?? []).slice(0, Math.max(step.minSelected ?? 1, 1)).map((o) => o.value);
    case 'number':
      return step.min ?? 1;
    default:
      return null;
  }
}

/** Drives a session from its current step to the result screen. */
export async function walkToResult(
  h: Harness,
  boot: SessionBootstrap,
  pick: (stepId: string, step: Record<string, unknown>) => unknown = () => undefined,
): Promise<SessionBootstrap> {
  let current = boot;
  for (let i = 0; i < 25; i += 1) {
    const step = current.config.steps.find((s) => s.id === current.session.current_step);
    if (!step || step.type === 'result') return current;
    const override = pick(step.id, step as unknown as Record<string, unknown>);
    const value = override === undefined ? autoAnswer(step as never) : override;
    current = await answer(h, current.session.session_id, step.id, value);
  }
  throw new Error('walkToResult: не дошли до результата за 25 шагов');
}

export async function sendEvents(
  h: Harness,
  events: unknown[],
): Promise<{ accepted: number; duplicates: number; rejected: number; received: number; results: unknown[] }> {
  const res = await h.post<{
    accepted: number;
    duplicates: number;
    rejected: number;
    received: number;
    results: unknown[];
  }>('/api/events', { events });
  if (res.status !== 200) throw new Error(`sendEvents → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export function evt(
  sessionId: string,
  eventType: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: `${sessionId}:${eventType}:${Math.random().toString(36).slice(2, 10)}`,
    session_id: sessionId,
    event_type: eventType,
    client_ts: new Date().toISOString(),
    ...overrides,
  };
}
