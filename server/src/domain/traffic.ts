/**
 * Генерация синтетического трафика.
 *
 * Ходит в приложение по HTTP, а не дёргает доменные функции напрямую: так
 * данные проходят ту же валидацию, то же закрепление версии и тот же ingest,
 * что и трафик из браузера. Используется и CLI-командой, и автопосевом
 * демо-стенда при старте сервера.
 */
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

/* ─────────────────────────────── случайность ────────────────────────────── */

/** mulberry32 — маленький, быстрый и с зерном, поэтому прогон воспроизводим. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ──────────────────────────────── источники ─────────────────────────────── */

export const UTM_POOL = [
  { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'wms_brand', utm_content: 'text_a', utm_term: 'wms система' },
  { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'wms_generic', utm_content: 'text_b', utm_term: 'автоматизация склада' },
  { utm_source: 'telegram', utm_medium: 'social', utm_campaign: 'logistics_digest', utm_content: 'post_12', utm_term: null },
  { utm_source: 'vc_ru', utm_medium: 'referral', utm_campaign: 'case_study_q4', utm_content: 'inline_link', utm_term: null },
  { utm_source: 'email', utm_medium: 'email', utm_campaign: 'reactivation_oct', utm_content: 'cta_top', utm_term: null },
  { utm_source: 'partner', utm_medium: 'affiliate', utm_campaign: 'integrator_network', utm_content: null, utm_term: null },
  // Прямой трафик без меток: дашборд обязан считать и его.
  { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null },
] as const;

/** Качество кампании влияет на «терпеливость» сессии — иначе конверсия была бы шумом. */
const CAMPAIGN_QUALITY: Record<string, number> = {
  wms_brand: 1.18,
  wms_generic: 0.86,
  logistics_digest: 0.95,
  case_study_q4: 1.1,
  reactivation_oct: 0.78,
  integrator_network: 1.05,
};

/* ──────────────────────────────── http-клиент ───────────────────────────── */

export interface Api {
  post<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

export function makeApi(baseUrl: string, adminToken = ''): Api {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (adminToken) headers['x-admin-token'] = adminToken;

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

  return { post: (p, b) => call('POST', p, b), get: (p) => call('GET', p) };
}

/* ──────────────────────────────── ответы ────────────────────────────────── */

function weightedPick(rng: () => number, options: readonly SelectOption[]): SelectOption {
  const total = options.reduce((acc, o) => acc + (o.trafficWeight ?? 1), 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.trafficWeight ?? 1;
    if (roll <= 0) return option;
  }
  return options[options.length - 1] as SelectOption;
}

export function pickAnswer(rng: () => number, step: FunnelStep): string | string[] | number | null {
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
      // Квадрат равномерного — бюджеты жмутся к нижней границе, как в жизни.
      const raw = min + rng() ** 2 * (max - min);
      const stepSize = s.stepSize ?? 1;
      return Math.max(min, Math.min(max, Math.round(raw / stepSize) * stepSize));
    }

    default:
      return null;
  }
}

/* ──────────────────────────────── статистика ────────────────────────────── */

export interface Stats {
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

export function emptyStats(): Stats {
  return {
    sessions: 0, flushes: 0, sent: 0, accepted: 0, duplicates: 0, rejected: 0,
    replayed_batches: 0, in_batch_dupes: 0, out_of_order_batches: 0, invalid_injected: 0,
    reached_result: 0, cta_clicks: 0, back_clicks: 0, hint_expands: 0,
    by_version: {}, by_variant: {}, dropped_at: {},
  };
}

/* ──────────────────────────────── сценарий ──────────────────────────────── */

interface PendingEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  client_ts: string;
  step_id?: string | null;
  props?: Record<string, unknown>;
}

export interface SessionPlan {
  utm: (typeof UTM_POOL)[number];
  variantOverride: 'A' | 'B' | null;
  startedAt: Date;
  replayBatch: boolean;
  dupeInBatch: boolean;
  shuffleBatch: boolean;
  injectInvalid: boolean;
  usesBack: boolean;
  patience: number;
  ctaIntent: number;
}

export function makePlan(rng: () => number, now: number): SessionPlan {
  const utm = UTM_POOL[Math.floor(rng() * UTM_POOL.length)] as (typeof UTM_POOL)[number];
  const quality = utm.utm_campaign ? (CAMPAIGN_QUALITY[utm.utm_campaign] ?? 1) : 1;

  return {
    utm,
    variantOverride: rng() < 0.05 ? (rng() < 0.5 ? 'A' : 'B') : null,
    // Сессии размазаны по последним десяти дням, чтобы фильтр по датам имел диапазон.
    startedAt: new Date(now - rng() * 10 * 24 * 60 * 60 * 1000),
    replayBatch: rng() < 0.12,
    dupeInBatch: rng() < 0.1,
    shuffleBatch: rng() < 0.12,
    injectInvalid: rng() < 0.06,
    usesBack: rng() < 0.3,
    patience: Math.min(0.97, 0.78 + rng() * 0.17 * quality),
    ctaIntent: Math.min(0.95, 0.3 + rng() * 0.4 * quality),
  };
}

/** Заведомо битые payload'ы — доказывают, что одно событие не роняет пачку. */
function invalidEvent(rng: () => number, sessionId: string, ts: string): unknown {
  const kind = Math.floor(rng() * 4);
  if (kind === 0) return { event_id: `bad-${sessionId}-type`, session_id: sessionId, event_type: 'teleported', client_ts: ts };
  if (kind === 1) return { event_id: `bad-${sessionId}-ts`, session_id: sessionId, event_type: 'step_viewed', client_ts: 'не-дата' };
  if (kind === 2) return { session_id: sessionId, event_type: 'step_viewed', client_ts: ts };
  return { event_id: `bad-${sessionId}-sess`, session_id: 'session-which-does-not-exist', event_type: 'cta_clicked', client_ts: ts };
}

export async function runSession(api: Api, rng: () => number, plan: SessionPlan, stats: Stats): Promise<void> {
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
      batch = [...batch, { ...(batch[Math.floor(rng() * batch.length)] as object) }];
      stats.in_batch_dupes += 1;
    }
    if (plan.shuffleBatch && batch.length > 2) {
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
      const res = await api.post<{ accepted: number; duplicates: number; rejected: number }>('/api/events', { events: batch });
      stats.flushes += 1;
      stats.sent += batch.length;
      stats.accepted += res.accepted;
      stats.duplicates += res.duplicates;
      stats.rejected += res.rejected;
    };

    await send();
    if (plan.replayBatch) {
      // Ровно то, что делает клиент, ретраящий пачку после timeout.
      await send();
      stats.replayed_batches += 1;
    }
  };

  let currentStep = bootstrap.session.current_step;
  let seq = 0;
  let usedBack = false;

  for (let guard = 0; guard < 40; guard += 1) {
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

    // Подсказки есть только в конфигах, которые их объявляют (с v3).
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

    // Отвал: пользователь просто перестаёт отвечать, события больше не идут.
    if (rng() > plan.patience) {
      stats.dropped_at[currentStep] = (stats.dropped_at[currentStep] ?? 0) + 1;
      await flush();
      return;
    }

    // Возврат назад: даёт back_clicked и повторный step_viewed того же шага.
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

    const result = await api.post<{ session: { current_step: string }; next_step: string | null }>(
      `/api/session/${sessionId}/answer`,
      {
        step_id: currentStep,
        value: pickAnswer(rng, step),
        client_ts: tick(1400 + rng() * 11000),
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

/* ──────────────────────────────── оркестрация ───────────────────────────── */

export interface GenerateOptions {
  baseUrl: string;
  sessions: number;
  seed?: number;
  adminToken?: string;
  /** «Сейчас» для разброса дат. Передаётся явно ради воспроизводимости. */
  now?: number;
  stats?: Stats;
}

/** Прогоняет N сессий против уже запущенного приложения на активной версии. */
export async function generateTraffic(opts: GenerateOptions): Promise<Stats> {
  const rng = makeRng(opts.seed ?? 20261007);
  const stats = opts.stats ?? emptyStats();
  const api = makeApi(opts.baseUrl, opts.adminToken ?? '');
  const now = opts.now ?? Date.now();

  for (let i = 0; i < opts.sessions; i += 1) {
    await runSession(api, rng, makePlan(rng, now), stats);
  }
  return stats;
}
