const nf = new Intl.NumberFormat('ru-RU');

export const fmtInt = (n: number): string => nf.format(Math.round(n));

export const fmtPercent = (ratio: number, digits = 1): string =>
  `${(ratio * 100).toFixed(digits)}%`;

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} с`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} мин ${s} с`;
}

/** Signed delta in percentage points, for A/B and version comparisons. */
export function fmtDeltaPp(a: number, b: number): { text: string; tone: 'up' | 'down' | 'flat' } {
  const pp = (a - b) * 100;
  if (Math.abs(pp) < 0.05) return { text: '±0 п.п.', tone: 'flat' };
  return { text: `${pp > 0 ? '+' : '−'}${Math.abs(pp).toFixed(1)} п.п.`, tone: pp > 0 ? 'up' : 'down' };
}
