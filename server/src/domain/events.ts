import { z } from 'zod';
import {
  KNOWN_EVENT_TYPES,
  type EventIngestResponse,
  type EventIngestResult,
  type IncomingEvent,
} from '@funnel/shared';
import { nowIso, type Db } from '../db/index.js';

const utmString = z.string().trim().min(1).max(120).nullish();

/**
 * `event_id` has a minimum length on purpose. It is the deduplication key, so a
 * client that reuses a trivial id ("1", "ev") would silently collapse its whole
 * stream into a single stored event and look like it was working. Rejecting
 * short ids turns that bug into a visible error instead.
 */
const MIN_EVENT_ID_LENGTH = 8;

const incomingEventSchema = z.object({
  event_id: z
    .string()
    .trim()
    .min(MIN_EVENT_ID_LENGTH, `event_id короче ${MIN_EVENT_ID_LENGTH} символов — он используется как ключ дедупликации`)
    .max(120),
  session_id: z.string().trim().min(8).max(120),
  event_type: z.string().trim().min(1).max(60),
  client_ts: z.string().trim().min(1).max(40),
  step_id: z.string().trim().max(80).nullish(),
  // Supplied by clients for convenience, but never trusted: the stored values
  // are copied from the session row.
  funnel_version: z.number().int().positive().nullish(),
  variant: z.string().trim().max(8).nullish(),
  props: z.record(z.unknown()).nullish(),
  utm_source: utmString,
  utm_medium: utmString,
  utm_campaign: utmString,
  utm_content: utmString,
  utm_term: utmString,
});

export const eventBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(500),
});

interface SessionContext {
  funnel_id: string;
  funnel_version: number;
  variant: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
}

const PROPS_MAX_BYTES = 8 * 1024;

function normaliseClientTs(raw: string): string | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Accepts a batch of events and returns a per-item verdict.
 *
 * Four guarantees the task asks for, and where each one lives:
 *  - *idempotency*: `event_id` is the primary key, inserted with OR IGNORE, so a
 *    retried batch (after a timeout, a double click, a beacon resend) adds nothing.
 *  - *batching*: the whole array is processed in one transaction per item group.
 *  - *fault isolation*: each event is validated and inserted on its own; a bad
 *    one is recorded in `event_rejects` and the rest of the batch still lands.
 *  - *trust*: `funnel_version`, `variant` and the UTM tags are taken from the
 *    session row, so a client cannot attribute its events to another version,
 *    another variant or another campaign.
 */
export function ingestEvents(
  db: Db,
  rawEvents: unknown[],
  opts: { serverTs?: string } = {},
): EventIngestResponse {
  const serverTs = opts.serverTs ?? nowIso();
  const results: EventIngestResult[] = [];

  const sessionCache = new Map<string, SessionContext | null>();
  const getSession = (id: string): SessionContext | null => {
    if (!sessionCache.has(id)) {
      const row = db
        .prepare(
          `SELECT funnel_id, funnel_version, variant,
                  utm_source, utm_medium, utm_campaign, utm_content, utm_term
             FROM sessions WHERE session_id = ?`,
        )
        .get(id) as SessionContext | undefined;
      sessionCache.set(id, row ?? null);
    }
    return sessionCache.get(id) ?? null;
  };

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
       (event_id, session_id, event_type, step_id, funnel_id, funnel_version, variant,
        client_ts, server_ts, utm_source, utm_medium, utm_campaign, utm_content, utm_term, props_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const reject = db.prepare(
    `INSERT INTO event_rejects (received_at, reason, event_id, session_id, event_type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const handleOne = (raw: unknown, index: number): EventIngestResult => {
    const parsed = incomingEventSchema.safeParse(raw);
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join('; ');
      const candidate = (raw ?? {}) as Partial<IncomingEvent>;
      reject.run(
        serverTs,
        reason.slice(0, 500),
        typeof candidate.event_id === 'string' ? candidate.event_id.slice(0, 120) : null,
        typeof candidate.session_id === 'string' ? candidate.session_id.slice(0, 120) : null,
        typeof candidate.event_type === 'string' ? candidate.event_type.slice(0, 60) : null,
        safeStringify(raw),
      );
      return {
        index,
        event_id: typeof candidate.event_id === 'string' ? candidate.event_id : null,
        status: 'rejected',
        error: reason,
      };
    }

    const event = parsed.data;

    const clientTs = normaliseClientTs(event.client_ts);
    if (!clientTs) {
      reject.run(serverTs, 'client_ts не является валидной датой', event.event_id, event.session_id, event.event_type, safeStringify(raw));
      return { index, event_id: event.event_id, status: 'rejected', error: 'client_ts не является валидной датой' };
    }

    if (!KNOWN_EVENT_TYPES.includes(event.event_type)) {
      const reason = `неизвестный event_type "${event.event_type}"`;
      reject.run(serverTs, reason, event.event_id, event.session_id, event.event_type, safeStringify(raw));
      return { index, event_id: event.event_id, status: 'rejected', error: reason };
    }

    const session = getSession(event.session_id);
    if (!session) {
      const reason = 'неизвестный session_id';
      reject.run(serverTs, reason, event.event_id, event.session_id, event.event_type, safeStringify(raw));
      return { index, event_id: event.event_id, status: 'rejected', error: reason };
    }

    const propsJson = safeStringify(event.props ?? {});
    if (Buffer.byteLength(propsJson, 'utf8') > PROPS_MAX_BYTES) {
      const reason = 'props превышает 8 КБ';
      reject.run(serverTs, reason, event.event_id, event.session_id, event.event_type, propsJson.slice(0, 2000));
      return { index, event_id: event.event_id, status: 'rejected', error: reason };
    }

    const info = insert.run(
      event.event_id,
      event.session_id,
      event.event_type,
      event.step_id ?? null,
      session.funnel_id,
      session.funnel_version,
      session.variant,
      clientTs,
      serverTs,
      session.utm_source,
      session.utm_medium,
      session.utm_campaign,
      session.utm_content,
      session.utm_term,
      propsJson,
    );

    return {
      index,
      event_id: event.event_id,
      status: info.changes === 1 ? 'accepted' : 'duplicate',
    };
  };

  // One transaction for the batch keeps it fast; a throw inside `handleOne` is
  // caught per item so a single malformed event can never roll the batch back.
  const tx = db.transaction(() => {
    rawEvents.forEach((raw, index) => {
      try {
        results.push(handleOne(raw, index));
      } catch (err) {
        const reason = `ошибка обработки: ${(err as Error).message}`;
        try {
          reject.run(serverTs, reason.slice(0, 500), null, null, null, safeStringify(raw));
        } catch {
          /* rejection logging must never fail the batch */
        }
        results.push({ index, event_id: null, status: 'rejected', error: reason });
      }
    });
  });
  tx();

  const response: EventIngestResponse = {
    received: rawEvents.length,
    accepted: results.filter((r) => r.status === 'accepted').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    results,
  };

  bumpCounters(db, {
    batches: 1,
    received: response.received,
    accepted: response.accepted,
    duplicates: response.duplicates,
    rejected: response.rejected,
  });

  return response;
}

function bumpCounters(db: Db, deltas: Record<string, number>): void {
  const stmt = db.prepare(
    `INSERT INTO ingest_counters (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
  );
  const tx = db.transaction(() => {
    for (const [key, delta] of Object.entries(deltas)) {
      if (delta !== 0) stmt.run(key, delta);
    }
  });
  tx();
}

export interface IngestCounters {
  batches: number;
  received: number;
  accepted: number;
  duplicates: number;
  rejected: number;
}

export function getIngestCounters(db: Db): IngestCounters {
  const rows = db.prepare('SELECT key, value FROM ingest_counters').all() as {
    key: string;
    value: number;
  }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    batches: map.get('batches') ?? 0,
    received: map.get('received') ?? 0,
    accepted: map.get('accepted') ?? 0,
    duplicates: map.get('duplicates') ?? 0,
    rejected: map.get('rejected') ?? 0,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"<unserialisable>"';
  }
}

export interface RejectRow {
  id: number;
  received_at: string;
  reason: string;
  event_id: string | null;
  session_id: string | null;
  event_type: string | null;
  payload_json: string;
}

export function listRejects(db: Db, limit = 25): RejectRow[] {
  return db
    .prepare('SELECT * FROM event_rejects ORDER BY id DESC LIMIT ?')
    .all(limit) as RejectRow[];
}

export function countEvents(db: Db): { total: number; duplicates_blocked: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  const rejected = (db.prepare('SELECT COUNT(*) AS n FROM event_rejects').get() as { n: number }).n;
  return { total, duplicates_blocked: rejected };
}
