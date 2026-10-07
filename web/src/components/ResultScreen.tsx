import type { ResultStep } from '@funnel/shared';
import type { ResultPayload } from '../lib/api.js';
import { Hint } from './Hint.js';

interface Props {
  step: ResultStep;
  payload: ResultPayload | null;
  onCta: (kind: 'primary' | 'secondary') => void;
  onBack: (() => void) | null;
  onRestart: () => void;
  onHintExpanded: () => void;
}

/**
 * The outcome text comes from the server (`/api/session/:id/result`), because
 * the rules that pick it read the raw answers, and those never leave the server.
 */
export function ResultScreen({
  step,
  payload,
  onCta,
  onBack,
  onRestart,
  onHintExpanded,
}: Props): JSX.Element {
  const outcome = payload?.outcome;

  return (
    <div className="result">
      <div className="result__badge">Результат подбора</div>
      <h1 className="h1">{outcome?.headline ?? step.title}</h1>

      {outcome ? (
        <>
          <div className="prose">
            {outcome.body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>

          {outcome.highlights && outcome.highlights.length > 0 && (
            <dl className="highlights">
              {outcome.highlights.map((h) => (
                <div className="highlights__row" key={h.label}>
                  <dt>{h.label}</dt>
                  <dd>{h.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : (
        <p className="muted">Собираем рекомендацию…</p>
      )}

      {step.hint && <Hint text={step.hint} onExpanded={onHintExpanded} />}

      <div className="step__actions step__actions--result">
        <a
          className="btn btn--primary btn--lg"
          href={payload?.cta_href ?? step.ctaHref}
          onClick={() => onCta('primary')}
        >
          {payload?.cta_label ?? step.ctaLabel}
        </a>
        {(payload?.secondary_cta_label ?? step.secondaryCtaLabel) && (
          <button className="btn btn--ghost" type="button" onClick={() => onCta('secondary')}>
            {payload?.secondary_cta_label ?? step.secondaryCtaLabel}
          </button>
        )}
      </div>

      <div className="result__foot">
        {onBack && (
          <button className="link" type="button" onClick={onBack}>
            Изменить ответы
          </button>
        )}
        <button className="link" type="button" onClick={onRestart}>
          Пройти заново
        </button>
      </div>
    </div>
  );
}
