import { useEffect, useState } from 'react';
import type { SessionBootstrap } from '@funnel/shared';
import { eventQueue, type QueueStats } from '../lib/eventQueue.js';

/**
 * Debug strip. Visible on purpose: version pinning, variant assignment and the
 * event queue are the things a reviewer needs to be able to watch directly.
 */
export function SessionBadge({ boot }: { boot: SessionBootstrap }): JSX.Element {
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => eventQueue.subscribe(setStats), []);

  const { session } = boot;

  return (
    <div className={`badge ${open ? 'badge--open' : ''}`}>
      <button className="badge__toggle" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="badge__dot" />
        v{session.funnel_version} · вариант {session.variant}
        {session.variant_source === 'override' && ' (override)'}
        {stats && stats.pending > 0 && <span className="badge__pending">{stats.pending} в очереди</span>}
      </button>

      {open && (
        <dl className="badge__grid">
          <div>
            <dt>session_id</dt>
            <dd className="mono">{session.session_id}</dd>
          </div>
          <div>
            <dt>версия воронки</dt>
            <dd>
              {session.funnel_version}
              {boot.version_is_stale && ` (активна ${boot.active_version})`}
            </dd>
          </div>
          <div>
            <dt>вариант</dt>
            <dd>
              {session.variant} · {session.variant_source === 'override' ? 'override из ?variant=' : 'назначен сервером'}
            </dd>
          </div>
          <div>
            <dt>шаг</dt>
            <dd className="mono">{session.current_step}</dd>
          </div>
          <div>
            <dt>utm_campaign</dt>
            <dd>{session.utm.utm_campaign ?? '—'}</dd>
          </div>
          {stats && (
            <div>
              <dt>события</dt>
              <dd>
                отправлено {stats.sent} · принято {stats.accepted} · дублей {stats.duplicates} · отклонено{' '}
                {stats.rejected} · в очереди {stats.pending}
                {stats.lastError && <span className="warn"> · ошибка: {stats.lastError}</span>}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
