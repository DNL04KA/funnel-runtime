import type { AnswerMap, AnswerValue, Condition, LeafCondition } from './types.js';

function isLeaf(c: Condition): c is LeafCondition {
  return typeof (c as LeafCondition).field === 'string';
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asList(v: LeafCondition['value']): Array<string | number> {
  if (Array.isArray(v)) return v;
  return v === undefined ? [] : [v];
}

function isEmpty(v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function evalLeaf(cond: LeafCondition, answers: AnswerMap): boolean {
  const actual = answers[cond.field];

  switch (cond.op) {
    case 'answered':
      return !isEmpty(actual);
    case 'empty':
      return isEmpty(actual);
    case 'eq':
      return Array.isArray(actual)
        ? actual.length === 1 && String(actual[0]) === String(cond.value)
        : String(actual ?? '') === String(cond.value);
    case 'neq':
      return !evalLeaf({ ...cond, op: 'eq' }, answers);
    case 'in':
      return asList(cond.value).some((x) => String(x) === String(actual ?? ''));
    case 'nin':
      return !asList(cond.value).some((x) => String(x) === String(actual ?? ''));
    case 'includes': {
      const list = Array.isArray(actual) ? actual.map(String) : [String(actual ?? '')];
      // `includes` with a list means "contains at least one of".
      return asList(cond.value).some((x) => list.includes(String(x)));
    }
    case 'excludes':
      return !evalLeaf({ ...cond, op: 'includes' }, answers);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(cond.value);
      if (a === null || b === null) return false;
      if (cond.op === 'gt') return a > b;
      if (cond.op === 'gte') return a >= b;
      if (cond.op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

/** Evaluates a (possibly nested) condition against the answers collected so far. */
export function evaluateCondition(cond: Condition | undefined, answers: AnswerMap): boolean {
  if (!cond) return true;
  if (isLeaf(cond)) return evalLeaf(cond, answers);
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, answers));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, answers));
  if ('not' in cond) return !evaluateCondition(cond.not, answers);
  return false;
}

/** Collects every field id a condition reads. Used by config validation. */
export function conditionFields(cond: Condition | undefined, out = new Set<string>()): Set<string> {
  if (!cond) return out;
  if (isLeaf(cond)) {
    out.add(cond.field);
    return out;
  }
  if ('all' in cond) cond.all.forEach((c) => conditionFields(c, out));
  else if ('any' in cond) cond.any.forEach((c) => conditionFields(c, out));
  else if ('not' in cond) conditionFields(cond.not, out);
  return out;
}
