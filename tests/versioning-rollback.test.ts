import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FunnelConfig } from '@funnel/shared';
import { createSession, loadConfig, startHarness, walkToResult, type Harness } from './helpers.js';

interface Overview {
  active_version: number;
  versions: { version: number; is_active: boolean; session_count: number; event_count: number }[];
  audit: { action: string; from_version: number | null; to_version: number }[];
}

describe('публикация и откат версии', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ configs: ['funnel.v1.json'] });
  });
  afterEach(async () => {
    await h.close();
  });

  it('публикация создаёт новую версию и включает её без передеплоя', async () => {
    const before = await h.get<Overview>('/api/admin/overview');
    expect(before.body.active_version).toBe(1);

    const published = await h.post<{ version: number; activated: boolean }>('/api/admin/versions', {
      file: 'funnel.v2.json',
      notes: 'публикация из файла',
      activate: true,
    });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ version: 2, activated: true });

    const after = await h.get<Overview>('/api/admin/overview');
    expect(after.body.active_version).toBe(2);
    expect(after.body.versions).toHaveLength(2);
  });

  it('можно опубликовать версию, не включая её', async () => {
    await h.post('/api/admin/versions', { file: 'funnel.v2.json', activate: false });

    const overview = await h.get<Overview>('/api/admin/overview');
    expect(overview.body.active_version).toBe(1);
    expect(overview.body.versions.map((v) => v.version).sort()).toEqual([1, 2]);

    const fresh = await createSession(h);
    expect(fresh.session.funnel_version).toBe(1);
  });

  it('откат возвращает предыдущую версию и помечается в истории как rollback', async () => {
    await h.post('/api/admin/versions', { file: 'funnel.v2.json', activate: true });

    const rolled = await h.post<{ version: number; previous: number; action: string }>(
      '/api/admin/activate',
      { version: 1, note: 'откат' },
    );
    expect(rolled.status).toBe(200);
    expect(rolled.body).toMatchObject({ version: 1, previous: 2, action: 'rollback' });

    const overview = await h.get<Overview>('/api/admin/overview');
    expect(overview.body.active_version).toBe(1);
    expect(overview.body.audit[0]).toMatchObject({ action: 'rollback', from_version: 2, to_version: 1 });

    const fresh = await createSession(h);
    expect(fresh.session.funnel_version).toBe(1);
  });

  it('откат не теряет аналитику, собранную на откаченной версии', async () => {
    await h.post('/api/admin/versions', { file: 'funnel.v2.json', activate: true });

    const onV2 = await createSession(h);
    await walkToResult(h, onV2);

    const eventsOnV2 = (
      h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE funnel_version = 2').get() as { n: number }
    ).n;
    expect(eventsOnV2).toBeGreaterThan(0);

    await h.post('/api/admin/activate', { version: 1 });

    const afterRollback = (
      h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE funnel_version = 2').get() as { n: number }
    ).n;
    expect(afterRollback).toBe(eventsOnV2);

    const analytics = await h.get<{ by_version: { key: string; totals: { sessions_started: number } }[] }>(
      '/api/analytics',
    );
    const v2 = analytics.body.by_version.find((s) => s.key === '2');
    expect(v2?.totals.sessions_started).toBeGreaterThan(0);
  });

  it('сессия, начатая до отката, продолжает работать после него', async () => {
    await h.post('/api/admin/versions', { file: 'funnel.v2.json', activate: true });

    const onV2 = await createSession(h);
    expect(onV2.session.funnel_version).toBe(2);
    await h.post(`/api/session/${onV2.session.session_id}/answer`, { step_id: 'intro', value: null });

    await h.post('/api/admin/activate', { version: 1 });

    const finished = await walkToResult(
      h,
      (await h.get<typeof onV2>(`/api/session/${onV2.session.session_id}`)).body,
    );
    expect(finished.session.funnel_version).toBe(2);

    const result = await h.get<{ funnel_version: number }>(
      `/api/session/${onV2.session.session_id}/result`,
    );
    expect(result.status).toBe(200);
    expect(result.body.funnel_version).toBe(2);
  });

  it('откат не требует изменения схемы базы', async () => {
    const schemaBefore = (
      h.db.prepare("SELECT GROUP_CONCAT(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name").get() as {
        s: string;
      }
    ).s;

    await h.post('/api/admin/versions', { file: 'funnel.v3.json', activate: true });
    await h.post('/api/admin/activate', { version: 1 });

    const schemaAfter = (
      h.db.prepare("SELECT GROUP_CONCAT(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name").get() as {
        s: string;
      }
    ).s;

    expect(schemaAfter).toBe(schemaBefore);
  });

  it('невалидный конфиг не публикуется', async () => {
    const broken = loadConfig('funnel.v1.json');
    const roleStep = broken.steps.find((s) => s.id === 'role');
    if (roleStep) roleStep.next = [{ goto: 'step-which-does-not-exist' }];

    const res = await h.post<{ error: string; details: { issues: { message: string }[] } }>(
      '/api/admin/versions',
      { config: broken as FunnelConfig },
    );

    expect(res.status).toBe(422);
    expect(res.body.details.issues.some((i) => i.message.includes('step-which-does-not-exist'))).toBe(true);

    const overview = await h.get<Overview>('/api/admin/overview');
    expect(overview.body.versions).toHaveLength(1);
  });

  it('повторное включение уже активной версии отклоняется', async () => {
    const res = await h.post<{ error: string }>('/api/admin/activate', { version: 1 });
    expect(res.status).toBe(409);
  });
});
