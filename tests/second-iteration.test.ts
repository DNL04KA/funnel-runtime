import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionBootstrap } from '@funnel/shared';
import { resolveVariantConfig } from '@funnel/shared';
import {
  answer,
  createSession,
  evt,
  loadConfig,
  sendEvents,
  startHarness,
  walkToResult,
  type Harness,
} from './helpers.js';

/**
 * Section 8 of the brief: a new config arrives that adds a conditional branch,
 * removes a screen for variant B and introduces a new event type. It must be
 * publishable and then rollback-able without a schema change and without losing
 * the analytics already collected.
 */
describe('вторая итерация: публикация v3 и откат', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ configs: ['funnel.v1.json', 'funnel.v2.json'] });
  });
  afterEach(async () => {
    await h.close();
  });

  const publishV3 = (): Promise<{ status: number; body: { version: number } }> =>
    h.post<{ version: number }>('/api/admin/versions', {
      file: 'funnel.v3.json',
      notes: 'вторая итерация',
      activate: true,
    });

  it('v3 добавляет условную ветку, которой не было в v2', async () => {
    const v2 = loadConfig('funnel.v2.json');
    const v3 = loadConfig('funnel.v3.json');

    const branchCount = (cfg: typeof v2): number =>
      cfg.steps.filter((s) => Array.isArray(s.next) && s.next.length > 1).length;

    expect(branchCount(v3)).toBeGreaterThan(branchCount(v2));
    expect(v2.steps.map((s) => s.id)).not.toContain('sla');
    expect(v3.steps.map((s) => s.id)).toContain('sla');
  });

  it('новая ветка срабатывает только при выполнении условия', async () => {
    await publishV3();

    // enterprise volume → the new `sla` screen is on the path.
    const big = await createSession(h, { variant: 'A' });
    await answer(h, big.session.session_id, 'intro', null);
    await answer(h, big.session.session_id, 'role', 'ops');
    await answer(h, big.session.session_id, 'warehouses', 12);
    await answer(h, big.session.session_id, 'volume', 'enterprise');
    await answer(h, big.session.session_id, 'budget', 9_000_000);
    const afterFeatures = await answer(h, big.session.session_id, 'features', ['picking', 'analytics']);
    expect(afterFeatures.session.current_step).toBe('sla');

    // A modest profile skips straight to the result.
    const small = await createSession(h, { variant: 'A' });
    await answer(h, small.session.session_id, 'intro', null);
    await answer(h, small.session.session_id, 'role', 'ops');
    await answer(h, small.session.session_id, 'warehouses', 2);
    await answer(h, small.session.session_id, 'volume', 'upto_500');
    const smallAfterFeatures = await answer(h, small.session.session_id, 'features', [
      'picking',
      'inventory',
    ]);
    expect(smallAfterFeatures.session.current_step).toBe('result');
  });

  it('вариант B не получает удалённый экран, а переходы перевязаны', async () => {
    await publishV3();

    const a = await createSession(h, { variant: 'A' });
    const b = await createSession(h, { variant: 'B' });

    expect(a.config.steps.map((s) => s.id)).toContain('warehouses');
    expect(b.config.steps.map((s) => s.id)).not.toContain('warehouses');

    // No remaining transition may point at the removed step.
    const danglingTargets = b.config.steps.flatMap((s) =>
      !s.next ? [] : typeof s.next === 'string' ? [s.next] : s.next.map((r) => r.goto),
    );
    expect(danglingTargets).not.toContain('warehouses');

    // And the path that used to go through it still reaches the result.
    await answer(h, b.session.session_id, 'intro', null);
    const afterRole = await answer(h, b.session.session_id, 'role', 'ops');
    expect(afterRole.session.current_step).toBe('features');

    const finished = await walkToResult(h, afterRole);
    expect(finished.session.current_step).toBe('result');
  });

  it('обе ветки обоих вариантов v3 доходят до результата', async () => {
    await publishV3();

    for (const variant of ['A', 'B'] as const) {
      for (const role of ['ops', 'it']) {
        for (const volume of ['upto_500', 'enterprise']) {
          const boot = await createSession(h, { variant });
          const finished = await walkToResult(h, boot, (stepId) => {
            if (stepId === 'role') return role;
            if (stepId === 'volume') return volume;
            return undefined;
          });
          expect(finished.session.current_step, `${variant}/${role}/${volume}`).toBe('result');
        }
      }
    }
  });

  it('новое событие hint_expanded принимается без изменения схемы', async () => {
    const tablesBefore = (
      h.db.prepare("SELECT GROUP_CONCAT(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name").get() as {
        s: string;
      }
    ).s;

    await publishV3();
    const boot = await createSession(h);

    const res = await sendEvents(h, [
      evt(boot.session.session_id, 'hint_expanded', {
        event_id: `${boot.session.session_id}:intro:hint:1`,
        step_id: 'intro',
      }),
    ]);
    expect(res.accepted).toBe(1);

    const tablesAfter = (
      h.db.prepare("SELECT GROUP_CONCAT(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name").get() as {
        s: string;
      }
    ).s;
    expect(tablesAfter).toBe(tablesBefore);

    const analytics = await h.get<{ event_counts: { event_type: string; sessions: number }[] }>(
      '/api/analytics',
    );
    expect(analytics.body.event_counts.find((e) => e.event_type === 'hint_expanded')?.sessions).toBe(1);
  });

  it('активные сессии на v2 продолжают работу после публикации v3', async () => {
    const onV2 = await createSession(h);
    expect(onV2.session.funnel_version).toBe(2);
    await answer(h, onV2.session.session_id, 'intro', null);
    await answer(h, onV2.session.session_id, 'role', 'ops');

    await publishV3();

    const reloaded = await h.get<SessionBootstrap>(`/api/session/${onV2.session.session_id}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.session.funnel_version).toBe(2);
    expect(reloaded.body.version_is_stale).toBe(true);
    // v2 has no `sla` step; this session must never be routed to one.
    expect(reloaded.body.config.steps.map((s) => s.id)).not.toContain('sla');

    const finished = await walkToResult(h, reloaded.body);
    expect(finished.session.current_step).toBe('result');
    expect(finished.session.funnel_version).toBe(2);

    const result = await h.get<{ funnel_version: number }>(
      `/api/session/${onV2.session.session_id}/result`,
    );
    expect(result.status).toBe(200);
    expect(result.body.funnel_version).toBe(2);
  });

  it('откат с v3 на v2 сохраняет аналитику v3 и не ломает сессии v3', async () => {
    await publishV3();

    const onV3 = await createSession(h);
    await answer(h, onV3.session.session_id, 'intro', null);
    const v3EventsBefore = (
      h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE funnel_version = 3').get() as { n: number }
    ).n;
    expect(v3EventsBefore).toBeGreaterThan(0);

    const rolled = await h.post<{ action: string; version: number }>('/api/admin/activate', {
      version: 2,
      note: 'откат второй итерации',
    });
    expect(rolled.body).toMatchObject({ action: 'rollback', version: 2 });

    // v3's analytics survive untouched…
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE funnel_version = 3').get() as { n: number }).n,
    ).toBe(v3EventsBefore);

    // …the v3 session keeps running on v3…
    const finished = await walkToResult(
      h,
      (await h.get<SessionBootstrap>(`/api/session/${onV3.session.session_id}`)).body,
    );
    expect(finished.session.funnel_version).toBe(3);
    expect(finished.session.current_step).toBe('result');

    // …and new sessions start on v2 again.
    const fresh = await createSession(h);
    expect(fresh.session.funnel_version).toBe(2);
    expect(fresh.config.steps.map((s) => s.id)).not.toContain('sla');
  });

  it('после отката дашборд по-прежнему сравнивает все три версии', async () => {
    await createSession(h);
    await publishV3();
    await createSession(h);
    await h.post('/api/admin/activate', { version: 1 });
    await createSession(h);

    const analytics = await h.get<{ by_version: { key: string; totals: { sessions_started: number } }[] }>(
      '/api/analytics',
    );
    const keys = analytics.body.by_version.map((s) => s.key).sort();
    expect(keys).toEqual(['1', '2', '3']);
  });

  it('резолвинг варианта B для v3 проходит валидацию публикации', async () => {
    const published = await publishV3();
    expect(published.status).toBe(201);

    const v3 = loadConfig('funnel.v3.json');
    const resolvedB = resolveVariantConfig(v3, 'B');
    expect(resolvedB.start).toBe('intro');
    expect(resolvedB.steps.some((s) => s.type === 'result')).toBe(true);
  });
});
