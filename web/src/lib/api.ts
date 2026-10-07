import type {
  AnalyticsResponseShape,
  AdminOverview,
  VersionDetail,
} from './adminTypes.js';
import type { AnswerValue, SessionBootstrap } from '@funnel/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const ADMIN_TOKEN_KEY = 'funnel.admin_token';

export function getAdminToken(): string {
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const payload = body as { error?: string; details?: unknown } | null;
    throw new ApiError(payload?.error ?? `Ошибка ${res.status}`, res.status, payload?.details);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export interface FunnelDescriptor {
  funnel_id: string;
  name: string;
  active_version: number;
  schema_version: number;
  step_count: number;
  experiment: { key: string; variants: string[]; hypothesis: string; primaryMetric: string };
  theme: { accent?: string; accentSoft?: string } | null;
}

export interface SubmitAnswerResponse extends SessionBootstrap {
  previous_step: string;
  next_step: string | null;
}

export interface ResultPayload {
  step_id: string;
  title: string;
  cta_label: string;
  cta_href: string;
  secondary_cta_label: string | null;
  outcome: {
    id: string;
    headline: string;
    body: string[];
    highlights?: { label: string; value: string }[];
  };
  variant: string;
  funnel_version: number;
}

export const api = {
  funnel: () => request<FunnelDescriptor>('/api/funnel'),

  createSession: (payload: Record<string, string | null | undefined>) =>
    post<SessionBootstrap>('/api/session', payload),

  getSession: (id: string) => request<SessionBootstrap>(`/api/session/${encodeURIComponent(id)}`),

  answer: (
    id: string,
    payload: { step_id: string; value: AnswerValue; client_ts: string; event_ids?: Record<string, string> },
  ) => post<SubmitAnswerResponse>(`/api/session/${encodeURIComponent(id)}/answer`, payload),

  back: (id: string, payload: { event_id: string; client_ts: string }) =>
    post<SessionBootstrap & { previous_step: string }>(
      `/api/session/${encodeURIComponent(id)}/back`,
      payload,
    ),

  result: (id: string) => request<ResultPayload>(`/api/session/${encodeURIComponent(id)}/result`),

  analytics: (params: Record<string, string>) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v && v !== 'all'),
    ).toString();
    return request<AnalyticsResponseShape>(`/api/analytics${qs ? `?${qs}` : ''}`);
  },

  adminOverview: () => request<AdminOverview>('/api/admin/overview'),

  versionDetail: (version: number) => request<VersionDetail>(`/api/admin/versions/${version}`),

  publish: (payload: { file?: string; config?: unknown; notes?: string; activate?: boolean }) =>
    post<{ version: number; activated: boolean }>('/api/admin/versions', payload),

  activate: (payload: { version: number; note?: string }) =>
    post<{ version: number; previous: number | null; action: string }>('/api/admin/activate', payload),
};
