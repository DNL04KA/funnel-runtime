import type { ConfigIssue } from '@funnel/shared';

export function IssueList({ issues }: { issues: ConfigIssue[] }): JSX.Element | null {
  if (issues.length === 0) return <p className="muted small">Валидация пройдена без замечаний.</p>;
  return (
    <ul className="issues">
      {issues.map((issue, i) => (
        <li key={i} className={`issue issue--${issue.level}`}>
          <span className="issue__level">{issue.level === 'error' ? 'ошибка' : 'предупреждение'}</span>
          {issue.stepId && <code className="issue__step">{issue.stepId}</code>}
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}
