import { conditionFields } from './conditions.js';
import { getStep } from './engine.js';
import type { Condition, FunnelConfig, FunnelStep, Transition, VariantId } from './types.js';
import { KNOWN_EVENT_TYPES } from './types.js';

export interface ConfigIssue {
  level: 'error' | 'warning';
  message: string;
  stepId?: string;
}

function transitionTargets(next: Transition | undefined): { goto: string; cond?: Condition }[] {
  if (!next) return [];
  if (typeof next === 'string') return [{ goto: next }];
  return next.map((r) => ({ goto: r.goto, cond: r.if }));
}

/**
 * Structural validation of a config before it can be published. Catches the
 * mistakes that would otherwise strand a live session: unknown step ids, missing
 * fallback branches, conditions on fields nobody collects, unreachable steps.
 */
export function validateConfig(config: FunnelConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (level: ConfigIssue['level'], message: string, stepId?: string) =>
    issues.push(stepId ? { level, message, stepId } : { level, message });

  if (!config.funnelId) push('error', 'funnelId обязателен');
  if (!config.name) push('error', 'name обязателен');
  if (!Array.isArray(config.steps) || config.steps.length === 0) {
    push('error', 'steps не может быть пустым');
    return issues;
  }

  const ids = config.steps.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) push('error', `Повторяющиеся step id: ${[...new Set(dupes)].join(', ')}`);

  if (!getStep(config, config.start)) push('error', `start "${config.start}" не найден среди шагов`);

  if (config.steps.length < 6) {
    push('warning', `В конфиге ${config.steps.length} экранов, по условиям задания нужно минимум 6`);
  }

  // Fields written by steps, in declaration order, so we can detect conditions
  // that read a field nobody has answered yet.
  const writers = new Map<string, number>();
  config.steps.forEach((step, i) => {
    const field = 'field' in step ? (step as { field?: string }).field : undefined;
    if (field && !writers.has(field)) writers.set(field, i);
  });

  let branchCount = 0;

  config.steps.forEach((step) => {
    validateStepShape(step, push);

    const targets = transitionTargets(step.next);
    if (targets.length > 1) branchCount += 1;

    for (const t of targets) {
      if (!getStep(config, t.goto)) push('error', `next → неизвестный шаг "${t.goto}"`, step.id);
      for (const field of conditionFields(t.cond)) {
        if (!writers.has(field)) {
          push('error', `условие читает поле "${field}", которое не собирает ни один шаг`, step.id);
        }
      }
    }

    if (targets.length > 1 && targets.every((t) => t.cond !== undefined)) {
      push('warning', 'у ветвления нет безусловной ветки — сессия может застрять', step.id);
    }

    if (step.type !== 'result' && targets.length === 0) {
      push('error', 'не result-шаг без next — сессия не сможет продолжить', step.id);
    }

    if (step.type === 'result') {
      if (!step.outcomes?.length) push('error', 'result без outcomes', step.id);
      else if (step.outcomes[step.outcomes.length - 1]?.if) {
        push('warning', 'последний outcome условный — может не найтись подходящего', step.id);
      }
      for (const outcome of step.outcomes ?? []) {
        for (const field of conditionFields(outcome.if)) {
          if (!writers.has(field)) {
            push('error', `outcome "${outcome.id}" читает неизвестное поле "${field}"`, step.id);
          }
        }
      }
    }
  });

  if (branchCount === 0) push('warning', 'в конфиге нет ни одного ветвления, по условиям задания нужно минимум одно');

  // Reachability from start, ignoring conditions (optimistic traversal).
  const reachable = new Set<string>();
  const queue = [config.start];
  while (queue.length) {
    const id = queue.shift()!;
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    const step = getStep(config, id);
    if (step) for (const t of transitionTargets(step.next)) queue.push(t.goto);
  }
  for (const step of config.steps) {
    if (!reachable.has(step.id)) push('warning', 'шаг недостижим из start', step.id);
  }
  if (!config.steps.some((s) => s.type === 'result' && reachable.has(s.id))) {
    push('error', 'из start недостижим ни один result-шаг');
  }

  // Experiment + variants.
  if (!config.experiment?.key) push('error', 'experiment.key обязателен');
  if (!config.experiment?.variants?.length) push('error', 'experiment.variants обязателен');
  if (!config.experiment?.hypothesis) push('warning', 'не описана гипотеза эксперимента');
  if (config.experiment?.split) {
    const sum = Object.values(config.experiment.split).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) push('error', `experiment.split в сумме даёт ${sum}, ожидается 1`);
  }

  for (const [variant, patch] of Object.entries(config.variants ?? {})) {
    if (!config.experiment?.variants?.includes(variant as VariantId)) {
      push('error', `вариант "${variant}" описан в variants, но отсутствует в experiment.variants`);
    }
    for (const id of patch?.removeSteps ?? []) {
      if (!getStep(config, id)) push('warning', `variant ${variant}: removeSteps ссылается на неизвестный шаг "${id}"`);
    }
    for (const id of Object.keys(patch?.overrides ?? {})) {
      if (!getStep(config, id)) push('warning', `variant ${variant}: overrides ссылается на неизвестный шаг "${id}"`);
    }
  }

  for (const type of config.emits ?? []) {
    if (!KNOWN_EVENT_TYPES.includes(type)) {
      push('warning', `конфиг объявляет событие "${type}", неизвестное бэкенду`);
    }
  }

  return issues;
}

function validateStepShape(step: FunnelStep, push: (l: ConfigIssue['level'], m: string, s?: string) => void): void {
  if (!step.id) push('error', 'у шага нет id');
  if (!step.title) push('warning', 'у шага нет title', step.id);

  switch (step.type) {
    case 'info':
      if (!step.ctaLabel) push('error', 'info-шаг без ctaLabel', step.id);
      break;
    case 'single_select':
    case 'multi_select': {
      if (!step.field) push('error', `${step.type} без field`, step.id);
      if (!step.options?.length) push('error', `${step.type} без options`, step.id);
      const values = (step.options ?? []).map((o) => o.value);
      if (new Set(values).size !== values.length) push('error', 'повторяющиеся option.value', step.id);
      if (step.type === 'multi_select') {
        const min = step.minSelected ?? 0;
        const max = step.maxSelected ?? step.options.length;
        if (min > max) push('error', `minSelected (${min}) больше maxSelected (${max})`, step.id);
        if (max > (step.options?.length ?? 0)) push('warning', 'maxSelected больше числа опций', step.id);
      }
      break;
    }
    case 'number':
      if (!step.field) push('error', 'number без field', step.id);
      if (step.min !== undefined && step.max !== undefined && step.min > step.max) {
        push('error', `min (${step.min}) больше max (${step.max})`, step.id);
      }
      if (step.buckets && step.buckets.some((b, i, arr) => i > 0 && b <= (arr[i - 1] ?? -Infinity))) {
        push('error', 'buckets должны идти по возрастанию', step.id);
      }
      break;
    case 'result':
      if (!step.ctaLabel) push('error', 'result без ctaLabel', step.id);
      if (!step.ctaHref) push('warning', 'result без ctaHref', step.id);
      break;
    default: {
      const unknownStep = step as FunnelStep;
      push('error', `неизвестный type "${unknownStep.type}"`, unknownStep.id);
    }
  }
}

export function configErrors(config: FunnelConfig): ConfigIssue[] {
  return validateConfig(config).filter((i) => i.level === 'error');
}
