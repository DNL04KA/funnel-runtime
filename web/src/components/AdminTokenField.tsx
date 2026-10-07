import { useState } from 'react';
import { getAdminToken, setAdminToken } from '../lib/api.js';

/** Only needed when the server runs with ADMIN_TOKEN set. */
export function AdminTokenField({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [value, setValue] = useState(getAdminToken());
  const [saved, setSaved] = useState(false);

  return (
    <details className="panel panel--muted">
      <summary>Доступ к панели (x-admin-token)</summary>
      <p className="muted small">
        Если сервер запущен без переменной <code>ADMIN_TOKEN</code>, панель открыта и токен не нужен.
      </p>
      <div className="token-row">
        <input
          className="input"
          type="password"
          placeholder="admin token"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        <button
          className="btn btn--sm"
          type="button"
          onClick={() => {
            setAdminToken(value.trim());
            setSaved(true);
            onSaved();
          }}
        >
          Сохранить
        </button>
        {saved && <span className="muted small">сохранено</span>}
      </div>
    </details>
  );
}
