import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import type { AdminOverview, VersionDetail } from '../lib/adminTypes.js';
import { fmtDateTime, fmtInt } from '../lib/format.js';
import { IssueList } from '../components/IssueList.js';
import { AdminTokenField } from '../components/AdminTokenField.js';
import { DemoNotice } from '../components/DemoNotice.js';

type Busy = null | { kind: 'publish' | 'activate'; key: string };

export function AdminPage(): JSX.Element {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [detailVariant, setDetailVariant] = useState<string>('A');

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api.adminOverview());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (job: Busy, fn: () => Promise<string>): Promise<void> => {
    setBusy(job);
    setError(null);
    setFlash(null);
    try {
      setFlash(await fn());
      await load();
    } catch (err) {
      const detailIssues =
        err instanceof ApiError && err.details && typeof err.details === 'object'
          ? JSON.stringify((err.details as { issues?: unknown }).issues ?? err.details)
          : '';
      setError(`${err instanceof Error ? err.message : String(err)}${detailIssues ? ` — ${detailIssues}` : ''}`);
    } finally {
      setBusy(null);
    }
  };

  const openDetail = async (version: number): Promise<void> => {
    try {
      const d = await api.versionDetail(version);
      setDetail(d);
      setDetailVariant(Object.keys(d.resolved)[0] ?? 'A');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error && !data) {
    return (
      <AdminShell>
        <div className="notice notice--error">{error}</div>
        <AdminTokenField onSaved={load} />
      </AdminShell>
    );
  }

  if (!data) {
    return (
      <AdminShell>
        <div className="spinner" />
      </AdminShell>
    );
  }

  const active = data.versions.find((v) => v.is_active) ?? null;
  const rollbackTarget = data.versions.find((v) => !v.is_active && v.version < (active?.version ?? 0));

  return (
    <AdminShell>
      <DemoNotice show={Boolean(data.demo_mode)} />
      {flash && <div className="notice notice--ok">{flash}</div>}
      {error && <div className="notice notice--error">{error}</div>}

      <section className="panel">
        <header className="panel__head">
          <h2 className="h2">Активная версия</h2>
          <span className="muted small">Воронка {data.funnel_id}</span>
        </header>
        {active ? (
          <div className="active-card">
            <div className="active-card__num">v{active.version}</div>
            <div className="active-card__body">
              <div className="active-card__name">{active.name}</div>
              <div className="muted small">
                опубликована {fmtDateTime(active.created_at)} · шагов {active.step_count} · сессий{' '}
                {fmtInt(active.session_count)} · событий {fmtInt(active.event_count)}
              </div>
            </div>
            <div className="active-card__actions">
              <a className="btn btn--ghost" href="#/" onClick={() => window.setTimeout(() => window.location.reload(), 0)}>
                Открыть воронку
              </a>
              {rollbackTarget && (
                <button
                  className="btn btn--warn"
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    act({ kind: 'activate', key: String(rollbackTarget.version) }, async () => {
                      const r = await api.activate({
                        version: rollbackTarget.version,
                        note: 'Откат с панели управления',
                      });
                      return `Откат выполнен: активна v${r.version} (была v${r.previous})`;
                    })
                  }
                >
                  Откатить на v{rollbackTarget.version}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="muted">Активной версии нет — опубликуйте конфиг ниже.</p>
        )}
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2 className="h2">Конфиги в репозитории</h2>
          <span className="muted small">папка configs/ — публикация без передеплоя</span>
        </header>
        <div className="library">
          {data.library.map((entry) => {
            const hasErrors = entry.issues.some((i) => i.level === 'error');
            return (
              <article className={`lib ${hasErrors ? 'lib--bad' : ''}`} key={entry.file}>
                <div className="lib__head">
                  <code className="lib__file">{entry.file}</code>
                  <span className="muted small">{entry.stepCount} шагов</span>
                </div>
                <div className="lib__name">{entry.name}</div>
                {entry.experiment && (
                  <div className="muted small lib__exp">
                    эксперимент <code>{entry.experiment.key}</code> · метрика{' '}
                    <b>{entry.experiment.primaryMetric}</b>
                  </div>
                )}
                <IssueList issues={entry.issues} />
                <div className="lib__actions">
                  <button
                    className="btn btn--primary btn--sm"
                    type="button"
                    disabled={hasErrors || busy !== null}
                    onClick={() =>
                      act({ kind: 'publish', key: entry.file }, async () => {
                        const r = await api.publish({
                          file: entry.file,
                          notes: `Опубликовано с панели из ${entry.file}`,
                          activate: true,
                        });
                        return `Опубликована v${r.version} и сразу включена`;
                      })
                    }
                  >
                    Опубликовать и включить
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    type="button"
                    disabled={hasErrors || busy !== null}
                    onClick={() =>
                      act({ kind: 'publish', key: `${entry.file}:draft` }, async () => {
                        const r = await api.publish({
                          file: entry.file,
                          notes: `Опубликовано без включения из ${entry.file}`,
                          activate: false,
                        });
                        return `Опубликована v${r.version}, активная версия не изменилась`;
                      })
                    }
                  >
                    Только опубликовать
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2 className="h2">Версии</h2>
          <span className="muted small">откат — это включение более ранней версии</span>
        </header>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Версия</th>
                <th>Название</th>
                <th className="num">Шагов</th>
                <th className="num">Сессий</th>
                <th className="num">Событий</th>
                <th>Создана</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.versions.map((v) => (
                <tr key={v.version} className={v.is_active ? 'row--active' : ''}>
                  <td>
                    <b>v{v.version}</b> {v.is_active && <span className="pill pill--ok">активна</span>}
                  </td>
                  <td>
                    <div>{v.name}</div>
                    {v.source_file && <code className="muted small">{v.source_file}</code>}
                  </td>
                  <td className="num">{v.step_count}</td>
                  <td className="num">{fmtInt(v.session_count)}</td>
                  <td className="num">{fmtInt(v.event_count)}</td>
                  <td className="muted small">{fmtDateTime(v.created_at)}</td>
                  <td className="row-actions">
                    <button className="btn btn--ghost btn--sm" type="button" onClick={() => void openDetail(v.version)}>
                      Конфиг
                    </button>
                    {!v.is_active && (
                      <button
                        className="btn btn--sm"
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          act({ kind: 'activate', key: String(v.version) }, async () => {
                            const r = await api.activate({ version: v.version, note: 'Переключение с панели' });
                            return r.action === 'rollback'
                              ? `Откат на v${r.version} (была v${r.previous})`
                              : `Включена v${r.version} (была v${r.previous ?? '—'})`;
                          })
                        }
                      >
                        Включить
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail && (
        <section className="panel">
          <header className="panel__head">
            <h2 className="h2">
              Конфиг v{detail.version} <span className="muted small">{detail.config_hash}</span>
            </h2>
            <div className="seg">
              {Object.keys(detail.resolved).map((variant) => (
                <button
                  key={variant}
                  type="button"
                  className={`seg__item ${detailVariant === variant ? 'seg__item--on' : ''}`}
                  onClick={() => setDetailVariant(variant)}
                >
                  Вариант {variant}
                </button>
              ))}
              <button type="button" className="seg__item" onClick={() => setDetail(null)}>
                Закрыть
              </button>
            </div>
          </header>
          <IssueList issues={detail.issues} />
          <StepGraph config={detail.resolved[detailVariant] ?? detail.config} />
          <details className="raw">
            <summary>Исходный JSON (как опубликован, до применения варианта)</summary>
            <pre className="pre">{JSON.stringify(detail.config, null, 2)}</pre>
          </details>
        </section>
      )}

      <section className="panel">
        <header className="panel__head">
          <h2 className="h2">История публикаций и откатов</h2>
        </header>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Действие</th>
                <th>Переход</th>
                <th>Кто</th>
                <th>Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {data.audit.map((a) => (
                <tr key={a.id}>
                  <td className="muted small">{fmtDateTime(a.at)}</td>
                  <td>
                    <span className={`pill pill--${a.action === 'rollback' ? 'warn' : 'neutral'}`}>
                      {a.action === 'rollback' ? 'откат' : a.action === 'publish' ? 'публикация' : 'включение'}
                    </span>
                  </td>
                  <td className="mono">
                    {a.from_version ?? '—'} → {a.to_version}
                  </td>
                  <td className="muted small">{a.actor}</td>
                  <td className="muted small">{a.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2 className="h2">Последние сессии</h2>
          <span className="muted small">сырые ответы здесь не показываются и в аналитику не попадают</span>
        </header>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Сессия</th>
                <th className="num">Версия</th>
                <th>Вариант</th>
                <th>Текущий шаг</th>
                <th>Кампания</th>
                <th className="num">Событий</th>
                <th>Начата</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_sessions.map((s) => (
                <tr key={s.session_id}>
                  <td className="mono small">{s.session_id.slice(0, 8)}…</td>
                  <td className="num">
                    v{s.funnel_version}
                    {data.active_version !== s.funnel_version && (
                      <span className="pill pill--warn" title="Сессия продолжается на старой версии">
                        закреплена
                      </span>
                    )}
                  </td>
                  <td>
                    {s.variant}
                    {s.variant_source === 'override' && <span className="muted small"> (override)</span>}
                  </td>
                  <td className="mono small">{s.current_step}</td>
                  <td className="muted small">{s.utm_campaign ?? '—'}</td>
                  <td className="num">{s.event_count}</td>
                  <td className="muted small">{fmtDateTime(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.rejects.length > 0 && (
        <section className="panel">
          <header className="panel__head">
            <h2 className="h2">Отклонённые события</h2>
            <span className="muted small">
              не попали в аналитику, но сохранены — батч, в котором они пришли, обработан целиком
            </span>
          </header>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Причина</th>
                  <th>event_id</th>
                  <th>Тип</th>
                </tr>
              </thead>
              <tbody>
                {data.rejects.map((r) => (
                  <tr key={r.id}>
                    <td className="muted small">{fmtDateTime(r.received_at)}</td>
                    <td>{r.reason}</td>
                    <td className="mono small">{r.event_id ?? '—'}</td>
                    <td className="mono small">{r.event_type ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <AdminTokenField onSaved={load} />
    </AdminShell>
  );
}

function AdminShell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <main className="admin">
      <nav className="admin__nav">
        <a className="admin__brand" href="#/">
          Funnel Runtime
        </a>
        <div className="admin__links">
          <a href="#/">Воронка</a>
          <a className="is-current" href="#/admin">
            Версии
          </a>
          <a href="#/admin/analytics">Аналитика</a>
        </div>
      </nav>
      <div className="admin__body">{children}</div>
    </main>
  );
}

/** Compact graph of the resolved funnel: shows exactly where the branches are. */
function StepGraph({ config }: { config: { start: string; steps: unknown[] } }): JSX.Element {
  const steps = config.steps as {
    id: string;
    type: string;
    title: string;
    next?: string | { goto: string; label?: string; if?: unknown }[];
  }[];

  return (
    <ol className="graph">
      {steps.map((step) => {
        const rules = !step.next ? [] : typeof step.next === 'string' ? [{ goto: step.next }] : step.next;
        return (
          <li className="graph__item" key={step.id}>
            <div className="graph__head">
              <code className="graph__id">{step.id}</code>
              <span className="pill pill--neutral">{step.type}</span>
              {step.id === config.start && <span className="pill pill--ok">start</span>}
            </div>
            <div className="graph__title">{step.title}</div>
            {rules.length > 0 && (
              <ul className="graph__edges">
                {rules.map((rule, i) => (
                  <li key={`${rule.goto}-${i}`}>
                    <span className="graph__arrow">→</span>
                    <code>{rule.goto}</code>
                    {'if' in rule && rule.if ? (
                      <span className="graph__cond">{(rule as { label?: string }).label ?? 'по условию'}</span>
                    ) : (
                      rules.length > 1 && <span className="graph__cond graph__cond--else">иначе</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
