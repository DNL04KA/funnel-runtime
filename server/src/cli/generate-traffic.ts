/**
 * Команда генерации синтетического трафика.
 *
 * Без `--url` поднимает настоящее Express-приложение на свободном порту и
 * ходит в него — одна команда, запущенный сервер не нужен. С `--url` работает
 * против уже поднятого, в том числе задеплоенного.
 *
 *   npm run seed:traffic
 *   npm run seed:traffic -- --sessions 250 --seed 7
 *   npm run seed:traffic -- --url https://example.com
 */
import type { Server } from 'node:http';
import { createApp } from '../http/app.js';
import { openDatabase, type Db } from '../db/index.js';
import { ADMIN_TOKEN, FUNNEL_ID } from '../env.js';
import { seedVersionsIfEmpty } from '../domain/bootstrap.js';
import { activateVersion, getActiveVersionNumber, listVersions } from '../domain/versions.js';
import { emptyStats, generateTraffic, makeApi, type Stats } from '../domain/traffic.js';

interface Options {
  sessions: number;
  seed: number;
  url: string | null;
  versions: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    sessions: Number(get('sessions') ?? 140),
    seed: Number(get('seed') ?? 20261007),
    url: get('url') ?? null,
    versions: Number(get('versions') ?? 2),
    quiet: argv.includes('--quiet'),
  };
}

function report(stats: Stats, log: (s: string) => void): void {
  log('\nИтого:');
  log(`  сессий создано          ${stats.sessions}`);
  log(`  по версиям              ${JSON.stringify(stats.by_version)}`);
  log(`  по вариантам            ${JSON.stringify(stats.by_variant)}`);
  log(`  дошли до результата     ${stats.reached_result}`);
  log(`  кликнули CTA            ${stats.cta_clicks}`);
  log(`  нажали «назад»          ${stats.back_clicks}`);
  log(`  раскрыли подсказку      ${stats.hint_expands}`);
  log('');
  log(`  батчей отправлено       ${stats.flushes}`);
  log(`  событий отправлено      ${stats.sent}`);
  log(`    принято               ${stats.accepted}`);
  log(`    отклонено как дубль   ${stats.duplicates}`);
  log(`    отклонено невалидных  ${stats.rejected}`);
  log('');
  log(`  повторных отправок батча ${stats.replayed_batches}`);
  log(`  дублей внутри батча      ${stats.in_batch_dupes}`);
  log(`  перемешанных батчей      ${stats.out_of_order_batches}`);
  log(`  невалидных подмешано     ${stats.invalid_injected}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const stats = emptyStats();
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(msg);
  };

  let db: Db | null = null;
  let server: Server | null = null;
  let baseUrl = opts.url;

  if (!baseUrl) {
    db = openDatabase();
    seedVersionsIfEmpty(db);
    const app = createApp(db, { serveStatic: false, funnelId: FUNNEL_ID });
    server = await new Promise<Server>((done) => {
      const s = app.listen(0, '127.0.0.1', () => done(s));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  log(`Генерация трафика → ${baseUrl}`);
  log(`  сессий: ${opts.sessions}, seed: ${opts.seed}`);

  const now = Date.now();

  if (db) {
    // Локальный режим: раскладываем трафик по последним версиям, временно
    // переключая активную. Попутно это проверяет главный инвариант — сессии,
    // начатые на старой версии, на ней и остаются.
    const original = getActiveVersionNumber(db, FUNNEL_ID);
    const spread = listVersions(db, FUNNEL_ID)
      .map((v) => v.version)
      .sort((a, b) => a - b)
      .slice(-Math.max(1, opts.versions));
    const perVersion = Math.ceil(opts.sessions / spread.length);
    let produced = 0;

    for (const [i, version] of spread.entries()) {
      if (getActiveVersionNumber(db, FUNNEL_ID) !== version) {
        activateVersion(db, FUNNEL_ID, version, 'generator', 'наполнение трафиком');
      }
      const target = Math.min(perVersion, opts.sessions - produced);
      if (target <= 0) break;
      await generateTraffic({ baseUrl, sessions: target, seed: opts.seed + i, now, stats });
      produced += target;
      log(`  версия ${version}: ${target} сессий`);
    }

    if (original !== null && getActiveVersionNumber(db, FUNNEL_ID) !== original) {
      activateVersion(db, FUNNEL_ID, original, 'generator', 'восстановление активной версии');
    }
  } else {
    // Удалённый режим: переключать чужие версии командой нельзя, льём на активную.
    await generateTraffic({
      baseUrl,
      sessions: opts.sessions,
      seed: opts.seed,
      adminToken: ADMIN_TOKEN,
      now,
      stats,
    });
  }

  report(stats, log);

  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (db) {
    log(`\nАктивная версия: ${getActiveVersionNumber(db, FUNNEL_ID)}`);
    db.close();
  }
  log('\nГотово. Откройте /admin/analytics.');
}

export { makeApi };

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
