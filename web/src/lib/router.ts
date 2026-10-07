import { useEffect, useState } from 'react';

/**
 * Hash routing. Chosen deliberately: the funnel itself owns the browser's
 * *path* history (one entry per step, so the Back button walks the funnel), and
 * mixing a path-based router into that would fight for the same history stack.
 */
export type Route = { name: 'funnel' } | { name: 'admin' } | { name: 'analytics' };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (clean === 'admin') return { name: 'admin' };
  if (clean === 'admin/analytics' || clean === 'analytics') return { name: 'analytics' };
  return { name: 'funnel' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to;
}
