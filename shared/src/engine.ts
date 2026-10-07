import { evaluateCondition } from './conditions.js';
import type {
  AnswerMap,
  AnswerValue,
  FunnelConfig,
  FunnelStep,
  MultiSelectStep,
  NumberStep,
  ProgressInfo,
  ResultOutcome,
  ResultStep,
  SingleSelectStep,
  Transition,
  TransitionRule,
  VariantId,
  VariantPatch,
} from './types.js';

export function getStep(config: FunnelConfig, stepId: string): FunnelStep | undefined {
  return config.steps.find((s) => s.id === stepId);
}

export function requireStep(config: FunnelConfig, stepId: string): FunnelStep {
  const step = getStep(config, stepId);
  if (!step) throw new Error(`Unknown step "${stepId}" in funnel "${config.funnelId}"`);
  return step;
}

function asRules(next: Transition | undefined): TransitionRule[] {
  if (!next) return [];
  return typeof next === 'string' ? [{ goto: next }] : next;
}

/**
 * Resolves the next step id for a step given the answers collected so far.
 * The first rule whose condition matches wins; a rule without `if` is the fallback.
 * Returns null for terminal steps.
 */
export function resolveNext(
  config: FunnelConfig,
  stepId: string,
  answers: AnswerMap,
): string | null {
  const step = getStep(config, stepId);
  if (!step) return null;
  for (const rule of asRules(step.next)) {
    if (evaluateCondition(rule.if, answers)) {
      return getStep(config, rule.goto) ? rule.goto : null;
    }
  }
  return null;
}

/**
 * Branch target used when the deciding answer is not available yet. Used only to
 * *project* the remaining path for the progress bar, never to actually navigate.
 */
function projectedNext(config: FunnelConfig, step: FunnelStep): string | null {
  const rules = asRules(step.next);
  if (rules.length === 0) return null;
  const fallback = rules.find((r) => !r.if) ?? rules[0];
  const target = fallback?.goto;
  return target && getStep(config, target) ? target : null;
}

/**
 * Walks the funnel from `start` to the end, honouring answers where they exist
 * and the fallback branch where they do not. The result is the set of steps the
 * user is actually expected to see — the progress denominator.
 */
export function projectPath(
  config: FunnelConfig,
  answers: AnswerMap,
  startAt = config.start,
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = startAt;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    const step = getStep(config, cursor);
    if (!step) break;
    // A step whose deciding field is unanswered cannot be resolved for real.
    const decided = resolveNext(config, cursor, answers);
    cursor = decided ?? projectedNext(config, step);
    if (cursor && seen.has(cursor)) break;
  }
  return path;
}

/**
 * Progress over *reachable* steps only. `history` is the path actually walked, so
 * a user who branched away from a long tail sees a shorter funnel, and going back
 * does not inflate the denominator.
 */
export function computeProgress(
  config: FunnelConfig,
  answers: AnswerMap,
  currentStep: string,
  history: string[] = [],
): ProgressInfo {
  const projected = projectPath(config, answers);

  // Merge the real history (authoritative for steps already seen) with the
  // projection from the current step onward.
  const forward = projectPath(config, answers, currentStep);
  const merged: string[] = [];
  for (const id of history) {
    if (id === currentStep) break;
    if (!merged.includes(id)) merged.push(id);
  }
  for (const id of forward) if (!merged.includes(id)) merged.push(id);
  for (const id of projected) if (!merged.includes(id)) merged.push(id);

  const counted = merged.filter((id) => {
    const step = getStep(config, id);
    return step && !step.skipProgress;
  });

  const total = Math.max(counted.length, 1);
  const rawIndex = counted.indexOf(currentStep);
  const index = rawIndex === -1 ? Math.min(counted.length, 1) : rawIndex + 1;
  const percent = Math.round((index / total) * 100);

  return { index, total, percent, path: counted };
}

/* -------------------------------------------------------------- validation */

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateAnswer(step: FunnelStep, value: AnswerValue): ValidationResult {
  switch (step.type) {
    case 'info':
    case 'result':
      return { ok: true };

    case 'single_select': {
      const s = step as SingleSelectStep;
      if (value === null || value === undefined || value === '') {
        return s.required === false ? { ok: true } : { ok: false, error: 'Выберите один из вариантов' };
      }
      if (typeof value !== 'string') return { ok: false, error: 'Ожидается один вариант' };
      if (!s.options.some((o) => o.value === value)) return { ok: false, error: 'Неизвестный вариант' };
      return { ok: true };
    }

    case 'multi_select': {
      const s = step as MultiSelectStep;
      if (!Array.isArray(value)) return { ok: false, error: 'Ожидается список вариантов' };
      const min = s.minSelected ?? 0;
      const max = s.maxSelected ?? s.options.length;
      if (value.length < min) {
        return { ok: false, error: `Выберите минимум ${min} ${plural(min, 'вариант', 'варианта', 'вариантов')}` };
      }
      if (value.length > max) {
        return { ok: false, error: `Можно выбрать не больше ${max} ${plural(max, 'варианта', 'вариантов', 'вариантов')}` };
      }
      const allowed = new Set(s.options.map((o) => o.value));
      if (value.some((v) => !allowed.has(v))) return { ok: false, error: 'Неизвестный вариант' };
      if (new Set(value).size !== value.length) return { ok: false, error: 'Дубли в выборе' };
      return { ok: true };
    }

    case 'number': {
      const s = step as NumberStep;
      if (value === null || value === undefined || value === '') {
        return s.required === false ? { ok: true } : { ok: false, error: 'Введите значение' };
      }
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) return { ok: false, error: 'Введите число' };
      // Целочисленность выводится из stepSize: шаг в целых числах означает, что
      // дробное значение бессмысленно для этого поля (половина склада, рубли с
      // копейками в смете внедрения). Само кратство шагу не требуем — это
      // подсказка для стрелок в поле ввода, а не ограничение на ответ.
      const stepSize = s.stepSize ?? 1;
      if (Number.isInteger(stepSize) && !Number.isInteger(num)) {
        return { ok: false, error: 'Введите целое число' };
      }
      if (s.min !== undefined && num < s.min) {
        return { ok: false, error: `Минимум ${formatNum(s.min)}${s.unit ? ' ' + s.unit : ''}` };
      }
      if (s.max !== undefined && num > s.max) {
        return { ok: false, error: `Максимум ${formatNum(s.max)}${s.unit ? ' ' + s.unit : ''}` };
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function formatNum(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n);
}

/** Field written by a step, if any. */
export function stepField(step: FunnelStep): string | null {
  return 'field' in step && typeof step.field === 'string' ? step.field : null;
}

/* ------------------------------------------------------------------ result */

export function resolveOutcome(step: ResultStep, answers: AnswerMap): ResultOutcome {
  for (const outcome of step.outcomes) {
    if (evaluateCondition(outcome.if, answers)) return outcome;
  }
  const last = step.outcomes[step.outcomes.length - 1];
  if (!last) throw new Error(`Result step "${step.id}" has no outcomes`);
  return last;
}

/* ----------------------------------------------------------- variant patch */

function rewireTransition(next: Transition | undefined, remap: Map<string, string | null>): Transition | undefined {
  if (!next) return next;
  const apply = (id: string): string | null => {
    let cursor: string | null = id;
    const guard = new Set<string>();
    while (cursor !== null && remap.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor);
      cursor = remap.get(cursor) ?? null;
    }
    return cursor;
  };

  if (typeof next === 'string') {
    const target = apply(next);
    return target ?? undefined;
  }

  const rules = next
    .map((rule) => {
      const target = apply(rule.goto);
      return target ? { ...rule, goto: target } : null;
    })
    .filter((r): r is TransitionRule => r !== null);

  return rules.length > 0 ? rules : undefined;
}

/**
 * Produces the config a specific variant should see. Variant resolution happens
 * on the server, so the client receives one already-flattened config and the
 * assignment cannot be tampered with from the browser.
 */
export function resolveVariantConfig(config: FunnelConfig, variant: VariantId): FunnelConfig {
  const patch: VariantPatch | undefined = config.variants?.[variant];
  if (!patch) return config;

  let steps: FunnelStep[] = config.steps.map((s) => ({ ...s }));
  let start = config.start;

  if (patch.overrides) {
    steps = steps.map((step) => {
      const override = patch.overrides?.[step.id];
      return override ? ({ ...step, ...override } as FunnelStep) : step;
    });
  }

  if (patch.removeSteps?.length) {
    const removed = new Set(patch.removeSteps.filter((id) => steps.some((s) => s.id === id)));

    // Each removed step forwards its inbound edges to its own fallback target.
    const remap = new Map<string, string | null>();
    for (const id of removed) {
      const step = steps.find((s) => s.id === id);
      const rules = step ? (typeof step.next === 'string' ? [{ goto: step.next }] : step.next ?? []) : [];
      const fallback = rules.find((r) => !r.if) ?? rules[0];
      remap.set(id, fallback?.goto ?? null);
    }

    steps = steps
      .filter((s) => !removed.has(s.id))
      .map((s) => {
        const next = rewireTransition(s.next, remap);
        return next === undefined ? ({ ...s, next: undefined } as FunnelStep) : ({ ...s, next } as FunnelStep);
      });

    if (removed.has(start)) {
      let cursor: string | null = start;
      const guard = new Set<string>();
      while (cursor && removed.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        cursor = remap.get(cursor) ?? null;
      }
      start = cursor ?? steps[0]?.id ?? start;
    }
  }

  if (patch.stepOrder?.length) {
    const order = new Map(patch.stepOrder.map((id, i) => [id, i]));
    steps = [...steps].sort((a, b) => {
      const ai = order.get(a.id);
      const bi = order.get(b.id);
      if (ai === undefined && bi === undefined) return 0;
      if (ai === undefined) return 1;
      if (bi === undefined) return -1;
      return ai - bi;
    });
  }

  return { ...config, start, steps, variants: undefined };
}
