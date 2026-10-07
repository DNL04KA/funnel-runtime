import { createApp } from './http/app.js';
import { openDatabase } from './db/index.js';
import { DB_PATH, FUNNEL_ID, HOST, PORT } from './env.js';
import { getActiveVersionNumber } from './domain/versions.js';
import { seedVersionsIfEmpty } from './domain/bootstrap.js';

const db = openDatabase();

// A fresh deployment has no versions at all, which would make every public page
// return 503. Seeding the bundled configs on first boot keeps the public URL
// self-sufficient without a manual step after deploy.
seedVersionsIfEmpty(db);

const app = createApp(db, { funnelId: FUNNEL_ID });

const server = app.listen(PORT, HOST, () => {
  const active = getActiveVersionNumber(db, FUNNEL_ID);
  console.log(`[funnel-runtime] http://${HOST}:${PORT}`);
  console.log(`[funnel-runtime] db=${DB_PATH} funnel=${FUNNEL_ID} active_version=${active ?? '—'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
