import type { AnswerValue, FunnelStep, NumberStep } from './types.js';

export interface SanitizedAnswer {
  field: string;
  kind: FunnelStep['type'];
  /** Enumerated option value(s) — safe, they come from the config, not the user. */
  option_values?: string[];
  /** Number of options chosen, for multi-select. */
  selected_count?: number;
  /** Bucket label instead of the exact figure. */
  bucket?: string;
  answered: boolean;
}

function formatBucketEdge(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

/** Maps a number onto a config-declared bucket, e.g. `2.5M-5M`. */
export function bucketNumber(step: NumberStep, value: number): string {
  const edges = step.buckets ?? [];
  if (edges.length === 0) return 'unbucketed';
  if (value < (edges[0] as number)) return `<${formatBucketEdge(edges[0] as number)}`;
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    if (value >= lo && value < hi) return `${formatBucketEdge(lo)}-${formatBucketEdge(hi)}`;
  }
  return `${formatBucketEdge(edges[edges.length - 1] as number)}+`;
}

/**
 * Converts a raw answer into the minimum shape analytics actually needs.
 *
 * Free-form numeric input (budget, headcount, …) is the only genuinely sensitive
 * value a user types here, so it is reduced to a bucket label before it ever
 * reaches the event store. Raw values stay in the operational session record,
 * which the dashboard never reads.
 */
export function sanitizeAnswer(step: FunnelStep, value: AnswerValue): SanitizedAnswer {
  const field = 'field' in step ? ((step as { field?: string }).field ?? step.id) : step.id;
  const answered = value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);

  switch (step.type) {
    case 'single_select':
      return {
        field,
        kind: step.type,
        answered,
        option_values: typeof value === 'string' && value ? [value] : [],
      };
    case 'multi_select': {
      const list = Array.isArray(value) ? value.map(String) : [];
      return {
        field,
        kind: step.type,
        answered,
        option_values: [...list].sort(),
        selected_count: list.length,
      };
    }
    case 'number': {
      const num = typeof value === 'number' ? value : Number(value);
      return {
        field,
        kind: step.type,
        answered,
        bucket: Number.isFinite(num) ? bucketNumber(step as NumberStep, num) : 'invalid',
      };
    }
    default:
      return { field, kind: step.type, answered };
  }
}
