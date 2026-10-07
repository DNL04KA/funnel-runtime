import { openDatabase } from '../db/index.js';
import { FUNNEL_ID } from '../env.js';
import { seedVersions } from '../domain/bootstrap.js';
import { getActiveVersionNumber, listVersions } from '../domain/versions.js';

const db = openDatabase();
const existing = (db.prepare('SELECT COUNT(*) AS n FROM funnel_versions').get() as { n: number }).n;

if (existing > 0) {
  console.log(`В базе уже ${existing} ${existing === 1 ? 'версия' : 'версий'}, повторная загрузка не нужна.`);
} else {
  const result = seedVersions(db);
  for (const row of result.published) {
    console.log(`  v${row.version}  ←  ${row.file}${row.activated ? '  [активна]' : ''}`);
  }
}

console.log(`\nАктивная версия: ${getActiveVersionNumber(db, FUNNEL_ID) ?? '—'}`);
for (const v of listVersions(db, FUNNEL_ID)) {
  console.log(`  v${v.version}  ${v.is_active ? '●' : '○'}  ${v.name}`);
}
db.close();
