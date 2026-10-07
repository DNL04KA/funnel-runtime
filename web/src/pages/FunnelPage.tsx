import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getStep,
  validateAnswer,
  type AnswerValue,
  type FunnelStep,
  type SessionBootstrap,
} from '@funnel/shared';
import { api, ApiError, type ResultPayload } from '../lib/api.js';
import { eventQueue } from '../lib/eventQueue.js';
import {
  clearStoredSessionId,
  readLaunchParams,
  readStoredSessionId,
  storeSessionId,
  stripResetParam,
} from '../lib/session.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { StepRenderer } from '../components/StepRenderer.js';
import { ResultScreen } from '../components/ResultScreen.js';
import { SessionBadge } from '../components/SessionBadge.js';

type Status = 'loading' | 'ready' | 'error';

/**
 * The funnel runner. It contains no screen-specific markup at all: every screen
 * is produced by `StepRenderer` from the config the server returns, so adding a
 * step type is a config + renderer change and adding a *screen* is config only.
 */
export function FunnelPage(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [boot, setBoot] = useState<SessionBootstrap | null>(null);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [draft, setDraft] = useState<AnswerValue>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Per-session event sequence, so retried actions reuse the same event_id.
  const seqRef = useRef(0);
  const viewedRef = useRef(new Set<string>());
  const nextSeq = (): number => {
    seqRef.current += 1;
    return seqRef.current;
  };

  const session = boot?.session ?? null;
  const config = boot?.config ?? null;
  const step: FunnelStep | null = useMemo(
    () => (config && session ? (getStep(config, session.current_step) ?? null) : null),
    [config, session],
  );

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    let cancelled = false;

    const start = async (): Promise<void> => {
      const launch = readLaunchParams();
      try {
        const existing = launch.reset ? null : readStoredSessionId();

        if (existing) {
          try {
            const restored = await api.getSession(existing);
            if (!cancelled) {
              setBoot(restored);
              setStatus('ready');
            }
            return;
          } catch (err) {
            // Unknown session (fresh database, cleared data): fall through and
            // start a new one rather than dead-ending the visitor.
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
            clearStoredSessionId();
          }
        }

        const created = await api.createSession({
          utm_source: launch.utm_source,
          utm_medium: launch.utm_medium,
          utm_campaign: launch.utm_campaign,
          utm_content: launch.utm_content,
          utm_term: launch.utm_term,
          variant: launch.variant,
        });
        storeSessionId(created.session.session_id);
        stripResetParam();
        if (!cancelled) {
          setBoot(created);
          setStatus('ready');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ----------------------------------------------------- step_viewed + nav */

  useEffect(() => {
    if (!session || !step) return;

    // One `step_viewed` per entry into a step. Re-entering after Back emits a
    // second one on purpose: the dashboard counts unique sessions, so repeat
    // views are visible as a metric without inflating the funnel.
    const key = `${session.current_step}`;
    const isRepeat = viewedRef.current.has(key);
    viewedRef.current.add(key);
    const seq = nextSeq();

    eventQueue.push({
      event_id: `${session.session_id}:${step.id}:view:${seq}`,
      session_id: session.session_id,
      event_type: 'step_viewed',
      client_ts: new Date().toISOString(),
      step_id: step.id,
      props: { seq, repeat: isRepeat, variant: session.variant, funnel_version: session.funnel_version },
    });

    if (step.type === 'result') {
      eventQueue.push({
        event_id: `${session.session_id}:${step.id}:result:${seq}`,
        session_id: session.session_id,
        event_type: 'result_viewed',
        client_ts: new Date().toISOString(),
        step_id: step.id,
        props: { seq },
      });
      void api
        .result(session.session_id)
        .then(setResult)
        .catch(() => setResult(null));
    } else {
      setResult(null);
    }

    // Seed the editor with whatever is already stored for this step, so Back
    // shows the previous choice instead of an empty form.
    const field = 'field' in step ? ((step as { field?: string }).field ?? null) : null;
    const stored = field ? session.answers[field] : undefined;
    setDraft(stored === undefined ? (step.type === 'multi_select' ? [] : null) : (stored as AnswerValue));
    setValidationError(null);
  }, [session?.current_step, session?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------- browser back button */

  const goBack = useCallback(async (): Promise<void> => {
    if (!session || busy) return;
    setBusy(true);
    try {
      const seq = nextSeq();
      const updated = await api.back(session.session_id, {
        event_id: `${session.session_id}:${session.current_step}:back:${seq}`,
        client_ts: new Date().toISOString(),
      });
      setBoot(updated);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [session, busy]);

  useEffect(() => {
    if (!session) return;
    // Each step gets its own history entry, so the browser's Back button steps
    // through the funnel instead of leaving the page — and the state it returns
    // to comes from the server, not from the browser's cache.
    const state = window.history.state as { funnelStep?: string } | null;
    if (state?.funnelStep !== session.current_step) {
      window.history.pushState({ funnelStep: session.current_step }, '', window.location.href);
    }
  }, [session?.current_step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPop = (): void => {
      void goBack();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [goBack]);

  /* ------------------------------------------------------------- submitting */

  const submit = useCallback(async (): Promise<void> => {
    if (!session || !step || busy) return;

    if (step.type !== 'info' && step.type !== 'result') {
      const verdict = validateAnswer(step, draft);
      if (!verdict.ok) {
        setValidationError(verdict.error ?? 'Проверьте ответ');
        return;
      }
    }

    setBusy(true);
    setValidationError(null);
    const seq = nextSeq();

    try {
      // Flush pending views first so the batch ordering in the store reflects
      // what the user did, even though the aggregates do not depend on it.
      void eventQueue.flush();

      const updated = await api.answer(session.session_id, {
        step_id: step.id,
        value: step.type === 'info' ? null : draft,
        client_ts: new Date().toISOString(),
        event_ids: {
          answer: `${session.session_id}:${step.id}:answer:${seq}`,
          completed: `${session.session_id}:${step.id}:completed:${seq}`,
        },
      });
      setBoot(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setValidationError(err.message);
      else setValidationError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [session, step, draft, busy]);

  const onCta = useCallback(
    (kind: 'primary' | 'secondary'): void => {
      if (!session || !step) return;
      eventQueue.push({
        event_id: `${session.session_id}:${step.id}:cta:${kind}:${nextSeq()}`,
        session_id: session.session_id,
        event_type: 'cta_clicked',
        client_ts: new Date().toISOString(),
        step_id: step.id,
        props: { cta: kind, outcome_id: result?.outcome.id ?? null },
      });
      void eventQueue.flush();
    },
    [session, step, result],
  );

  const onHintExpanded = useCallback((): void => {
    if (!session || !step) return;
    eventQueue.push({
      event_id: `${session.session_id}:${step.id}:hint:${nextSeq()}`,
      session_id: session.session_id,
      event_type: 'hint_expanded',
      client_ts: new Date().toISOString(),
      step_id: step.id,
      props: {},
    });
  }, [session, step]);

  const restart = useCallback((): void => {
    clearStoredSessionId();
    const url = new URL(window.location.href);
    url.searchParams.set('reset', '1');
    window.location.replace(url.toString());
  }, []);

  /* ---------------------------------------------------------------- render */

  if (status === 'loading') {
    return (
      <main className="shell">
        <div className="card card--center">
          <div className="spinner" aria-label="Загрузка" />
          <p className="muted">Загружаем воронку…</p>
        </div>
      </main>
    );
  }

  if (status === 'error' || !boot || !session || !config || !step) {
    return (
      <main className="shell">
        <div className="card">
          <h1 className="h1">Не удалось загрузить воронку</h1>
          <p className="muted">{error ?? 'Неизвестная ошибка'}</p>
          <p className="muted small">
            Если база пустая, опубликуйте версию на{' '}
            <a href="#/admin">внутренней странице управления</a>.
          </p>
          <button className="btn btn--primary" type="button" onClick={() => window.location.reload()}>
            Повторить
          </button>
        </div>
      </main>
    );
  }

  const accent = config.theme?.accent ?? '#4f46e5';
  const canGoBack = session.history.indexOf(session.current_step) > 0 || session.history.length > 1;

  return (
    <main className="shell" style={{ '--accent': accent } as React.CSSProperties}>
      <div className="funnel">
        <header className="funnel__head">
          <div className="funnel__title">
            <span className="chip chip--soft">{config.name}</span>
          </div>
          <ProgressBar progress={boot.progress} />
        </header>

        {boot.version_is_stale && (
          <div className="notice notice--info">
            Сессия продолжается на версии <b>{session.funnel_version}</b>, хотя активна уже{' '}
            <b>{boot.active_version}</b>. Так и задумано: версия закреплена за сессией.{' '}
            <button className="link" type="button" onClick={restart}>
              Начать заново на активной версии
            </button>
          </div>
        )}

        <div className="card card--step" key={step.id}>
          {step.type === 'result' ? (
            <ResultScreen
              step={step}
              payload={result}
              onCta={onCta}
              onBack={canGoBack ? goBack : null}
              onRestart={restart}
              onHintExpanded={onHintExpanded}
            />
          ) : (
            <StepRenderer
              step={step}
              value={draft}
              onChange={(v) => {
                setDraft(v);
                setValidationError(null);
              }}
              onSubmit={submit}
              onBack={canGoBack ? goBack : null}
              onHintExpanded={onHintExpanded}
              busy={busy}
              error={validationError}
            />
          )}
        </div>

        <SessionBadge boot={boot} />
      </div>
    </main>
  );
}
