import { createApp } from './http/app.js';
import { openDatabase } from './db/index.js';
import { DB_PATH, DEMO_MODE, DEMO_SEED_SESSIONS, FUNNEL_ID, HOST, PORT } from './env.js';
import { getActiveVersionNumber } from './domain/versions.js';
import { seedDemoTrafficIfEmpty, seedVersionsIfEmpty } from './domain/bootstrap.js';

const db = openDatabase();

// На свежем деплое версий нет вообще, и любая публичная страница отвечала бы
// 503. Посев конфигов при первом старте делает задеплоенный URL
// самодостаточным — ручных шагов после деплоя не требуется.
seedVersionsIfEmpty(db);

const app = createApp(db, { funnelId: FUNNEL_ID });

const server = app.listen(PORT, HOST, () => {
  console.log(`[funnel-runtime] http://${HOST}:${PORT}`);
  console.log(
    `[funnel-runtime] db=${DB_PATH} funnel=${FUNNEL_ID} ` +
      `active_version=${getActiveVersionNumber(db, FUNNEL_ID) ?? '—'}` +
      (DEMO_MODE ? ` demo_seed=${DEMO_SEED_SESSIONS}` : ''),
  );

  if (!DEMO_MODE) return;

  // Посев идёт после listen и не блокирует порт: страница отвечает сразу, а
  // дашборд наполняется через несколько секунд. Ходит по HTTP в самого себя,
  // чтобы данные прошли тот же путь, что и настоящий трафик.
  const started = Date.now();
  void seedDemoTrafficIfEmpty(db, {
    baseUrl: `http://127.0.0.1:${PORT}`,
    funnelId: FUNNEL_ID,
    sessions: DEMO_SEED_SESSIONS,
  })
    .then((seeded) => {
      if (seeded) {
        console.log(
          `[funnel-runtime] демо-данные готовы: ${DEMO_SEED_SESSIONS} сессий ` +
            `за ${((Date.now() - started) / 1000).toFixed(1)} с`,
        );
      }
    })
    .catch((err) => {
      // Стенд без данных всё ещё работоспособен — падать из-за посева нельзя.
      console.error('[funnel-runtime] не удалось засеять демо-данные:', err);
    });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
