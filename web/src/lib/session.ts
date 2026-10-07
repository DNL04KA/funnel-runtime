import type { UtmParams } from '@funnel/shared';

const SESSION_KEY = 'funnel.session_id.v1';

export function readStoredSessionId(): string | null {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function storeSessionId(id: string): void {
  try {
    window.localStorage.setItem(SESSION_KEY, id);
  } catch {
    /* private mode: the session simply will not survive a reload */
  }
}

export function clearStoredSessionId(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export interface LaunchParams extends UtmParams {
  /** `?variant=B` — the documented override for manual QA. */
  variant: string | null;
  /** `?reset=1` starts a brand-new session on the active version. */
  reset: boolean;
}

export function readLaunchParams(): LaunchParams {
  const params = new URLSearchParams(window.location.search);
  const out: LaunchParams = { variant: params.get('variant'), reset: params.get('reset') === '1' };
  for (const key of UTM_KEYS) out[key] = params.get(key);
  return out;
}

/** Drops `reset` from the address bar so a refresh does not start over again. */
export function stripResetParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('reset')) return;
  url.searchParams.delete('reset');
  window.history.replaceState(window.history.state, '', url.toString());
}
