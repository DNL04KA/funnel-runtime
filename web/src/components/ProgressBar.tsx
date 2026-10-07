import type { ProgressInfo } from '@funnel/shared';

/** Counts only the steps this session can actually reach (see computeProgress). */
export function ProgressBar({ progress }: { progress: ProgressInfo }): JSX.Element {
  return (
    <div className="progress" role="group" aria-label="Прогресс">
      <div className="progress__bar">
        <div className="progress__fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="progress__label">
        Шаг {progress.index} из {progress.total}
      </div>
    </div>
  );
}
