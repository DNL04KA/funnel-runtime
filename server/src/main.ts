import { createApp } from './http/app.js';
import { openDatabase } from './db/index.js';
import {
  DB_PATH, DEMO_MODE, DEMO_SEED_SESSIONS, FUNNEL_ID, HOST,
  KEEPALIVE_INTERVAL_MS, KEEPALIVE_URL, PORT,
} from './env.js';
import { startKeepalive } from './keepalive.js';
import { getActiveVersionNumber } from './domain/versions.js';
import { seedDemoTrafficIfEmpty, seedVersionsIfEmpty } from './domain/bootstrap.js';

const db = openDatabase();

// На свежем деплое версий нет вообще, и любая публичная страница отвечала бы
// 503. Посев конфигов при первом старте делает задеплоенный URL
// самодостаточным — ручных шагов после деплоя не требуется.
seedVersionsIfEmpty(db);

const app = createApp(db, { funnelId: FUNNEL_ID });

let keepaliveHandle: { stop: () => void } | null = null;

const server = app.listen(PORT, HOST, () => {
  console.log(`[funnel-runtime] http://${HOST}:${PORT}`);
  console.log(
    `[funnel-runtime] db=${DB_PATH} funnel=${FUNNEL_ID} ` +
      `active_version=${getActiveVersionNumber(db, FUNNEL_ID) ?? '—'}` +
      (DEMO_MODE ? ` demo_seed=${DEMO_SEED_SESSIONS}` : ''),
  );

  // Самопинг: бесплатный инстанс засыпает после 15 минут без входящих
  // запросов, а внешнее расписание GitHub Actions на деле приходит раз в
  // несколько часов — см. комментарий в keepalive.ts.
  const keepalive = startKeepalive({
    url: KEEPALIVE_URL,
    intervalMs: KEEPALIVE_INTERVAL_MS,
    onLog: (m) => console.log(`[funnel-runtime] ${m}`),
  });
  if (keepalive) {
    const every =
      KEEPALIVE_INTERVAL_MS >= 60_000
        ? `${Math.round(KEEPALIVE_INTERVAL_MS / 60_000)} мин`
        : `${Math.round(KEEPALIVE_INTERVAL_MS / 1000)} с`;
    console.log(`[funnel-runtime] самопинг каждые ${every} → ${KEEPALIVE_URL}`);
    keepaliveHandle = keepalive;
  }

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
    keepaliveHandle?.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
