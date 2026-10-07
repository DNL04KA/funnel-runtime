import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, evt, sendEvents, startHarness, type Harness } from './helpers.js';

describe('идемпотентность и дедупликация событий', () => {
  let h: Harness;
  let sessionId: string;

  beforeEach(async () => {
    h = await startHarness({ configs: ['funnel.v1.json'] });
    sessionId = (await createSession(h)).session.session_id;
  });
  afterEach(async () => {
    await h.close();
  });

  const countEvents = (): number =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId) as { n: number }).n;

  it('повторная отправка того же event_id не создаёт дубль', async () => {
    const event = evt(sessionId, 'step_viewed', { event_id: 'fixed-event-0001', step_id: 'intro' });
    const before = countEvents();

    const first = await sendEvents(h, [event]);
    expect(first.accepted).toBe(1);
    expect(first.duplicates).toBe(0);

    const second = await sendEvents(h, [event]);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);

    expect(countEvents()).toBe(before + 1);
  });

  it('повторная отправка всей пачки после timeout безопасна', async () => {
    const batch = [
      evt(sessionId, 'step_viewed', { event_id: 'batch-evt-aaaa', step_id: 'intro' }),
      evt(sessionId, 'step_completed', { event_id: 'batch-evt-bbbb', step_id: 'intro' }),
      evt(sessionId, 'step_viewed', { event_id: 'batch-evt-cccc', step_id: 'role' }),
    ];
    const before = countEvents();

    const first = await sendEvents(h, batch);
    expect(first.accepted).toBe(3);

    // Three identical retries, as a flaky network would produce.
    for (let i = 0; i < 3; i += 1) {
      const retry = await sendEvents(h, batch);
      expect(retry.accepted).toBe(0);
      expect(retry.duplicates).toBe(3);
    }

    expect(countEvents()).toBe(before + 3);
  });

  it('дубли внутри одной пачки схлопываются', async () => {
    const event = evt(sessionId, 'cta_clicked', { event_id: 'same-event-id-01', step_id: 'result' });
    const res = await sendEvents(h, [event, { ...event }, { ...event }]);

    expect(res.received).toBe(3);
    expect(res.accepted).toBe(1);
    expect(res.duplicates).toBe(2);
  });

  it('некорректное событие не ломает обработку остальной пачки', async () => {
    const before = countEvents();
    const res = await sendEvents(h, [
      evt(sessionId, 'step_viewed', { event_id: 'ok-event-0001', step_id: 'intro' }),
      { event_id: 'broken-no-session', event_type: 'step_viewed', client_ts: new Date().toISOString() },
      evt(sessionId, 'unknown_event_type', { event_id: 'bad-type-event-1' }),
      evt(sessionId, 'step_viewed', { event_id: 'bad-ts-event-01', client_ts: 'не дата' }),
      evt(sessionId, 'cta_clicked', { event_id: 'nonexistent-session-evt', session_id: 'session-does-not-exist' }),
      evt(sessionId, 'step_completed', { event_id: 'ok-event-0002', step_id: 'intro' }),
    ]);

    expect(res.received).toBe(6);
    expect(res.accepted).toBe(2);
    expect(res.rejected).toBe(4);
    expect(countEvents()).toBe(before + 2);

    // Rejections are retained for inspection, but outside the events table.
    const rejects = h.db.prepare('SELECT COUNT(*) AS n FROM event_rejects').get() as { n: number };
    expect(rejects.n).toBe(4);
  });

  it('события принимаются пачкой и возвращают статус по каждому', async () => {
    const res = await sendEvents(h, [
      evt(sessionId, 'step_viewed', { event_id: 'multi-event-01', step_id: 'intro' }),
      evt(sessionId, 'step_viewed', { event_id: 'multi-event-01', step_id: 'intro' }),
      evt(sessionId, 'bogus', { event_id: 'multi-event-03' }),
    ]);

    const statuses = (res.results as { index: number; status: string }[]).map((r) => [r.index, r.status]);
    expect(statuses).toEqual([
      [0, 'accepted'],
      [1, 'duplicate'],
      [2, 'rejected'],
    ]);
  });

  it('сырые ответы не попадают в события: число превращается в бакет', async () => {
    const boot = await createSession(h);
    const id = boot.session.session_id;
    await h.post(`/api/session/${id}/answer`, { step_id: 'intro', value: null });
    await h.post(`/api/session/${id}/answer`, { step_id: 'role', value: 'ops' });
    await h.post(`/api/session/${id}/answer`, { step_id: 'warehouses', value: 37 });

    const row = h.db
      .prepare(
        `SELECT props_json FROM events
          WHERE session_id = ? AND event_type = 'answer_submitted' AND step_id = 'warehouses'`,
      )
      .get(id) as { props_json: string };

    const props = JSON.parse(row.props_json) as { answer: { bucket?: string } };
    expect(props.answer.bucket).toBe('26+');
    expect(row.props_json).not.toContain('37');

    // The exact figure is still available operationally, on the session record.
    const session = h.db.prepare('SELECT answers_json FROM sessions WHERE session_id = ?').get(id) as {
      answers_json: string;
    };
    expect(JSON.parse(session.answers_json)).toMatchObject({ warehouses: 37 });
  });

  it('пустая и слишком большая пачка отклоняются целиком', async () => {
    const empty = await h.post<{ error: string }>('/api/events', { events: [] });
    expect(empty.status).toBe(400);

    const huge = await h.post<{ error: string }>('/api/events', {
      events: Array.from({ length: 501 }, (_, i) => evt(sessionId, 'step_viewed', { event_id: `bulk-event-${i}` })),
    });
    expect(huge.status).toBe(400);
  });
});
