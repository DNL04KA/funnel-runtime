import { randomUUID } from 'node:crypto';
import {
  assignVariant,
  computeProgress,
  getStep,
  parseVariantOverride,
  resolveNext,
  sanitizeAnswer,
  stepField,
  validateAnswer,
  type AnswerMap,
  type AnswerValue,
  type FunnelConfig,
  type SessionBootstrap,
  type SessionSnapshot,
  type UtmParams,
  type VariantId,
} from '@funnel/shared';
import { nowIso, parseJson, type Db } from '../db/index.js';
import { ingestEvents } from './events.js';
import {
  DomainError,
  getActiveVersion,
  getActiveVersionNumber,
  requireVersion,
  resolveConfigFor,
} from './versions.js';

interface SessionRow {
  session_id: string;
  funnel_id: string;
  funnel_version: number;
  variant: string;
  variant_source: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  current_step: string;
  answers_json: string;
  history_json: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  user_agent: string | null;
}

export interface SessionRecord extends SessionSnapshot {
  funnel_id: string;
  user_agent: string | null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    session_id: row.session_id,
    funnel_id: row.funnel_id,
    funnel_version: row.funnel_version,
    variant: row.variant as VariantId,
    variant_source: row.variant_source as 'assigned' | 'override',
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    current_step: row.current_step,
    answers: parseJson<AnswerMap>(row.answers_json, {}),
    history: parseJson<string[]>(row.history_json, []),
    utm: {
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_campaign: row.utm_campaign,
      utm_content: row.utm_content,
      utm_term: row.utm_term,
    },
    user_agent: row.user_agent,
  };
}

export function findSession(db: Db, sessionId: string): SessionRecord | null {
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
    | SessionRow
    | undefined;
  return row ? toRecord(row) : null;
}

export function requireSession(db: Db, sessionId: string): SessionRecord {
  const found = findSession(db, sessionId);
  if (!found) throw new DomainError(`Сессия ${sessionId} не найдена`, 404);
  return found;
}

function normaliseUtm(raw: UtmParams | undefined): Required<UtmParams> {
  const clip = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim().slice(0, 120);
    return trimmed === '' ? null : trimmed;
  };
  return {
    utm_source: clip(raw?.utm_source),
    utm_medium: clip(raw?.utm_medium),
    utm_campaign: clip(raw?.utm_campaign),
    utm_content: clip(raw?.utm_content),
    utm_term: clip(raw?.utm_term),
  };
}

export interface CreateSessionInput {
  funnelId: string;
  utm?: UtmParams;
  /** Value of the `?variant=` query parameter, if present. */
  variantOverride?: unknown;
  userAgent?: string | null;
  /** Test/generator hook: fixes the session id and creation timestamp. */
  sessionId?: string;
  createdAt?: string;
}

/**
 * Creates a session on the *currently active* version and pins it there for good.
 * Everything downstream — the config served, the events stored, the analytics
 * bucket — reads `funnel_version` off this row, never the live pointer.
 */
export function createSession(db: Db, input: CreateSessionInput): SessionBootstrap {
  const active = getActiveVersion(db, input.funnelId);
  const sessionId = input.sessionId ?? randomUUID();
  const override = parseVariantOverride(input.variantOverride, active.config.experiment);
  const variant: VariantId = override ?? assignVariant(sessionId, active.config.experiment);
  const resolved = resolveConfigFor(active, variant);
  const utm = normaliseUtm(input.utm);
  const createdAt = input.createdAt ?? nowIso();

  db.prepare(
    `INSERT INTO sessions
       (session_id, funnel_id, funnel_version, variant, variant_source, created_at, updated_at,
        completed_at, current_step, answers_json, history_json,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    input.funnelId,
    active.version,
    variant,
    override ? 'override' : 'assigned',
    createdAt,
    createdAt,
    resolved.start,
    JSON.stringify([resolved.start]),
    utm.utm_source,
    utm.utm_medium,
    utm.utm_campaign,
    utm.utm_content,
    utm.utm_term,
    input.userAgent ?? null,
  );

  // Emitted server-side so "сессия началась" can never be lost to an ad blocker
  // or a failed beacon. The id is derived, so a client that also sends it dedupes.
  ingestEvents(db, [
    {
      event_id: `${sessionId}:session_started`,
      session_id: sessionId,
      event_type: 'session_started',
      client_ts: createdAt,
      step_id: resolved.start,
      props: {
        variant_source: override ? 'override' : 'assigned',
        experiment_key: active.config.experiment.key,
        schema_version: active.config.schemaVersion,
      },
    },
  ]);

  return bootstrapFor(db, requireSession(db, sessionId));
}

/** The payload the client needs to render (or re-render) the funnel. */
export function bootstrapFor(db: Db, session: SessionRecord): SessionBootstrap {
  const stored = requireVersion(db, session.funnel_version);
  const config = resolveConfigFor(stored, session.variant);
  const activeVersion = getActiveVersionNumber(db, session.funnel_id);

  // A session pinned to a since-replaced version must still resolve to a real
  // step; if its config changed shape underneath it we fall back to the start.
  const currentStep = getStep(config, session.current_step) ? session.current_step : config.start;

  return {
    session: { ...session, current_step: currentStep },
    config,
    progress: computeProgress(config, session.answers, currentStep, session.history),
    version_is_stale: activeVersion !== null && activeVersion !== session.funnel_version,
    active_version: activeVersion ?? session.funnel_version,
  };
}

export interface SubmitAnswerInput {
  stepId: string;
  value: AnswerValue;
  /** Client-generated ids so a retried submit does not double-count. */
  eventIds?: { answer?: string; completed?: string; viewed?: string };
  clientTs?: string;
}

export interface SubmitAnswerResult extends SessionBootstrap {
  previous_step: string;
  next_step: string | null;
}

/**
 * Validates and stores one answer, then resolves the next step from the config.
 * The server owns navigation: the client cannot jump to a step the conditions
 * do not allow, and the stored `current_step` is what a refresh restores.
 */
export function submitAnswer(
  db: Db,
  sessionId: string,
  input: SubmitAnswerInput,
): SubmitAnswerResult {
  const session = requireSession(db, sessionId);
  const stored = requireVersion(db, session.funnel_version);
  const config = resolveConfigFor(stored, session.variant);

  const step = getStep(config, input.stepId);
  if (!step) throw new DomainError(`Шаг "${input.stepId}" отсутствует в версии ${session.funnel_version}`, 400);

  const verdict = validateAnswer(step, input.value);
  if (!verdict.ok) {
    throw new DomainError(verdict.error ?? 'Некорректный ответ', 422, { step_id: step.id, field: stepField(step) });
  }

  const answers: AnswerMap = { ...session.answers };
  const field = stepField(step);
  if (field) answers[field] = input.value;

  // Answers belonging to steps that are no longer on the path (the user went
  // back and took the other branch) are dropped, so conditions and the result
  // screen never read a stale value from an abandoned branch.
  const nextStep = resolveNext(config, step.id, answers);
  const history = [...session.history];
  const atIndex = history.lastIndexOf(step.id);
  const trimmed = atIndex === -1 ? history : history.slice(0, atIndex + 1);
  if (nextStep && trimmed[trimmed.length - 1] !== nextStep) trimmed.push(nextStep);

  const abandoned = new Set(history.slice(atIndex + 1));
  for (const id of abandoned) {
    if (id === nextStep) continue;
    const abandonedField = stepField(getStep(config, id) ?? ({} as never));
    if (abandonedField && abandonedField !== field) delete answers[abandonedField];
  }

  const target = nextStep ?? step.id;
  const targetStep = getStep(config, target);
  const completedAt = targetStep?.type === 'result' ? (session.completed_at ?? nowIso()) : session.completed_at;

  db.prepare(
    `UPDATE sessions
        SET answers_json = ?, history_json = ?, current_step = ?, updated_at = ?, completed_at = ?
      WHERE session_id = ?`,
  ).run(JSON.stringify(answers), JSON.stringify(trimmed), target, nowIso(), completedAt, sessionId);

  const clientTs = input.clientTs ?? nowIso();
  const base = { session_id: sessionId, client_ts: clientTs };

  // The raw value never leaves this function: only the sanitised projection is
  // handed to the event store.
  ingestEvents(db, [
    {
      ...base,
      event_id: input.eventIds?.answer ?? `${sessionId}:${step.id}:answer:${trimmed.length}`,
      event_type: 'answer_submitted',
      step_id: step.id,
      props: { answer: sanitizeAnswer(step, input.value) },
    },
    {
      ...base,
      event_id: input.eventIds?.completed ?? `${sessionId}:${step.id}:completed:${trimmed.length}`,
      event_type: 'step_completed',
      step_id: step.id,
      props: { next_step: nextStep, branched: Array.isArray(step.next) && step.next.length > 1 },
    },
  ]);

  return {
    ...bootstrapFor(db, requireSession(db, sessionId)),
    previous_step: step.id,
    next_step: nextStep,
  };
}

/**
 * Steps back one entry in the session's own history. The answer for the step
 * being returned to is kept, so the user sees what they picked.
 */
export function goBack(
  db: Db,
  sessionId: string,
  opts: { eventId?: string; clientTs?: string } = {},
): SessionBootstrap & { previous_step: string } {
  const session = requireSession(db, sessionId);
  const stored = requireVersion(db, session.funnel_version);
  const config = resolveConfigFor(stored, session.variant);

  const history = [...session.history];
  const currentIndex = history.lastIndexOf(session.current_step);
  const fromStep = session.current_step;

  let target = session.current_step;
  if (currentIndex > 0) {
    target = history[currentIndex - 1] as string;
  } else {
    // History lost (old session, trimmed state): recompute from the config path.
    const { path } = computeProgress(config, session.answers, session.current_step, history);
    const idx = path.indexOf(session.current_step);
    if (idx > 0) target = path[idx - 1] as string;
  }

  if (target !== session.current_step) {
    db.prepare('UPDATE sessions SET current_step = ?, updated_at = ? WHERE session_id = ?').run(
      target,
      nowIso(),
      sessionId,
    );
    ingestEvents(db, [
      {
        event_id: opts.eventId ?? `${sessionId}:${fromStep}:back:${currentIndex}`,
        session_id: sessionId,
        event_type: 'back_clicked',
        step_id: fromStep,
        client_ts: opts.clientTs ?? nowIso(),
        props: { from_step: fromStep, to_step: target },
      },
    ]);
  }

  return { ...bootstrapFor(db, requireSession(db, sessionId)), previous_step: fromStep };
}

export interface SessionListRow {
  session_id: string;
  funnel_version: number;
  variant: string;
  variant_source: string;
  created_at: string;
  updated_at: string;
  current_step: string;
  completed_at: string | null;
  utm_campaign: string | null;
  event_count: number;
}

/** Operational listing for the admin page. Deliberately excludes raw answers. */
export function listSessions(db: Db, funnelId: string, limit = 40): SessionListRow[] {
  return db
    .prepare(
      `SELECT s.session_id, s.funnel_version, s.variant, s.variant_source, s.created_at,
              s.updated_at, s.current_step, s.completed_at, s.utm_campaign,
              (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
         FROM sessions s
        WHERE s.funnel_id = ?
        ORDER BY s.created_at DESC
        LIMIT ?`,
    )
    .all(funnelId, limit) as SessionListRow[];
}

export function countSessionsByVersion(db: Db, funnelId: string): Record<number, number> {
  const rows = db
    .prepare('SELECT funnel_version AS v, COUNT(*) AS n FROM sessions WHERE funnel_id = ? GROUP BY v')
    .all(funnelId) as { v: number; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.v, r.n]));
}

export type { FunnelConfig };
