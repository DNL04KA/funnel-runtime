/**
 * Funnel configuration schema.
 *
 * A funnel config is a directed graph of steps. The frontend knows nothing about
 * any concrete screen: it renders whatever step types the config declares.
 */

export type StepType =
  | 'info'
  | 'single_select'
  | 'multi_select'
  | 'number'
  | 'result';

export type AnswerValue = string | string[] | number | null;

export type AnswerMap = Record<string, AnswerValue>;

/** Leaf predicate over a previously answered field. */
export interface LeafCondition {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'includes' | 'excludes' | 'answered' | 'empty';
  value?: string | number | Array<string | number>;
}

export interface AllCondition {
  all: Condition[];
}

export interface AnyCondition {
  any: Condition[];
}

export interface NotCondition {
  not: Condition;
}

export type Condition = LeafCondition | AllCondition | AnyCondition | NotCondition;

/** One branch of a conditional transition. The first matching rule wins. */
export interface TransitionRule {
  /** Omit `if` to make this the fallback branch. */
  if?: Condition;
  goto: string;
  /** Optional human-readable label, used by the admin page to explain branching. */
  label?: string;
}

/** `next` is either a plain step id or an ordered list of conditional rules. */
export type Transition = string | TransitionRule[];

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  /** Weight used only by the synthetic traffic generator. */
  trafficWeight?: number;
}

export interface BaseStep {
  id: string;
  type: StepType;
  title: string;
  subtitle?: string;
  /** Shown as a collapsible hint. Expanding it emits `hint_expanded` (added in v3). */
  hint?: string;
  next?: Transition;
  /** Excluded from the progress denominator (e.g. interstitials). */
  skipProgress?: boolean;
}

export interface InfoStep extends BaseStep {
  type: 'info';
  body: string[];
  ctaLabel: string;
}

export interface SingleSelectStep extends BaseStep {
  type: 'single_select';
  field: string;
  options: SelectOption[];
  required?: boolean;
}

export interface MultiSelectStep extends BaseStep {
  type: 'multi_select';
  field: string;
  options: SelectOption[];
  minSelected?: number;
  maxSelected?: number;
}

export interface NumberStep extends BaseStep {
  type: 'number';
  field: string;
  min?: number;
  max?: number;
  stepSize?: number;
  unit?: string;
  placeholder?: string;
  required?: boolean;
  /** Bucket edges used to anonymise the answer before it reaches analytics. */
  buckets?: number[];
}

export interface ResultStep extends BaseStep {
  type: 'result';
  /** Ordered rules; the first match renders. Last entry should be unconditional. */
  outcomes: ResultOutcome[];
  ctaLabel: string;
  ctaHref: string;
  secondaryCtaLabel?: string;
}

export interface ResultOutcome {
  id: string;
  if?: Condition;
  headline: string;
  body: string[];
  /** Key/value facts rendered as a summary table. */
  highlights?: { label: string; value: string }[];
}

export type FunnelStep =
  | InfoStep
  | SingleSelectStep
  | MultiSelectStep
  | NumberStep
  | ResultStep;

export interface ExperimentSpec {
  key: string;
  variants: VariantId[];
  hypothesis: string;
  primaryMetric: string;
  /** Share of traffic per variant; must sum to 1. */
  split?: Record<string, number>;
}

export type VariantId = 'A' | 'B';

/** Per-variant mutations applied on the server before the config is served. */
export interface VariantPatch {
  /** Shallow-merged onto the matching step, by step id. */
  overrides?: Record<string, Record<string, unknown>>;
  /** Steps removed for this variant. Inbound transitions are rewired automatically. */
  removeSteps?: string[];
  /**
   * Canonical ordering of steps for this variant: it drives the order of the
   * steps array (and therefore the dashboard's funnel table). Actual traversal
   * order is always defined by `next`, so a variant that genuinely reorders the
   * flow must also override the relevant `next` transitions.
   */
  stepOrder?: string[];
}

export interface FunnelConfig {
  /** Stable funnel key, identical across versions. */
  funnelId: string;
  name: string;
  /** Config-declared schema revision. Informational; the DB version is authoritative. */
  schemaVersion: number;
  start: string;
  steps: FunnelStep[];
  experiment: ExperimentSpec;
  variants?: Partial<Record<VariantId, VariantPatch>>;
  /** Event types this config may emit, beyond the always-on core set. */
  emits?: string[];
  theme?: { accent?: string; accentSoft?: string };
}

/* ------------------------------------------------------------------ events */

export const CORE_EVENT_TYPES = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;

/** Introduced by the second iteration (config v3). Accepted without a migration. */
export const EXTENDED_EVENT_TYPES = ['hint_expanded'] as const;

export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];
export type EventType = CoreEventType | (typeof EXTENDED_EVENT_TYPES)[number];

export const KNOWN_EVENT_TYPES: readonly string[] = [
  ...CORE_EVENT_TYPES,
  ...EXTENDED_EVENT_TYPES,
];

export interface UtmParams {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

/** Wire format accepted by POST /api/events. */
export interface IncomingEvent extends UtmParams {
  event_id: string;
  session_id: string;
  event_type: string;
  client_ts: string;
  step_id?: string | null;
  funnel_version?: number | null;
  variant?: string | null;
  props?: Record<string, unknown> | null;
}

export interface StoredEvent extends Required<Pick<IncomingEvent, 'event_id' | 'session_id' | 'event_type'>> {
  step_id: string | null;
  funnel_version: number;
  variant: VariantId;
  client_ts: string;
  server_ts: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  props: Record<string, unknown>;
}

export type EventIngestStatus = 'accepted' | 'duplicate' | 'rejected';

export interface EventIngestResult {
  index: number;
  event_id: string | null;
  status: EventIngestStatus;
  error?: string;
}

export interface EventIngestResponse {
  received: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  results: EventIngestResult[];
}

/* ---------------------------------------------------------------- sessions */

export interface SessionSnapshot {
  session_id: string;
  funnel_version: number;
  variant: VariantId;
  variant_source: 'assigned' | 'override';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  current_step: string;
  answers: AnswerMap;
  /** Step ids the session has actually visited, in order. */
  history: string[];
  utm: UtmParams;
}

export interface SessionBootstrap {
  session: SessionSnapshot;
  config: FunnelConfig;
  progress: ProgressInfo;
  /** True when the pinned version is no longer the active one. */
  version_is_stale: boolean;
  active_version: number;
}

export interface ProgressInfo {
  /** 1-based position of the current step among reachable, progress-bearing steps. */
  index: number;
  total: number;
  percent: number;
  /** Projected path through the funnel given the answers so far. */
  path: string[];
}

/* ------------------------------------------------------------------ admin */

export interface VersionSummary {
  version: number;
  name: string;
  notes: string | null;
  created_at: string;
  is_active: boolean;
  session_count: number;
  event_count: number;
  step_count: number;
  source_file: string | null;
}

export interface VersionAuditEntry {
  id: number;
  action: 'publish' | 'rollback' | 'activate';
  from_version: number | null;
  to_version: number;
  actor: string;
  at: string;
  note: string | null;
}
