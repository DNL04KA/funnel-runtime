import type { ExperimentSpec, VariantId } from './types.js';

/**
 * FNV-1a, 32-bit. Deterministic across processes and restarts, which is what
 * makes bucketing reproducible: the same (session, experiment) pair always lands
 * in the same variant, with no lookup table required.
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable bucket in [0, 1). */
export function bucket(sessionId: string, experimentKey: string): number {
  return hash32(`${experimentKey}:${sessionId}`) / 0x100000000;
}

/**
 * Assigns a variant from the session id alone. Called once at session creation
 * and then persisted, so the stored value — not a recomputation — is the source
 * of truth for the rest of the session's life.
 */
export function assignVariant(sessionId: string, experiment: ExperimentSpec): VariantId {
  const variants = experiment.variants.length ? experiment.variants : (['A', 'B'] as VariantId[]);
  const b = bucket(sessionId, experiment.key);

  const split = experiment.split;
  if (split) {
    let acc = 0;
    for (const v of variants) {
      acc += split[v] ?? 0;
      if (b < acc) return v;
    }
    return variants[variants.length - 1] as VariantId;
  }

  const idx = Math.floor(b * variants.length);
  return (variants[Math.min(idx, variants.length - 1)] ?? 'A') as VariantId;
}

export function isVariantId(value: unknown): value is VariantId {
  return value === 'A' || value === 'B';
}

/** Normalises a `?variant=` override. Returns null when the value is unusable. */
export function parseVariantOverride(raw: unknown, experiment: ExperimentSpec): VariantId | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (!isVariantId(upper)) return null;
  return experiment.variants.includes(upper) ? upper : null;
}
