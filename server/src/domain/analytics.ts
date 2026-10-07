import type { FunnelConfig, FunnelStep, StepType, VariantId } from '@funnel/shared';
import { resolveVariantConfig } from '@funnel/shared';
import type { Db } from '../db/index.js';
import { getIngestCounters } from './events.js';
import { getActiveVersion, getVersion } from './versions.js';

export interface AnalyticsFilters {
  funnelId: string;
  version?: number | null;
  variant?: VariantId | null;
  campaign?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface StepMetric {
  step_id: string;
  title: string;
  type: StepType | 'unknown';
  order: number;
  in_config: boolean;
  /** Unique sessions that saw the step at least once. */
  viewed: number;
  /** Unique sessions that moved on from the step (CTA click for the result step). */
  completed: number;
  dropped: number;
  drop_rate: number;
  step_conversion: number;
  reach_rate: number;
  /** Sessions that saw the step more than once — i.e. came back to it. */
  repeat_view_sessions: number;
  branches: BranchMetric[];
}

export interface BranchMetric {
  to_step: string;
  label: string | null;
  sessions: number;
  share: number;
}

export interface Totals {
  sessions_started: number;
  sessions_with_step_view: number;
  result_reached: number;
  result_rate: number;
  cta_clicked: number;
  cta_ctr: number;
  cta_rate_of_started: number;
  sessions_with_back: number;
  back_rate: number;
  avg_unique_steps: number;
  median_time_to_result_sec: number | null;
}

export interface Segment {
  key: string;
  label: string;
  totals: Totals;
  steps: StepMetric[];
}

export interface DataQuality {
  events_stored: number;
  /** Global ingest tallies — see the note in `dataQuality`. */
  batches_received: number;
  events_received: number;
  duplicate_submissions_blocked: number;
  rejected_events: number;
  out_of_order_events: number;
  sessions_with_repeat_views: number;
  latest_event_at: string | null;
}

export interface AnalyticsResponse {
  filters: {
    version: number | null;
    variant: VariantId | null;
    campaign: string | null;
    from: string | null;
    to: string | null;
  };
  available: {
    versions: { version: number; name: string; sessions: number; is_active: boolean }[];
    variants: string[];
    campaigns: string[];
  };
  reference_version: number;
  overall: Totals;
  steps: StepMetric[];
  by_variant: Segment[];
  by_version: Segment[];
  by_campaign: {
    campaign: string;
    sessions_started: number;
    result_reached: number;
    result_rate: number;
    cta_clicked: number;
    cta_ctr: number;
  }[];
  event_counts: { event_type: string; events: number; sessions: number }[];
  data_quality: DataQuality;
  generated_at: string;
}

/* ----------------------------------------------------------- SQL filtering */

interface Where {
  sql: string;
  params: unknown[];
}

/**
 * Every aggregate is scoped by the same predicate, built once. Note what is
 * *not* here: nothing reads the `sessions` table, so raw answers are physically
 * unreachable from the analytics layer.
 */
function buildWhere(f: AnalyticsFilters, extra: Where[] = []): Where {
  const clauses = ['e.funnel_id = ?'];
  const params: unknown[] = [f.funnelId];

  if (f.version != null) {
    clauses.push('e.funnel_version = ?');
    params.push(f.version);
  }
  if (f.variant) {
    clauses.push('e.variant = ?');
    params.push(f.variant);
  }
  if (f.campaign) {
    if (f.campaign === '(none)') clauses.push('e.utm_campaign IS NULL');
    else {
      clauses.push('e.utm_campaign = ?');
      params.push(f.campaign);
    }
  }
  if (f.from) {
    clauses.push('e.server_ts >= ?');
    params.push(f.from);
  }
  if (f.to) {
    clauses.push('e.server_ts <= ?');
    params.push(f.to);
  }
  for (const e of extra) {
    clauses.push(e.sql);
    params.push(...e.params);
  }
  return { sql: clauses.join(' AND '), params };
}

function distinctSessions(db: Db, f: AnalyticsFilters, extra: Where[]): number {
  const where = buildWhere(f, extra);
  const row = db
    .prepare(`SELECT COUNT(DISTINCT e.session_id) AS n FROM events e WHERE ${where.sql}`)
    .get(...where.params) as { n: number };
  return row.n;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/* ------------------------------------------------------------- step config */

interface ConfigStepInfo {
  step: FunnelStep;
  order: number;
}

/**
 * The step list and its order come from a config, not from the data, so an
 * empty step still shows up as a 0% row instead of silently vanishing.
 */
function configSteps(db: Db, f: AnalyticsFilters): { map: Map<string, ConfigStepInfo>; version: number; config: FunnelConfig } {
  const stored = f.version != null ? getVersion(db, f.version) : null;
  const base = stored ?? getActiveVersion(db, f.funnelId);
  const config = f.variant ? resolveVariantConfig(base.config, f.variant) : base.config;
  const map = new Map<string, ConfigStepInfo>();
  config.steps.forEach((step, order) => map.set(step.id, { step, order }));
  return { map, version: base.version, config };
}

function stepTitle(info: ConfigStepInfo | undefined, stepId: string): string {
  return info?.step.title ?? stepId;
}

/* ------------------------------------------------------------- aggregation */

function computeTotals(db: Db, f: AnalyticsFilters): Totals {
  const started = distinctSessions(db, f, [{ sql: "e.event_type = 'session_started'", params: [] }]);
  const withStepView = distinctSessions(db, f, [{ sql: "e.event_type = 'step_viewed'", params: [] }]);
  const resultReached = distinctSessions(db, f, [{ sql: "e.event_type = 'result_viewed'", params: [] }]);
  const ctaClicked = distinctSessions(db, f, [{ sql: "e.event_type = 'cta_clicked'", params: [] }]);
  const withBack = distinctSessions(db, f, [{ sql: "e.event_type = 'back_clicked'", params: [] }]);

  const where = buildWhere(f, [{ sql: "e.event_type = 'step_viewed'", params: [] }]);
  const avgRow = db
    .prepare(
      `SELECT AVG(c) AS avg_steps FROM (
         SELECT COUNT(DISTINCT e.step_id) AS c
           FROM events e WHERE ${where.sql}
          GROUP BY e.session_id)`,
    )
    .get(...where.params) as { avg_steps: number | null };

  // Time to result per session: first session_started → first result_viewed,
  // measured on client timestamps and guarded against negative values caused by
  // skewed clocks or out-of-order delivery.
  const timeWhere = buildWhere(f, [
    { sql: "e.event_type IN ('session_started','result_viewed')", params: [] },
  ]);
  const durations = (
    db
      .prepare(
        `SELECT session_id,
                MIN(CASE WHEN event_type = 'session_started' THEN client_ts END) AS t0,
                MIN(CASE WHEN event_type = 'result_viewed'   THEN client_ts END) AS t1
           FROM events e WHERE ${timeWhere.sql}
          GROUP BY session_id
         HAVING t0 IS NOT NULL AND t1 IS NOT NULL`,
      )
      .all(...timeWhere.params) as { session_id: string; t0: string; t1: string }[]
  )
    .map((r) => (new Date(r.t1).getTime() - new Date(r.t0).getTime()) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);

  const median =
    durations.length === 0
      ? null
      : Math.round(durations[Math.floor((durations.length - 1) / 2)] as number);

  return {
    sessions_started: started,
    sessions_with_step_view: withStepView,
    result_reached: resultReached,
    result_rate: ratio(resultReached, started),
    cta_clicked: ctaClicked,
    cta_ctr: ratio(ctaClicked, resultReached),
    cta_rate_of_started: ratio(ctaClicked, started),
    sessions_with_back: withBack,
    back_rate: ratio(withBack, started),
    avg_unique_steps: Math.round((avgRow.avg_steps ?? 0) * 100) / 100,
    median_time_to_result_sec: median,
  };
}

function computeSteps(db: Db, f: AnalyticsFilters, totals: Totals): StepMetric[] {
  const { map } = configSteps(db, f);

  const viewedWhere = buildWhere(f, [{ sql: "e.event_type = 'step_viewed'", params: [] }]);
  const viewedRows = db
    .prepare(
      `SELECT e.step_id AS step_id,
              COUNT(DISTINCT e.session_id) AS sessions,
              COUNT(*) AS views
         FROM events e
        WHERE ${viewedWhere.sql} AND e.step_id IS NOT NULL
        GROUP BY e.step_id`,
    )
    .all(...viewedWhere.params) as { step_id: string; sessions: number; views: number }[];

  const completedWhere = buildWhere(f, [{ sql: "e.event_type = 'step_completed'", params: [] }]);
  const completedRows = db
    .prepare(
      `SELECT e.step_id AS step_id, COUNT(DISTINCT e.session_id) AS sessions
         FROM events e
        WHERE ${completedWhere.sql} AND e.step_id IS NOT NULL
        GROUP BY e.step_id`,
    )
    .all(...completedWhere.params) as { step_id: string; sessions: number }[];

  // Sessions that saw a step more than once. Counted separately rather than
  // folded into `viewed`, which is why going back never inflates a funnel row.
  const repeatRows = db
    .prepare(
      `SELECT step_id, COUNT(*) AS sessions FROM (
         SELECT e.step_id AS step_id, e.session_id, COUNT(*) AS views
           FROM events e
          WHERE ${viewedWhere.sql} AND e.step_id IS NOT NULL
          GROUP BY e.step_id, e.session_id
         HAVING views > 1)
       GROUP BY step_id`,
    )
    .all(...viewedWhere.params) as { step_id: string; sessions: number }[];

  const viewed = new Map(viewedRows.map((r) => [r.step_id, r.sessions]));
  const completed = new Map(completedRows.map((r) => [r.step_id, r.sessions]));
  const repeats = new Map(repeatRows.map((r) => [r.step_id, r.sessions]));

  const ctaSessions = distinctSessions(db, f, [{ sql: "e.event_type = 'cta_clicked'", params: [] }]);

  const ids = new Set<string>([...map.keys(), ...viewed.keys(), ...completed.keys()]);

  const metrics: StepMetric[] = [...ids].map((stepId) => {
    const info = map.get(stepId);
    const isResult = info?.step.type === 'result';
    const v = viewed.get(stepId) ?? 0;
    // The result screen emits no `step_completed`; its forward action is the CTA.
    const c = isResult ? ctaSessions : (completed.get(stepId) ?? 0);
    const dropped = Math.max(v - c, 0);

    return {
      step_id: stepId,
      title: stepTitle(info, stepId),
      type: info?.step.type ?? 'unknown',
      order: info?.order ?? 10_000,
      in_config: Boolean(info),
      viewed: v,
      completed: c,
      dropped,
      drop_rate: ratio(dropped, v),
      step_conversion: ratio(c, v),
      reach_rate: ratio(v, totals.sessions_started),
      repeat_view_sessions: repeats.get(stepId) ?? 0,
      branches: [],
    };
  });

  metrics.sort((a, b) => a.order - b.order || a.step_id.localeCompare(b.step_id));
  attachBranches(db, f, metrics, map);
  return metrics;
}

/**
 * For every branching step, how the traffic actually split. Computed set-wise
 * (sessions that completed X *and* saw Y), so it is immune to delivery order;
 * a session that went back and switched branches is counted in both, which the
 * dashboard labels explicitly.
 */
function attachBranches(
  db: Db,
  f: AnalyticsFilters,
  metrics: StepMetric[],
  map: Map<string, ConfigStepInfo>,
): void {
  for (const metric of metrics) {
    const info = map.get(metric.step_id);
    const next = info?.step.next;
    if (!Array.isArray(next) || next.length < 2) continue;

    const branches: BranchMetric[] = [];
    for (const rule of next) {
      const where = buildWhere(f, [
        { sql: "e.event_type = 'step_completed'", params: [] },
        { sql: 'e.step_id = ?', params: [metric.step_id] },
        {
          sql: `e.session_id IN (
                  SELECT v.session_id FROM events v
                   WHERE v.event_type = 'step_viewed'
                     AND v.step_id = ?
                     AND v.funnel_id = e.funnel_id
                     AND v.funnel_version = e.funnel_version
                     AND v.variant = e.variant)`,
          params: [rule.goto],
        },
      ]);
      const row = db
        .prepare(`SELECT COUNT(DISTINCT e.session_id) AS n FROM events e WHERE ${where.sql}`)
        .get(...where.params) as { n: number };
      branches.push({
        to_step: rule.goto,
        label: rule.label ?? null,
        sessions: row.n,
        share: 0,
      });
    }

    const total = branches.reduce((acc, b) => acc + b.sessions, 0);
    for (const b of branches) b.share = ratio(b.sessions, total);
    metric.branches = branches;
  }
}

function computeSegment(db: Db, f: AnalyticsFilters, key: string, label: string): Segment {
  const totals = computeTotals(db, f);
  return { key, label, totals, steps: computeSteps(db, f, totals) };
}

function dataQuality(db: Db, f: AnalyticsFilters): DataQuality {
  const where = buildWhere(f);
  const stored = (
    db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${where.sql}`).get(...where.params) as { n: number }
  ).n;
  const latest = (
    db
      .prepare(`SELECT MAX(e.server_ts) AS t FROM events e WHERE ${where.sql}`)
      .get(...where.params) as { t: string | null }
  ).t;

  // Ingest counters are global rather than filtered: a suppressed replay never
  // becomes a row, so it carries no version, variant or campaign to filter on.
  const counters = getIngestCounters(db);

  // An event is "late" when it reached the server after an event the user
  // produced later. Because every aggregate is set-based this changes nothing
  // about the numbers — it is reported so the dashboard can prove that.
  const rows = db
    .prepare(
      `SELECT e.session_id, e.client_ts, e.rowid AS rid
         FROM events e WHERE ${where.sql}
        ORDER BY e.session_id, e.server_ts, e.rowid`,
    )
    .all(...where.params) as { session_id: string; client_ts: string; rid: number }[];

  let outOfOrder = 0;
  let currentSession = '';
  let maxClient = 0;
  for (const row of rows) {
    if (row.session_id !== currentSession) {
      currentSession = row.session_id;
      maxClient = 0;
    }
    const ts = new Date(row.client_ts).getTime();
    if (maxClient !== 0 && ts < maxClient) outOfOrder += 1;
    if (ts > maxClient) maxClient = ts;
  }

  const repeatWhere = buildWhere(f, [{ sql: "e.event_type = 'step_viewed'", params: [] }]);
  const repeatSessions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT session_id FROM (
             SELECT e.session_id AS session_id, e.step_id AS step_id
               FROM events e
              WHERE ${repeatWhere.sql} AND e.step_id IS NOT NULL
              GROUP BY e.session_id, e.step_id
             HAVING COUNT(*) > 1
           ) GROUP BY session_id)`,
      )
      .get(...repeatWhere.params) as { n: number }
  ).n;

  return {
    events_stored: stored,
    batches_received: counters.batches,
    events_received: counters.received,
    duplicate_submissions_blocked: counters.duplicates,
    rejected_events: counters.rejected,
    out_of_order_events: outOfOrder,
    sessions_with_repeat_views: repeatSessions,
    latest_event_at: latest,
  };
}

export function getAnalytics(db: Db, filters: AnalyticsFilters): AnalyticsResponse {
  const base: AnalyticsFilters = {
    funnelId: filters.funnelId,
    version: filters.version ?? null,
    variant: filters.variant ?? null,
    campaign: filters.campaign ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
  };

  const overall = computeTotals(db, base);
  const steps = computeSteps(db, base, overall);
  const { version: referenceVersion } = configSteps(db, base);

  const versionRows = db
    .prepare(
      `SELECT v.version, v.name,
              (SELECT COUNT(DISTINCT e.session_id) FROM events e
                WHERE e.funnel_version = v.version AND e.event_type = 'session_started') AS sessions
         FROM funnel_versions v WHERE v.funnel_id = ? ORDER BY v.version DESC`,
    )
    .all(base.funnelId) as { version: number; name: string; sessions: number }[];
  const activeVersion = getActiveVersion(db, base.funnelId).version;

  const campaignWhere = buildWhere({ ...base, campaign: null });
  const campaigns = (
    db
      .prepare(
        `SELECT COALESCE(e.utm_campaign, '(none)') AS campaign
           FROM events e WHERE ${campaignWhere.sql}
          GROUP BY campaign ORDER BY COUNT(DISTINCT e.session_id) DESC`,
      )
      .all(...campaignWhere.params) as { campaign: string }[]
  ).map((r) => r.campaign);

  const variantWhere = buildWhere({ ...base, variant: null });
  const variants = (
    db
      .prepare(`SELECT DISTINCT e.variant AS v FROM events e WHERE ${variantWhere.sql} ORDER BY v`)
      .all(...variantWhere.params) as { v: string }[]
  ).map((r) => r.v);

  const byVariant: Segment[] = variants.map((v) =>
    computeSegment(db, { ...base, variant: v as VariantId }, v, `Вариант ${v}`),
  );

  const versionsInData = (
    db
      .prepare(
        `SELECT DISTINCT e.funnel_version AS v FROM events e WHERE ${variantWhere.sql} ORDER BY v DESC`,
      )
      .all(...variantWhere.params) as { v: number }[]
  ).map((r) => r.v);

  const byVersion: Segment[] = (base.version != null ? [base.version] : versionsInData).map((v) =>
    computeSegment(db, { ...base, version: v }, String(v), `Версия ${v}`),
  );

  const byCampaign = campaigns.map((campaign) => {
    const scoped: AnalyticsFilters = { ...base, campaign };
    const t = computeTotals(db, scoped);
    return {
      campaign,
      sessions_started: t.sessions_started,
      result_reached: t.result_reached,
      result_rate: t.result_rate,
      cta_clicked: t.cta_clicked,
      cta_ctr: t.cta_ctr,
    };
  });

  const countsWhere = buildWhere(base);
  const eventCounts = db
    .prepare(
      `SELECT e.event_type AS event_type, COUNT(*) AS events, COUNT(DISTINCT e.session_id) AS sessions
         FROM events e WHERE ${countsWhere.sql}
        GROUP BY e.event_type ORDER BY events DESC`,
    )
    .all(...countsWhere.params) as { event_type: string; events: number; sessions: number }[];

  return {
    filters: {
      version: base.version ?? null,
      variant: base.variant ?? null,
      campaign: base.campaign ?? null,
      from: base.from ?? null,
      to: base.to ?? null,
    },
    available: {
      versions: versionRows.map((r) => ({ ...r, is_active: r.version === activeVersion })),
      variants,
      campaigns,
    },
    reference_version: referenceVersion,
    overall,
    steps,
    by_variant: byVariant,
    by_version: byVersion,
    by_campaign: byCampaign,
    event_counts: eventCounts,
    data_quality: dataQuality(db, base),
    generated_at: new Date().toISOString(),
  };
}
