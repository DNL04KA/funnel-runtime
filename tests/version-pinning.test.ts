import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionBootstrap } from '@funnel/shared';
import { answer, createSession, loadConfig, startHarness, walkToResult, type Harness } from './helpers.js';

describe('закрепление версии за сессией', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ configs: ['funnel.v1.json'] });
  });
  afterEach(async () => {
    await h.close();
  });

  it('новая сессия стартует на текущей активной версии', async () => {
    const boot = await createSession(h);
    expect(boot.session.funnel_version).toBe(1);
    expect(boot.active_version).toBe(1);
    expect(boot.version_is_stale).toBe(false);
  });

  it('старая сессия остаётся на своей версии после публикации новой', async () => {
    const old = await createSession(h);
    expect(old.session.funnel_version).toBe(1);

    // Move it a step in, so it has real state to lose.
    const afterIntro = await answer(h, old.session.session_id, 'intro', null);
    expect(afterIntro.session.current_step).toBe('role');

    const published = await h.post<{ version: number; activated: boolean }>('/api/admin/versions', {
      config: loadConfig('funnel.v2.json'),
      notes: 'вторая версия',
      activate: true,
    });
    expect(published.status).toBe(201);
    expect(published.body.version).toBe(2);

    const reloaded = await h.get<SessionBootstrap>(`/api/session/${old.session.session_id}`);
    expect(reloaded.body.session.funnel_version).toBe(1);
    expect(reloaded.body.active_version).toBe(2);
    expect(reloaded.body.version_is_stale).toBe(true);
    // Still mid-funnel, not reset.
    expect(reloaded.body.session.current_step).toBe('role');
    // And it is being served v1's config, which has no `budget` step.
    expect(reloaded.body.config.steps.map((s) => s.id)).not.toContain('budget');
  });

  it('старая сессия доходит до результата на своей версии без ошибок', async () => {
    const old = await createSession(h);
    await h.post('/api/admin/versions', { config: loadConfig('funnel.v2.json'), activate: true });

    const reloaded = await h.get<SessionBootstrap>(`/api/session/${old.session.session_id}`);
    const finished = await walkToResult(h, reloaded.body);

    expect(finished.session.funnel_version).toBe(1);
    const result = await h.get<{ outcome: { headline: string }; funnel_version: number }>(
      `/api/session/${old.session.session_id}/result`,
    );
    expect(result.status).toBe(200);
    expect(result.body.funnel_version).toBe(1);
    expect(result.body.outcome.headline).toBeTruthy();
  });

  it('новые сессии стартуют только на активной версии', async () => {
    await h.post('/api/admin/versions', { config: loadConfig('funnel.v2.json'), activate: true });

    const fresh = await createSession(h);
    expect(fresh.session.funnel_version).toBe(2);
    expect(fresh.version_is_stale).toBe(false);
    expect(fresh.config.steps.map((s) => s.id)).toContain('budget');
  });

  it('события сессии записываются с её версией, а не с активной', async () => {
    const old = await createSession(h);
    await h.post('/api/admin/versions', { config: loadConfig('funnel.v2.json'), activate: true });
    await answer(h, old.session.session_id, 'intro', null);

    const versions = h.db
      .prepare('SELECT DISTINCT funnel_version AS v FROM events WHERE session_id = ?')
      .all(old.session.session_id) as { v: number }[];

    expect(versions).toEqual([{ v: 1 }]);
  });

  it('клиент не может подменить версию события', async () => {
    const boot = await createSession(h);
    await h.post('/api/events', {
      events: [
        {
          event_id: 'spoof-event-01',
          session_id: boot.session.session_id,
          event_type: 'step_viewed',
          client_ts: new Date().toISOString(),
          step_id: 'intro',
          funnel_version: 999,
          variant: 'Z',
        },
      ],
    });

    const row = h.db
      .prepare('SELECT funnel_version, variant FROM events WHERE event_id = ?')
      .get('spoof-event-01') as { funnel_version: number; variant: string };

    expect(row.funnel_version).toBe(1);
    expect(row.variant).toBe(boot.session.variant);
  });
});
