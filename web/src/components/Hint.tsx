import { useState } from 'react';

/** Collapsible hint. Expanding it emits `hint_expanded` (new in config v3). */
export function Hint({ text, onExpanded }: { text: string; onExpanded: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="hint">
      <button
        className="hint__toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onExpanded();
        }}
      >
        <span className="hint__icon">{open ? '−' : '+'}</span>
        Подробнее
      </button>
      {open && <p className="hint__body">{text}</p>}
    </div>
  );
}
