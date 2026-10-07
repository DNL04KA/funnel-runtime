/**
 * Synthetic traffic generator.
 *
 * Boots the real Express app on an ephemeral port and drives it over HTTP, so the
 * generated data passes through exactly the same validation, pinning, variant
 * assignment and ingest paths as a real browser. Pass `--url` to point it at an
 * already-running server (including a deployed one) instead.
 *
 *   npm run seed:traffic
 *   npm run seed:traffic -- --sessions 250 --seed 7
 *   npm run seed:traffic -- --url https://example.com
 */
import type { Server } from 'node:http';
import {
  getStep,
  type FunnelConfig,
  type FunnelStep,
  type MultiSelectStep,
  type NumberStep,
  type SelectOption,
  type SessionBootstrap,
  type SingleSelectStep,
} from '@funnel/shared';
import { createApp } from '../http/app.js';
import { openDatabase, type Db } from '../db/index.js';
import { ADMIN_TOKEN, FUNNEL_ID } from '../env.js';
import { seedVersionsIfEmpty } from '../domain/bootstrap.js';
import { getActiveVersionNumber, listVersions } from '../domain/versions.js';

/* ------------------------------------------------------------------ options */

interface Options {
  sessions: number;
  seed: number;
  url: string | null;
  versions: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    sessions: Number(get('sessions') ?? 140),
    seed: Number(get('seed') ?? 20261007),
    url: get('url') ?? null,
    versions: Number(get('versions') ?? 2),
    quiet: argv.includes('--quiet'),
  };
}

/* --------------------------------------------------------------------- rand */

/** mulberry32 — small, fast, and seeded, so a run is reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- utm pools */

const UTM_POOL = [
  { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'wms_brand', utm_content: 'text_a', utm_term: 'wms система' },
  { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'wms_generic', utm_content: 'text_b', utm_term: 'автоматизация склада' },
  { utm_source: 'telegram', utm_medium: 'social', utm_campaign: 'logistics_digest', utm_content: 'post_12', utm_term: null },
  { utm_source: 'vc_ru', utm_medium: 'referral', utm_campaign: 'case_study_q4', utm_content: 'inline_link', utm_term: null },
  { utm_source: 'email', utm_medium: 'email', utm_campaign: 'reactivation_oct', utm_content: 'cta_top', utm_term: null },
  { utm_source: 'partner', utm_medium: 'affiliate', utm_campaign: 'integrator_network', utm_content: null, utm_term: null },
  // Direct traffic: no tags at all. The dashboard must still count these.
  { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null },
];

const CAMPAIGN_QUALITY: Record<string, number> = {
  wms_brand: 1.18,
  wms_generic: 0.86,
  logistics_digest: 0.95,
  case_study_q4: 1.1,
  reactivation_oct: 0.78,
  integrator_network: 1.05,
};

/* -------------------------------------------------------------- http client */

interface Api {
  post<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

function makeApi(baseUrl: string): Api {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  return {
    post: (path, body) => call('POST', path, body),
    get: (path) => call('GET', path),
  };
}

/* ----------------------------------------------------------- answer picking */

function weightedPick(rng: () => number, options: SelectOption[]): SelectOption {
  const total = options.reduce((acc, o) => acc + (o.trafficWeight ?? 1), 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.trafficWeight ?? 1;
    if (roll <= 0) return option;
  }
  return options[options.length - 1] as SelectOption;
}

function pickAnswer(rng: () => number, step: FunnelStep): string | string[] | number | null {
  switch (step.type) {
    case 'single_select':
      return weightedPick(rng, (step as SingleSelectStep).options).value;

    case 'multi_select': {
      const s = step as MultiSelectStep;
      const min = Math.max(s.minSelected ?? 1, 1);
      const max = Math.min(s.maxSelected ?? s.options.length, s.options.length);
      const count = min + Math.floor(rng() * (max - min + 1));
      const pool = [...s.options];
      const chosen: string[] = [];
      while (chosen.length < count && pool.length > 0) {
        const option = weightedPick(rng, pool);
        chosen.push(option.value);
        pool.splice(pool.indexOf(option), 1);
      }
      return chosen;
    }

    case 'number': {
      const s = step as NumberStep;
      const min = s.min ?? 1;
      const max = s.max ?? min + 100;
      // Log-uniform, so budgets cluster at the low end the way real ones do.
      const t = rng() ** 2;
      const raw = min + t * (max - min);
      const stepSize = s.stepSize ?? 1;
      return Math.max(min, Math.min(max, Math.round(raw / stepSize) * stepSize));
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------- events */

interface PendingEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  client_ts: string;
  step_id?: string | null;
  props?: Record<string, unknown>;
}

interface Stats {
  sessions: number;
  flushes: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  replayed_batches: number;
  in_batch_dupes: number;
  out_of_order_batches: number;
  invalid_injected: number;
  reached_result: number;
  cta_clicks: number;
  back_clicks: number;
  hint_expands: number;
  by_version: Record<number, number>;
  by_variant: Record<string, number>;
  dropped_at: Record<string, number>;
}

function emptyStats(): Stats {
  return {
    sessions: 0, flushes: 0, sent: 0, accepted: 0, duplicates: 0, rejected: 0,
    replayed_batches: 0, in_batch_dupes: 0, out_of_order_batches: 0, invalid_injected: 0,
    reached_result: 0, cta_clicks: 0, back_clicks: 0, hint_expands: 0,
    by_version: {}, by_variant: {}, dropped_at: {},
  };
}

/** Deliberately malformed payloads, to prove one bad event cannot spoil a batch. */
function invalidEvent(rng: () => number, sessionId: string, ts: string): unknown {
  const kind = Math.floor(rng() * 4);
  if (kind === 0) return { event_id: `bad-${sessionId}-type`, session_id: sessionId, event_type: 'teleported', client_ts: ts };
  if (kind === 1) return { event_id: `bad-${sessionId}-ts`, session_id: sessionId, event_type: 'step_viewed', client_ts: 'не-дата' };
  if (kind === 2) return { session_id: sessionId, event_type: 'step_viewed', client_ts: ts };
  return { event_id: `bad-${sessionId}-sess`, session_id: 'session-which-does-not-exist', event_type: 'cta_clicked', client_ts: ts };
}

/* -------------------------------------------------------------------- walker */

interface SessionPlan {
  utm: (typeof UTM_POOL)[number];
  variantOverride: 'A' | 'B' | null;
  startedAt: Date;
  replayBatch: boolean;
  dupeInBatch: boolean;
  shuffleBatch: boolean;
  injectInvalid: boolean;
  usesBack: boolean;
  /** Probability of abandoning at any given step. */
  patience: number;
  ctaIntent: number;
}

async function runSession(
  api: Api,
  rng: () => number,
  plan: SessionPlan,
  stats: Stats,
): Promise<void> {
  const buffer: PendingEvent[] = [];
  let clock = plan.startedAt.getTime();
  const tick = (ms = 1500 + rng() * 9000): string => {
    clock += ms;
    return new Date(clock).toISOString();
  };

  const bootstrap = await api.post<SessionBootstrap>('/api/session', {
    ...plan.utm,
    ...(plan.variantOverride ? { variant: plan.variantOverride } : {}),
    created_at: new Date(clock).toISOString(),
  });

  const sessionId = bootstrap.session.session_id;
  const config: FunnelConfig = bootstrap.config;
  const version = bootstrap.session.funnel_version;
  const variant = bootstrap.session.variant;

  stats.sessions += 1;
  stats.by_version[version] = (stats.by_version[version] ?? 0) + 1;
  stats.by_variant[variant] = (stats.by_variant[variant] ?? 0) + 1;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    let batch: unknown[] = buffer.map((e) => ({ ...e }));
    buffer.length = 0;

    if (plan.dupeInBatch && batch.length > 1) {
      // The same event_id twice inside one request.
      batch = [...batch, { ...(batch[Math.floor(rng() * batch.length)] as object) }];
      stats.in_batch_dupes += 1;
    }
    if (plan.shuffleBatch && batch.length > 2) {
      // Arrival order no longer matches client_ts order.
      for (let i = batch.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
      stats.out_of_order_batches += 1;
    }
    if (plan.injectInvalid) {
      batch = [...batch, invalidEvent(rng, sessionId, new Date(clock).toISOString())];
      stats.invalid_injected += 1;
    }

    const send = async (): Promise<void> => {
      const res = await api.post<{ accepted: number; duplicates: number; rejected: number }>(
        '/api/events',
        { events: batch },
      );
      stats.flushes += 1;
      stats.sent += batch.length;
      stats.accepted += res.accepted;
      stats.duplicates += res.duplicates;
      stats.rejected += res.rejected;
    };

    await send();
    if (plan.replayBatch) {
      // Exactly what a client retrying after a timeout does.
      await send();
      stats.replayed_batches += 1;
    }
  };

  let currentStep = bootstrap.session.current_step;
  let seq = 0;
  let usedBack = false;
  let guard = 0;

  while (guard < 40) {
    guard += 1;
    const step = getStep(config, currentStep);
    if (!step) break;

    seq += 1;
    buffer.push({
      event_id: `${sessionId}:${currentStep}:view:${seq}`,
      session_id: sessionId,
      event_type: 'step_viewed',
      client_ts: tick(900 + rng() * 2500),
      step_id: currentStep,
      props: { seq, variant, funnel_version: version },
    });

    // Hint expansion only exists in configs that declare it (v3 onward).
    if (step.hint && rng() < 0.3) {
      buffer.push({
        event_id: `${sessionId}:${currentStep}:hint:${seq}`,
        session_id: sessionId,
        event_type: 'hint_expanded',
        client_ts: tick(400 + rng() * 1200),
        step_id: currentStep,
        props: { seq },
      });
      stats.hint_expands += 1;
    }

    if (step.type === 'result') {
      buffer.push({
        event_id: `${sessionId}:${currentStep}:result:${seq}`,
        session_id: sessionId,
        event_type: 'result_viewed',
        client_ts: tick(600 + rng() * 1500),
        step_id: currentStep,
        props: { seq },
      });
      stats.reached_result += 1;

      if (rng() < plan.ctaIntent) {
        buffer.push({
          event_id: `${sessionId}:${currentStep}:cta:${seq}`,
          session_id: sessionId,
          event_type: 'cta_clicked',
          client_ts: tick(1200 + rng() * 6000),
          step_id: currentStep,
          props: { cta: 'primary', seq },
        });
        stats.cta_clicks += 1;
      }
      await flush();
      return;
    }

    // Abandon. The user simply stops; no further events arrive.
    if (rng() > plan.patience) {
      stats.dropped_at[currentStep] = (stats.dropped_at[currentStep] ?? 0) + 1;
      await flush();
      return;
    }

    // Go back one step, then come forward again — produces back_clicked plus a
    // second step_viewed for the same step, which must not inflate the funnel.
    if (plan.usesBack && !usedBack && seq >= 3 && rng() < 0.45) {
      usedBack = true;
      await flush();
      const back = await api.post<{ session: { current_step: string } }>(`/api/session/${sessionId}/back`, {
        event_id: `${sessionId}:${currentStep}:back:${seq}`,
        client_ts: tick(800 + rng() * 2000),
      });
      stats.back_clicks += 1;
      currentStep = back.session.current_step;
      continue;
    }

    const value = pickAnswer(rng, step);
    const clientTs = tick(1400 + rng() * 11000);
    const result = await api.post<{ session: { current_step: string }; next_step: string | null }>(
      `/api/session/${sessionId}/answer`,
      {
        step_id: currentStep,
        value,
        client_ts: clientTs,
        event_ids: {
          answer: `${sessionId}:${currentStep}:answer:${seq}`,
          completed: `${sessionId}:${currentStep}:completed:${seq}`,
        },
      },
    );

    if (buffer.length >= 4) await flush();

    const next = result.session.current_step;
    if (next === currentStep) break;
    currentStep = next;
  }

  await flush();
}

/* --------------------------------------------------------------------- main */

function makePlan(rng: () => number, now: number): SessionPlan {
  const utm = UTM_POOL[Math.floor(rng() * UTM_POOL.length)] as (typeof UTM_POOL)[number];
  const quality = utm.utm_campaign ? (CAMPAIGN_QUALITY[utm.utm_campaign] ?? 1) : 1.0;

  // Sessions are spread over the last ten days so date filters have range.
  const ageMs = rng() * 10 * 24 * 60 * 60 * 1000;

  return {
    utm,
    variantOverride: rng() < 0.05 ? (rng() < 0.5 ? 'A' : 'B') : null,
    startedAt: new Date(now - ageMs),
    replayBatch: rng() < 0.12,
    dupeInBatch: rng() < 0.1,
    shuffleBatch: rng() < 0.12,
    injectInvalid: rng() < 0.06,
    usesBack: rng() < 0.3,
    patience: Math.min(0.97, 0.78 + rng() * 0.17 * quality),
    ctaIntent: Math.min(0.95, 0.3 + rng() * 0.4 * quality),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const rng = makeRng(opts.seed);
  const stats = emptyStats();

  let db: Db | null = null;
  let server: Server | null = null;
  let baseUrl = opts.url;

  if (!baseUrl) {
    db = openDatabase();
    seedVersionsIfEmpty(db);
    const app = createApp(db, { serveStatic: false, funnelId: FUNNEL_ID });
    server = await new Promise<Server>((done) => {
      const s = app.listen(0, '127.0.0.1', () => done(s));
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  const api = makeApi(baseUrl);
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(msg);
  };

  log(`Генерация трафика → ${baseUrl}`);
  log(`  сессий: ${opts.sessions}, seed: ${opts.seed}`);

  // Distribute traffic across the published versions by temporarily activating
  // each one. Besides filling the version-comparison view, this exercises the
  // real invariant: sessions started on an older version keep running on it.
  const originalActive = db ? getActiveVersionNumber(db, FUNNEL_ID) : null;
  const versionList = db
    ? listVersions(db, FUNNEL_ID).map((v) => v.version).sort((a, b) => a - b)
    : [];
  const spread = versionList.slice(-Math.max(1, opts.versions));
  const perVersion = spread.length > 0 ? Math.ceil(opts.sessions / spread.length) : opts.sessions;

  const now = Date.now();
  let produced = 0;

  if (db && spread.length > 1) {
    for (const version of spread) {
      await api.post('/api/admin/activate', { version, note: 'traffic generator', actor: 'generator' }).catch(() => {
        /* already active */
      });
      const target = Math.min(perVersion, opts.sessions - produced);
      for (let i = 0; i < target; i += 1) {
        await runSession(api, rng, makePlan(rng, now), stats);
        produced += 1;
      }
      log(`  версия ${version}: ${target} сессий`);
    }
  } else {
    for (let i = 0; i < opts.sessions; i += 1) {
      await runSession(api, rng, makePlan(rng, now), stats);
      produced += 1;
    }
  }

  if (db && originalActive !== null) {
    const current = getActiveVersionNumber(db, FUNNEL_ID);
    if (current !== originalActive) {
      await api.post('/api/admin/activate', {
        version: originalActive,
        note: 'восстановление активной версии после генератора',
        actor: 'generator',
      });
    }
  }

  log('\nИтого:');
  log(`  сессий создано          ${stats.sessions}`);
  log(`  по версиям              ${JSON.stringify(stats.by_version)}`);
  log(`  по вариантам            ${JSON.stringify(stats.by_variant)}`);
  log(`  дошли до результата     ${stats.reached_result}`);
  log(`  кликнули CTA            ${stats.cta_clicks}`);
  log(`  нажали «назад»          ${stats.back_clicks}`);
  log(`  раскрыли подсказку      ${stats.hint_expands}`);
  log('');
  log(`  батчей отправлено       ${stats.flushes}`);
  log(`  событий отправлено      ${stats.sent}`);
  log(`    принято               ${stats.accepted}`);
  log(`    отклонено как дубль   ${stats.duplicates}`);
  log(`    отклонено невалидных  ${stats.rejected}`);
  log('');
  log(`  повторных отправок батча ${stats.replayed_batches}`);
  log(`  дублей внутри батча      ${stats.in_batch_dupes}`);
  log(`  перемешанных батчей      ${stats.out_of_order_batches}`);
  log(`  невалидных подмешано     ${stats.invalid_injected}`);

  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (db) {
    log(`\nАктивная версия: ${getActiveVersionNumber(db, FUNNEL_ID)}`);
    db.close();
  }
  log('\nГотово. Откройте /admin/analytics.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
