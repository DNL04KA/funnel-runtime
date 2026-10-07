import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsResponse } from '../server/src/domain/analytics.js';
import { answer, createSession, evt, sendEvents, startHarness, type Harness } from './helpers.js';

/**
 * These tests build traffic by hand rather than through the generator, so every
 * expected number can be derived by counting on your fingers.
 */
describe('расчёт аналитических показателей', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ configs: ['funnel.v1.json'] });
  });
  afterEach(async () => {
    await h.close();
  });

  const analytics = async (query = ''): Promise<AnalyticsResponse> =>
    (await h.get<AnalyticsResponse>(`/api/analytics${query}`)).body;

  const stepOf = (data: AnalyticsResponse, id: string) => data.steps.find((s) => s.step_id === id);

  /** One session that views `viewSteps` and optionally reaches the result. */
  async function fakeSession(opts: {
    variant?: 'A' | 'B';
    campaign?: string | null;
    viewSteps: string[];
    reachResult?: boolean;
    clickCta?: boolean;
  }): Promise<string> {
    const boot = await createSession(h, {
      ...(opts.variant ? { variant: opts.variant } : {}),
      utm_campaign: opts.campaign ?? null,
    });
    const id = boot.session.session_id;

    const events = opts.viewSteps.flatMap((stepId, i) => [
      evt(id, 'step_viewed', { event_id: `${id}:${stepId}:v`, step_id: stepId }),
      // The last viewed step is where the session stopped: no completion for it.
      ...(i < opts.viewSteps.length - 1 || opts.reachResult
        ? [evt(id, 'step_completed', { event_id: `${id}:${stepId}:c`, step_id: stepId })]
        : []),
    ]);

    if (opts.reachResult) {
      events.push(evt(id, 'step_viewed', { event_id: `${id}:result:v`, step_id: 'result' }));
      events.push(evt(id, 'result_viewed', { event_id: `${id}:result:r`, step_id: 'result' }));
      if (opts.clickCta) {
        events.push(evt(id, 'cta_clicked', { event_id: `${id}:result:cta`, step_id: 'result' }));
      }
    }

    await sendEvents(h, events);
    return id;
  }

  it('считает начавших по уникальным сессиям, а не по числу событий', async () => {
    const id = (await createSession(h)).session.session_id;

    // Twelve step views from one session must still be one starter.
    await sendEvents(
      h,
      Array.from({ length: 12 }, (_, i) =>
        evt(id, 'step_viewed', { event_id: `${id}:spam:${i}`, step_id: 'intro' }),
      ),
    );

    const data = await analytics();
    expect(data.overall.sessions_started).toBe(1);
    expect(stepOf(data, 'intro')?.viewed).toBe(1);
    expect(data.event_counts.find((e) => e.event_type === 'step_viewed')?.events).toBe(12);
  });

  it('дубли событий не влияют на агрегаты', async () => {
    await fakeSession({ viewSteps: ['intro', 'role'], reachResult: true, clickCta: true });
    const before = await analytics();

    // Replay every stored event verbatim.
    const stored = h.db.prepare('SELECT * FROM events').all() as {
      event_id: string;
      session_id: string;
      event_type: string;
      step_id: string | null;
      client_ts: string;
    }[];
    const replay = await sendEvents(
      h,
      stored.map((e) => ({
        event_id: e.event_id,
        session_id: e.session_id,
        event_type: e.event_type,
        step_id: e.step_id,
        client_ts: e.client_ts,
      })),
    );
    expect(replay.accepted).toBe(0);
    expect(replay.duplicates).toBe(stored.length);

    const after = await analytics();
    expect(after.overall).toEqual(before.overall);
    expect(after.steps.map((s) => [s.step_id, s.viewed, s.completed])).toEqual(
      before.steps.map((s) => [s.step_id, s.viewed, s.completed]),
    );
  });

  it('повторные просмотры после возврата назад не раздувают воронку', async () => {
    const boot = await createSession(h);
    const id = boot.session.session_id;

    await sendEvents(h, [
      evt(id, 'step_viewed', { event_id: `${id}:intro:v1`, step_id: 'intro' }),
      evt(id, 'step_completed', { event_id: `${id}:intro:c1`, step_id: 'intro' }),
      evt(id, 'step_viewed', { event_id: `${id}:role:v1`, step_id: 'role' }),
      evt(id, 'back_clicked', { event_id: `${id}:back:1`, step_id: 'role' }),
      // Second pass over the same two steps.
      evt(id, 'step_viewed', { event_id: `${id}:intro:v2`, step_id: 'intro' }),
      evt(id, 'step_completed', { event_id: `${id}:intro:c2`, step_id: 'intro' }),
      evt(id, 'step_viewed', { event_id: `${id}:role:v2`, step_id: 'role' }),
    ]);

    const data = await analytics();
    expect(stepOf(data, 'intro')?.viewed).toBe(1);
    expect(stepOf(data, 'intro')?.completed).toBe(1);
    expect(stepOf(data, 'role')?.viewed).toBe(1);
    expect(stepOf(data, 'intro')?.repeat_view_sessions).toBe(1);
    expect(data.overall.sessions_with_back).toBe(1);
  });

  it('события, пришедшие не по порядку, дают те же цифры', async () => {
    const forward = await createSession(h);
    const shuffled = await createSession(h);

    const build = (id: string): Record<string, unknown>[] => {
      const t0 = Date.parse('2026-10-01T10:00:00.000Z');
      return ['intro', 'role', 'volume'].flatMap((stepId, i) => [
        evt(id, 'step_viewed', {
          event_id: `${id}:${stepId}:v`,
          step_id: stepId,
          client_ts: new Date(t0 + i * 60_000).toISOString(),
        }),
        evt(id, 'step_completed', {
          event_id: `${id}:${stepId}:c`,
          step_id: stepId,
          client_ts: new Date(t0 + i * 60_000 + 30_000).toISOString(),
        }),
      ]);
    };

    await sendEvents(h, build(forward.session.session_id));
    await sendEvents(h, build(shuffled.session.session_id).reverse());

    const data = await analytics();
    for (const stepId of ['intro', 'role', 'volume']) {
      // Both sessions must register identically on every step.
      expect(stepOf(data, stepId)?.viewed).toBe(2);
      expect(stepOf(data, stepId)?.completed).toBe(2);
    }
    expect(data.data_quality.out_of_order_events).toBeGreaterThan(0);
  });

  it('конверсия, отвал и достижение результата считаются корректно', async () => {
    // 5 sessions reach the result, 3 of them click the CTA; 3 drop at `role`.
    for (let i = 0; i < 5; i += 1) {
      await fakeSession({ viewSteps: ['intro', 'role'], reachResult: true, clickCta: i < 3 });
    }
    for (let i = 0; i < 3; i += 1) {
      await fakeSession({ viewSteps: ['intro', 'role'] });
    }

    const data = await analytics();
    expect(data.overall.sessions_started).toBe(8);
    expect(data.overall.result_reached).toBe(5);
    expect(data.overall.result_rate).toBeCloseTo(5 / 8, 4);
    expect(data.overall.cta_clicked).toBe(3);
    expect(data.overall.cta_ctr).toBeCloseTo(3 / 5, 4);
    expect(data.overall.cta_rate_of_started).toBeCloseTo(3 / 8, 4);

    expect(stepOf(data, 'intro')?.viewed).toBe(8);
    expect(stepOf(data, 'intro')?.completed).toBe(8);

    const role = stepOf(data, 'role');
    expect(role?.viewed).toBe(8);
    expect(role?.completed).toBe(5);
    expect(role?.dropped).toBe(3);
    expect(role?.drop_rate).toBeCloseTo(3 / 8, 4);

    // The result row's "completed" is the CTA click, not a step_completed.
    const result = stepOf(data, 'result');
    expect(result?.viewed).toBe(5);
    expect(result?.completed).toBe(3);
    expect(result?.step_conversion).toBeCloseTo(3 / 5, 4);
  });

  it('сравнение вариантов A и B разделяет сессии', async () => {
    for (let i = 0; i < 4; i += 1) {
      await fakeSession({ variant: 'A', viewSteps: ['intro'], reachResult: true, clickCta: i < 1 });
    }
    for (let i = 0; i < 6; i += 1) {
      await fakeSession({ variant: 'B', viewSteps: ['intro'], reachResult: i < 3, clickCta: i < 3 });
    }

    const data = await analytics();
    const a = data.by_variant.find((s) => s.key === 'A');
    const b = data.by_variant.find((s) => s.key === 'B');

    expect(a?.totals.sessions_started).toBe(4);
    expect(a?.totals.result_reached).toBe(4);
    expect(a?.totals.cta_ctr).toBeCloseTo(1 / 4, 4);

    expect(b?.totals.sessions_started).toBe(6);
    expect(b?.totals.result_reached).toBe(3);
    expect(b?.totals.cta_ctr).toBeCloseTo(3 / 3, 4);

    const filtered = await analytics('?variant=A');
    expect(filtered.overall.sessions_started).toBe(4);
  });

  it('фильтр по utm_campaign сужает все показатели', async () => {
    await fakeSession({ campaign: 'alpha', viewSteps: ['intro'], reachResult: true, clickCta: true });
    await fakeSession({ campaign: 'alpha', viewSteps: ['intro'] });
    await fakeSession({ campaign: 'beta', viewSteps: ['intro'], reachResult: true });
    await fakeSession({ campaign: null, viewSteps: ['intro'] });

    const all = await analytics();
    expect(all.overall.sessions_started).toBe(4);

    const alpha = await analytics('?campaign=alpha');
    expect(alpha.overall.sessions_started).toBe(2);
    expect(alpha.overall.result_reached).toBe(1);
    expect(alpha.overall.cta_clicked).toBe(1);

    const none = await analytics(`?campaign=${encodeURIComponent('(none)')}`);
    expect(none.overall.sessions_started).toBe(1);

    const byCampaign = Object.fromEntries(all.by_campaign.map((c) => [c.campaign, c.sessions_started]));
    expect(byCampaign).toMatchObject({ alpha: 2, beta: 1, '(none)': 1 });
  });

  it('сравнение версий разделяет сессии по закреплённой версии', async () => {
    await fakeSession({ viewSteps: ['intro'], reachResult: true, clickCta: true });
    await h.post('/api/admin/versions', { file: 'funnel.v2.json', activate: true });
    await fakeSession({ viewSteps: ['intro'], reachResult: false });
    await fakeSession({ viewSteps: ['intro'], reachResult: true });

    const data = await analytics();
    const v1 = data.by_version.find((s) => s.key === '1');
    const v2 = data.by_version.find((s) => s.key === '2');

    expect(v1?.totals.sessions_started).toBe(1);
    expect(v1?.totals.result_reached).toBe(1);
    expect(v2?.totals.sessions_started).toBe(2);
    expect(v2?.totals.result_reached).toBe(1);

    const onlyV1 = await analytics('?version=1');
    expect(onlyV1.overall.sessions_started).toBe(1);
  });

  it('ветвление показывает распределение по веткам', async () => {
    const toIt = await createSession(h);
    await answer(h, toIt.session.session_id, 'intro', null);
    await answer(h, toIt.session.session_id, 'role', 'it');
    await sendEvents(h, [
      evt(toIt.session.session_id, 'step_viewed', {
        event_id: `${toIt.session.session_id}:integrations:v`,
        step_id: 'integrations',
      }),
    ]);

    for (const role of ['owner', 'ops']) {
      const s = await createSession(h);
      await answer(h, s.session.session_id, 'intro', null);
      await answer(h, s.session.session_id, 'role', role);
      await sendEvents(h, [
        evt(s.session.session_id, 'step_viewed', {
          event_id: `${s.session.session_id}:warehouses:v`,
          step_id: 'warehouses',
        }),
      ]);
    }

    const data = await analytics();
    const branches = Object.fromEntries(
      (stepOf(data, 'role')?.branches ?? []).map((b) => [b.to_step, b.sessions]),
    );
    expect(branches).toMatchObject({ integrations: 1, warehouses: 2 });
  });

  it('шаги, которых нет в данных, остаются в таблице с нулями', async () => {
    await fakeSession({ viewSteps: ['intro'] });

    const data = await analytics();
    const untouched = stepOf(data, 'features');
    expect(untouched).toBeDefined();
    expect(untouched?.viewed).toBe(0);
    expect(untouched?.in_config).toBe(true);
  });
});
