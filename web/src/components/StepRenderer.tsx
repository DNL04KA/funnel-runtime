import type {
  AnswerValue,
  FunnelStep,
  InfoStep,
  MultiSelectStep,
  NumberStep,
  SingleSelectStep,
} from '@funnel/shared';
import { Hint } from './Hint.js';

interface Props {
  step: FunnelStep;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  onSubmit: () => void;
  onBack: (() => void) | null;
  onHintExpanded: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * Dispatches on `step.type`. This is the only place in the app that knows what a
 * step *type* looks like; no component here knows what any particular screen is.
 */
export function StepRenderer(props: Props): JSX.Element {
  const { step, onSubmit, onBack, busy, error, onHintExpanded } = props;

  const submitLabel =
    step.type === 'info' ? (step as InfoStep).ctaLabel : 'Продолжить';

  return (
    <form
      className="step"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="step__head">
        <h1 className="h1">{step.title}</h1>
        {step.subtitle && <p className="muted">{step.subtitle}</p>}
      </div>

      <div className="step__body">
        {step.type === 'info' && <InfoBody step={step as InfoStep} />}
        {step.type === 'single_select' && (
          <SingleSelect step={step as SingleSelectStep} value={props.value} onChange={props.onChange} />
        )}
        {step.type === 'multi_select' && (
          <MultiSelect step={step as MultiSelectStep} value={props.value} onChange={props.onChange} />
        )}
        {step.type === 'number' && (
          <NumberInput step={step as NumberStep} value={props.value} onChange={props.onChange} />
        )}
      </div>

      {step.hint && <Hint text={step.hint} onExpanded={onHintExpanded} />}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="step__actions">
        {onBack && (
          <button className="btn btn--ghost" type="button" onClick={onBack} disabled={busy}>
            Назад
          </button>
        )}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function InfoBody({ step }: { step: InfoStep }): JSX.Element {
  return (
    <div className="prose">
      {step.body.map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </div>
  );
}

function SingleSelect({
  step,
  value,
  onChange,
}: {
  step: SingleSelectStep;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
}): JSX.Element {
  const selected = typeof value === 'string' ? value : null;
  return (
    <div className="options" role="radiogroup" aria-label={step.title}>
      {step.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={selected === option.value}
          className={`option ${selected === option.value ? 'option--on' : ''}`}
          onClick={() => onChange(option.value)}
        >
          <span className="option__mark option__mark--radio" aria-hidden="true" />
          <span className="option__text">
            <span className="option__label">{option.label}</span>
            {option.hint && <span className="option__hint">{option.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

function MultiSelect({
  step,
  value,
  onChange,
}: {
  step: MultiSelectStep;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
}): JSX.Element {
  const selected = Array.isArray(value) ? value : [];
  const max = step.maxSelected ?? step.options.length;

  const toggle = (optionValue: string): void => {
    if (selected.includes(optionValue)) {
      onChange(selected.filter((v) => v !== optionValue));
      return;
    }
    // At the cap, the oldest pick drops out — less annoying than a hard block.
    const next = selected.length >= max ? [...selected.slice(1), optionValue] : [...selected, optionValue];
    onChange(next);
  };

  return (
    <>
      <div className="options">
        {step.options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={`option ${on ? 'option--on' : ''}`}
              onClick={() => toggle(option.value)}
            >
              <span className="option__mark option__mark--check" aria-hidden="true" />
              <span className="option__text">
                <span className="option__label">{option.label}</span>
                {option.hint && <span className="option__hint">{option.hint}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <p className="muted small">
        Выбрано {selected.length} из {max}
      </p>
    </>
  );
}

function NumberInput({
  step,
  value,
  onChange,
}: {
  step: NumberStep;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
}): JSX.Element {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return (
    <div className="number">
      <div className="number__row">
        <input
          className="input"
          type="number"
          inputMode="numeric"
          value={raw}
          min={step.min}
          max={step.max}
          step={step.stepSize ?? 1}
          placeholder={step.placeholder ?? ''}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next === '' ? null : Number(next));
          }}
          autoFocus
        />
        {step.unit && <span className="number__unit">{step.unit}</span>}
      </div>
      {(step.min !== undefined || step.max !== undefined) && (
        <p className="muted small">
          Допустимый диапазон: {step.min ?? '—'} … {step.max ?? '—'} {step.unit ?? ''}
        </p>
      )}
    </div>
  );
}
