import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { AnalyticsResponseShape, SegmentShape, StepMetricShape, TotalsShape } from '../lib/adminTypes.js';
import { fmtDateTime, fmtDeltaPp, fmtDuration, fmtInt, fmtPercent } from '../lib/format.js';

interface Filters {
  version: string;
  variant: string;
  campaign: string;
}

export function AnalyticsPage(): JSX.Element {
  const [filters, setFilters] = useState<Filters>({ version: 'all', variant: 'all', campaign: 'all' });
  const [data, setData] = useState<AnalyticsResponseShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (f: Filters): Promise<void> => {
    setLoading(true);
    try {
      setData(await api.analytics({ version: f.version, variant: f.variant, campaign: f.campaign }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  const patch = (next: Partial<Filters>): void => setFilters((f) => ({ ...f, ...next }));

  return (
    <main className="admin">
      <nav className="admin__nav">
        <a className="admin__brand" href="#/">
          Funnel Runtime
        </a>
        <div className="admin__links">
          <a href="#/">Воронка</a>
          <a href="#/admin">Версии</a>
          <a className="is-current" href="#/admin/analytics">
            Аналитика
          </a>
        </div>
      </nav>

      <div className="admin__body">
        {error && <div className="notice notice--error">{error}</div>}

        {data && (
          <>
            <section className="panel">
              <header className="panel__head">
                <h2 className="h2">Фильтры</h2>
                <span className="muted small">
                  все показатели считаются по уникальным сессиям · обновлено {fmtDateTime(data.generated_at)}
                </span>
              </header>
              <div className="filters">
                <label className="filter">
                  <span>Версия</span>
                  <select value={filters.version} onChange={(e) => patch({ version: e.target.value })}>
                    <option value="all">Все версии</option>
                    {data.available.versions.map((v) => (
                      <option key={v.version} value={String(v.version)}>
                        v{v.version}
                        {v.is_active ? ' (активна)' : ''} — {fmtInt(v.sessions)} сессий
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter">
                  <span>Вариант</span>
                  <select value={filters.variant} onChange={(e) => patch({ variant: e.target.value })}>
                    <option value="all">A и B</option>
                    {data.available.variants.map((v) => (
                      <option key={v} value={v}>
                        Вариант {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter">
                  <span>UTM campaign</span>
                  <select value={filters.campaign} onChange={(e) => patch({ campaign: e.target.value })}>
                    <option value="all">Все кампании</option>
                    {data.available.campaigns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn btn--ghost btn--sm" type="button" onClick={() => void load(filters)}>
                  Обновить
                </button>
                {loading && <span className="muted small">загрузка…</span>}
              </div>
            </section>

            <KpiRow totals={data.overall} />

            <section className="panel">
              <header className="panel__head">
                <h2 className="h2">Воронка по шагам</h2>
                <span className="muted small">
                  порядок шагов — из конфига v{data.reference_version}
                  {filters.variant !== 'all' ? `, вариант ${filters.variant}` : ''}
                </span>
              </header>
              <FunnelTable steps={data.steps} started={data.overall.sessions_started} />
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2 className="h2">Сравнение вариантов A/B</h2>
                <span className="muted small">
                  вариант назначается на бэкенде и закреплён за сессией
                </span>
              </header>
              <SegmentCompare segments={data.by_variant} />
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2 className="h2">Сравнение версий</h2>
                <span className="muted small">сессии остаются на той версии, на которой начались</span>
              </header>
              <SegmentCompare segments={data.by_version} />
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2 className="h2">Кампании</h2>
              </header>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>utm_campaign</th>
                      <th className="num">Начали</th>
                      <th className="num">Дошли до результата</th>
                      <th className="num">Конверсия в результат</th>
                      <th className="num">Кликов CTA</th>
                      <th className="num">CTR CTA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_campaign.map((c) => (
                      <tr key={c.campaign}>
                        <td>
                          <button
                            className="link"
                            type="button"
                            onClick={() => patch({ campaign: c.campaign })}
                          >
                            {c.campaign}
                          </button>
                        </td>
                        <td className="num">{fmtInt(c.sessions_started)}</td>
                        <td className="num">{fmtInt(c.result_reached)}</td>
                        <td className="num">{fmtPercent(c.result_rate)}</td>
                        <td className="num">{fmtInt(c.cta_clicked)}</td>
                        <td className="num">{fmtPercent(c.cta_ctr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2 className="h2">Качество данных</h2>
                <span className="muted small">
                  агрегаты считаются множествами сессий, поэтому дубли, возвраты и события не по порядку
                  на цифры выше не влияют
                </span>
              </header>
              <div className="quality">
                <QualityCell label="Событий в хранилище" value={fmtInt(data.data_quality.events_stored)} />
                <QualityCell
                  label="Событий принято на вход"
                  value={fmtInt(data.data_quality.events_received)}
                  note={`${fmtInt(data.data_quality.batches_received)} вызовов ingest`}
                />
                <QualityCell
                  label="Дублей подавлено"
                  value={fmtInt(data.data_quality.duplicate_submissions_blocked)}
                  note="повторная отправка того же event_id"
                  tone="ok"
                />
                <QualityCell
                  label="Невалидных отклонено"
                  value={fmtInt(data.data_quality.rejected_events)}
                  note="батч при этом обработан целиком"
                  tone={data.data_quality.rejected_events > 0 ? 'warn' : 'neutral'}
                />
                <QualityCell
                  label="Пришло не по порядку"
                  value={fmtInt(data.data_quality.out_of_order_events)}
                  note="client_ts раньше уже сохранённого"
                />
                <QualityCell
                  label="Сессий с повторным просмотром"
                  value={fmtInt(data.data_quality.sessions_with_repeat_views)}
                  note="вернулись назад и увидели шаг снова"
                />
              </div>

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Тип события</th>
                      <th className="num">Событий</th>
                      <th className="num">Уникальных сессий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.event_counts.map((e) => (
                      <tr key={e.event_type}>
                        <td>
                          <code>{e.event_type}</code>
                        </td>
                        <td className="num">{fmtInt(e.events)}</td>
                        <td className="num">{fmtInt(e.sessions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {!data && loading && <div className="spinner" />}
      </div>
    </main>
  );
}

function KpiRow({ totals }: { totals: TotalsShape }): JSX.Element {
  return (
    <div className="kpis">
      <Kpi label="Начали воронку" value={fmtInt(totals.sessions_started)} sub="уникальных сессий" />
      <Kpi
        label="Дошли до результата"
        value={fmtInt(totals.result_reached)}
        sub={`${fmtPercent(totals.result_rate)} от начавших`}
      />
      <Kpi
        label="CTR основного CTA"
        value={fmtPercent(totals.cta_ctr)}
        sub={`${fmtInt(totals.cta_clicked)} кликов от увидевших результат`}
        accent
      />
      <Kpi
        label="CTA от всех начавших"
        value={fmtPercent(totals.cta_rate_of_started)}
        sub="сквозная конверсия"
      />
      <Kpi label="Шагов на сессию" value={totals.avg_unique_steps.toFixed(2)} sub="уникальных" />
      <Kpi
        label="Возвраты назад"
        value={fmtPercent(totals.back_rate)}
        sub={`${fmtInt(totals.sessions_with_back)} сессий`}
      />
      <Kpi
        label="Медиана до результата"
        value={fmtDuration(totals.median_time_to_result_sec)}
        sub="по client_ts"
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className={`kpi ${accent ? 'kpi--accent' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
      {sub && <div className="kpi__sub">{sub}</div>}
    </div>
  );
}

function FunnelTable({ steps, started }: { steps: StepMetricShape[]; started: number }): JSX.Element {
  const max = Math.max(started, ...steps.map((s) => s.viewed), 1);

  return (
    <div className="table-wrap">
      <table className="table table--funnel">
        <thead>
          <tr>
            <th>Шаг</th>
            <th className="num">Увидели</th>
            <th>Доля от начавших</th>
            <th className="num">Прошли дальше</th>
            <th className="num">Конверсия шага</th>
            <th className="num">Отвал</th>
            <th className="num">Повторные просмотры</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <>
              <tr key={step.step_id} className={step.in_config ? '' : 'row--muted'}>
                <td>
                  <div className="step-cell">
                    <code>{step.step_id}</code>
                    <span className="pill pill--neutral">{step.type}</span>
                  </div>
                  <div className="muted small">{step.title}</div>
                  {!step.in_config && (
                    <div className="muted small">нет в конфиге выбранной версии — данные старой версии</div>
                  )}
                </td>
                <td className="num">{fmtInt(step.viewed)}</td>
                <td className="bar-cell">
                  <div className="bar">
                    <div className="bar__fill" style={{ width: `${(step.viewed / max) * 100}%` }} />
                  </div>
                  <span className="muted small">{fmtPercent(step.reach_rate)}</span>
                </td>
                <td className="num">{fmtInt(step.completed)}</td>
                <td className="num">
                  <b>{fmtPercent(step.step_conversion)}</b>
                </td>
                <td className="num">
                  <span className={step.drop_rate > 0.2 ? 'warn' : ''}>
                    {fmtInt(step.dropped)} ({fmtPercent(step.drop_rate)})
                  </span>
                </td>
                <td className="num muted">{fmtInt(step.repeat_view_sessions)}</td>
              </tr>
              {step.branches.length > 0 && (
                <tr key={`${step.step_id}-branches`} className="row--branch">
                  <td colSpan={7}>
                    <div className="branches">
                      <span className="branches__label">Ветвление:</span>
                      {step.branches.map((b) => (
                        <span className="branch" key={b.to_step}>
                          <code>{b.to_step}</code>
                          <b>{fmtInt(b.sessions)}</b>
                          <span className="muted">{fmtPercent(b.share, 0)}</span>
                          {b.label && <span className="branch__label">{b.label}</span>}
                        </span>
                      ))}
                      <span className="muted small">
                        сессия, вернувшаяся назад и сменившая ответ, попадает в обе ветки
                      </span>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SegmentCompare({ segments }: { segments: SegmentShape[] }): JSX.Element {
  if (segments.length === 0) return <p className="muted">Нет данных.</p>;
  const baseline = segments[0] as SegmentShape;

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Сегмент</th>
              <th className="num">Начали</th>
              <th className="num">Результат</th>
              <th className="num">Конверсия в результат</th>
              <th className="num">CTR CTA</th>
              <th className="num">CTA от начавших</th>
              <th className="num">Шагов на сессию</th>
              <th className="num">Медиана до результата</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((seg) => {
              const isBase = seg.key === baseline.key;
              const dResult = fmtDeltaPp(seg.totals.result_rate, baseline.totals.result_rate);
              const dCtr = fmtDeltaPp(seg.totals.cta_ctr, baseline.totals.cta_ctr);
              return (
                <tr key={seg.key}>
                  <td>
                    <b>{seg.label}</b>
                    {isBase && <span className="muted small"> — база сравнения</span>}
                  </td>
                  <td className="num">{fmtInt(seg.totals.sessions_started)}</td>
                  <td className="num">{fmtInt(seg.totals.result_reached)}</td>
                  <td className="num">
                    {fmtPercent(seg.totals.result_rate)}
                    {!isBase && <span className={`delta delta--${dResult.tone}`}>{dResult.text}</span>}
                  </td>
                  <td className="num">
                    {fmtPercent(seg.totals.cta_ctr)}
                    {!isBase && <span className={`delta delta--${dCtr.tone}`}>{dCtr.text}</span>}
                  </td>
                  <td className="num">{fmtPercent(seg.totals.cta_rate_of_started)}</td>
                  <td className="num">{seg.totals.avg_unique_steps.toFixed(2)}</td>
                  <td className="num">{fmtDuration(seg.totals.median_time_to_result_sec)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="raw">
        <summary>Пошаговое сравнение сегментов</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Шаг</th>
                {segments.map((s) => (
                  <th key={s.key} className="num" colSpan={2}>
                    {s.label}
                  </th>
                ))}
              </tr>
              <tr>
                <th />
                {segments.map((s) => (
                  <>
                    <th key={`${s.key}-v`} className="num small muted">
                      увидели
                    </th>
                    <th key={`${s.key}-c`} className="num small muted">
                      конверсия
                    </th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {unionStepIds(segments).map((stepId) => (
                <tr key={stepId}>
                  <td>
                    <code>{stepId}</code>
                  </td>
                  {segments.map((s) => {
                    const m = s.steps.find((x) => x.step_id === stepId);
                    return (
                      <>
                        <td key={`${s.key}-${stepId}-v`} className="num">
                          {m ? fmtInt(m.viewed) : '—'}
                        </td>
                        <td key={`${s.key}-${stepId}-c`} className="num">
                          {m && m.viewed > 0 ? fmtPercent(m.step_conversion) : '—'}
                        </td>
                      </>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function unionStepIds(segments: SegmentShape[]): string[] {
  const order = new Map<string, number>();
  for (const seg of segments) {
    for (const step of seg.steps) {
      const existing = order.get(step.step_id);
      if (existing === undefined || step.order < existing) order.set(step.step_id, step.order);
    }
  }
  return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

function QualityCell({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'ok' | 'warn' | 'neutral';
}): JSX.Element {
  return (
    <div className={`quality__cell quality__cell--${tone}`}>
      <div className="quality__value">{value}</div>
      <div className="quality__label">{label}</div>
      {note && <div className="quality__note">{note}</div>}
    </div>
  );
}
