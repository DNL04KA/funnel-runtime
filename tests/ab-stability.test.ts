import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionBootstrap } from '@funnel/shared';
import { assignVariant } from '@funnel/shared';
import { answer, createSession, loadConfig, startHarness, type Harness } from './helpers.js';

describe('стабильность A/B-варианта', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ configs: ['funnel.v1.json'] });
  });
  afterEach(async () => {
    await h.close();
  });

  it('вариант назначается на бэкенде и не меняется при повторных запросах', async () => {
    const boot = await createSession(h);
    const assigned = boot.session.variant;
    expect(['A', 'B']).toContain(assigned);
    expect(boot.session.variant_source).toBe('assigned');

    // Ten reloads — the equivalent of F5 — must all report the same variant.
    for (let i = 0; i < 10; i += 1) {
      const again = await h.get<SessionBootstrap>(`/api/session/${boot.session.session_id}`);
      expect(again.body.session.variant).toBe(assigned);
    }
  });

  it('вариант не меняется по ходу прохождения воронки', async () => {
    const boot = await createSession(h);
    const assigned = boot.session.variant;

    const afterIntro = await answer(h, boot.session.session_id, 'intro', null);
    expect(afterIntro.session.variant).toBe(assigned);

    const afterRole = await answer(h, boot.session.session_id, 'role', 'ops');
    expect(afterRole.session.variant).toBe(assigned);
  });

  it('назначение детерминировано: тот же session_id даёт тот же вариант', () => {
    const config = loadConfig('funnel.v1.json');
    const ids = Array.from({ length: 50 }, (_, i) => `session-fixture-${i}`);
    const first = ids.map((id) => assignVariant(id, config.experiment));
    const second = ids.map((id) => assignVariant(id, config.experiment));
    expect(second).toEqual(first);
  });

  it('распределение близко к заявленному сплиту 50/50', async () => {
    const config = loadConfig('funnel.v1.json');
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 4000; i += 1) {
      counts[assignVariant(`bucket-test-${i}`, config.experiment)] += 1;
    }
    const shareA = counts.A / 4000;
    expect(shareA).toBeGreaterThan(0.45);
    expect(shareA).toBeLessThan(0.55);
  });

  it('override через query-параметр фиксируется за сессией', async () => {
    const forcedB = await createSession(h, { variant: 'B' });
    expect(forcedB.session.variant).toBe('B');
    expect(forcedB.session.variant_source).toBe('override');

    const reloaded = await h.get<SessionBootstrap>(`/api/session/${forcedB.session.session_id}`);
    expect(reloaded.body.session.variant).toBe('B');
    expect(reloaded.body.session.variant_source).toBe('override');
  });

  it('некорректный override игнорируется и вариант назначается обычным способом', async () => {
    const boot = await createSession(h, { variant: 'Z' });
    expect(['A', 'B']).toContain(boot.session.variant);
    expect(boot.session.variant_source).toBe('assigned');
  });

  it('все события сессии несут её вариант', async () => {
    const boot = await createSession(h, { variant: 'B' });
    await answer(h, boot.session.session_id, 'intro', null);
    await answer(h, boot.session.session_id, 'role', 'it');

    const variants = h.db
      .prepare('SELECT DISTINCT variant AS v FROM events WHERE session_id = ?')
      .all(boot.session.session_id) as { v: string }[];

    expect(variants).toEqual([{ v: 'B' }]);
  });

  it('вариант B получает свой конфиг: изменённые тексты результата', async () => {
    const a = await createSession(h, { variant: 'A' });
    const b = await createSession(h, { variant: 'B' });

    const resultOf = (boot: SessionBootstrap): { ctaLabel?: string } =>
      boot.config.steps.find((s) => s.type === 'result') as { ctaLabel?: string };

    expect(resultOf(a).ctaLabel).toBe('Получить расчёт стоимости');
    expect(resultOf(b).ctaLabel).toBe('Записаться на демо');
  });
});
