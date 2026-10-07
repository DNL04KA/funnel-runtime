import type { ConfigIssue, FunnelConfig, VersionAuditEntry, VersionSummary } from '@funnel/shared';

export interface StepMetricShape {
  step_id: string;
  title: string;
  type: string;
  order: number;
  in_config: boolean;
  viewed: number;
  completed: number;
  dropped: number;
  drop_rate: number;
  step_conversion: number;
  reach_rate: number;
  repeat_view_sessions: number;
  branches: { to_step: string; label: string | null; sessions: number; share: number }[];
}

export interface TotalsShape {
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

export interface SegmentShape {
  key: string;
  label: string;
  totals: TotalsShape;
  steps: StepMetricShape[];
}

export interface AnalyticsResponseShape {
  filters: {
    version: number | null;
    variant: string | null;
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
  overall: TotalsShape;
  steps: StepMetricShape[];
  by_variant: SegmentShape[];
  by_version: SegmentShape[];
  by_campaign: {
    campaign: string;
    sessions_started: number;
    result_reached: number;
    result_rate: number;
    cta_clicked: number;
    cta_ctr: number;
  }[];
  event_counts: { event_type: string; events: number; sessions: number }[];
  data_quality: {
    events_stored: number;
    batches_received: number;
    events_received: number;
    duplicate_submissions_blocked: number;
    rejected_events: number;
    out_of_order_events: number;
    sessions_with_repeat_views: number;
    latest_event_at: string | null;
  };
  generated_at: string;
  demo_mode?: boolean;
}

export interface LibraryEntry {
  file: string;
  name: string;
  funnelId: string;
  schemaVersion: number;
  stepCount: number;
  issues: ConfigIssue[];
  experiment: { key: string; hypothesis: string; primaryMetric: string } | null;
}

export interface SessionListRowShape {
  session_id: string;
  funnel_version: number;
  variant: string;
  variant_source: string;
  created_at: string;
  updated_at: string;
  current_step: string;
  completed_at: string | null;
  utm_campaign: string | null;
  event_count: number;
}

export interface RejectRowShape {
  id: number;
  received_at: string;
  reason: string;
  event_id: string | null;
  session_id: string | null;
  event_type: string | null;
  payload_json: string;
}

export interface AdminOverview {
  funnel_id: string;
  demo_mode?: boolean;
  active_version: number | null;
  versions: VersionSummary[];
  audit: VersionAuditEntry[];
  library: LibraryEntry[];
  recent_sessions: SessionListRowShape[];
  rejects: RejectRowShape[];
}

export interface VersionDetail {
  version: number;
  name: string;
  notes: string | null;
  created_at: string;
  config_hash: string;
  source_file: string | null;
  is_active: boolean;
  issues: ConfigIssue[];
  config: FunnelConfig;
  resolved: Record<string, FunnelConfig>;
}
