/**
 * Ролик по проекту Funnel Runtime.
 * Всё, что видно на экране приложения, — настоящий прогон через настоящий
 * Chrome по HTTP. Карточки между сценами — слой поверх той же страницы.
 */
import { chromium } from 'playwright';
import {
  BASE, beat, cap, capOff, card, click, hideCard, installStage, smoothScroll, type,
} from './stage.mjs';

const W = 1280;
const H = 720;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: './reel-video', size: { width: W, height: H } },
  colorScheme: 'light',
  locale: 'ru-RU',
  reducedMotion: 'no-preference',
});
const page = await ctx.newPage();
await installStage(page);

const code = (label, body) =>
  `<div><div class="pre-label">${label}</div><pre>${body}</pre></div>`;

/* ═══════════════════════════ 00 · Титры ═══════════════════════════ */

await page.goto(`${BASE}/?reset=1&variant=A&utm_source=reel&utm_campaign=reel_demo`, {
  waitUntil: 'networkidle',
});
await card(page, {
  big: true,
  kicker: 'Тестовое задание · Fullstack',
  title: 'Funnel Runtime',
  sub: 'Конфигурируемые воронки, A/B-эксперименты, собственный приём событий, аналитика по уникальным сессиям и откат версий без потери данных.',
  html: `<div class="chips">
    <span>TypeScript</span><span>React + Vite</span><span>Node + Express</span>
    <span>SQLite</span><span>54 теста</span><span>один репозиторий</span>
  </div>`,
  hold: 3400,
});

/* ════════════════════ 01 · Воронка приходит JSON'ом ═══════════════ */

await card(page, {
  kicker: '01 — Динамическая воронка',
  title: 'Во фронтенде нет ни одного экрана',
  sub: 'Шаги, переходы и валидация описаны конфигом. Добавить экран — поправить JSON, передеплой не нужен.',
  html: code(
    'configs/funnel.v2.json',
    `<span class="c">// ветвление задаётся данными, а не кодом</span>
{ <span class="k">"id"</span>: <span class="s">"role"</span>, <span class="k">"type"</span>: <span class="s">"single_select"</span>, <span class="k">"field"</span>: <span class="s">"role"</span>,
  <span class="k">"next"</span>: [
    { <span class="k">"if"</span>: { <span class="k">"field"</span>: <span class="s">"role"</span>, <span class="k">"op"</span>: <span class="s">"eq"</span>, <span class="k">"value"</span>: <span class="s">"it"</span> },
      <span class="k">"goto"</span>: <span class="hi">"integrations"</span> },
    { <span class="k">"goto"</span>: <span class="hi">"warehouses"</span> }          <span class="c">// безусловная ветка</span>
  ] }`,
  ),
  hold: 4200,
});
await hideCard(page);

await cap(page, 'Вариант зафиксирован: ?variant=A', 'Штатный override из задания — чтобы прогон был воспроизводим', '01 · Воронка');
await beat(page, 1100);
await click(page, 'button:has-text("Начать подбор")');
await cap(page, 'Ответ решает, куда идти дальше', 'Выбираем ИТ-роль — сработает первое правило перехода', '01 · Воронка');
await beat(page, 800);
await click(page, 'button:has-text("ИТ-директор")', { after: 300 });
await click(page, 'button:has-text("Продолжить")');
await cap(page, 'Ветка интеграций', 'Бизнес-роль увела бы на вопрос о складах — это другой экран', '01 · Воронка');
await beat(page, 1500);

await cap(page, 'Валидация', 'Минимум один вариант — правило из конфига, проверяется и на сервере', '01 · Воронка');
await click(page, 'button:has-text("Продолжить")');
await beat(page, 1500);
await click(page, 'button:has-text("ERP / учётная система")', { after: 220 });
await click(page, 'button:has-text("Собственная legacy-система")', { after: 220 });
await click(page, 'button:has-text("Продолжить")');
await beat(page, 600);

/* ════════════════════ 02 · Прогресс и вторая ветка ════════════════ */

await capOff(page);
await card(page, {
  kicker: '02 — Прогресс и ветвление',
  title: 'Прогресс считает только доступные шаги',
  sub: 'Знаменатель — не длина конфига, а путь, который реально предстоит этой сессии. Уйдёт в другую ветку — пересчитается.',
  hold: 2600,
});
await hideCard(page);

await cap(page, 'Сейчас «Шаг 4 из 6»', 'Ответ «более 50 000» откроет ветку с бюджетом', '02 · Прогресс');
await beat(page, 1700);
await click(page, 'button:has-text("Более 50 000")', { after: 260 });
await click(page, 'button:has-text("Продолжить")');
await cap(page, 'Стало «Шаг 5 из 7»', 'Появился экран бюджета — он есть только на этой ветке', '02 · Прогресс');
await beat(page, 2000);

/* ════════════════════ 03 · Состояние не теряется ══════════════════ */

await capOff(page);
await card(page, {
  kicker: '03 — Состояние',
  title: 'Back, refresh и повторное открытие',
  sub: 'Источник правды — сессия на сервере. В браузере лежит только session_id, поэтому состояние переживает что угодно.',
  hold: 2500,
});
await hideCard(page);

await cap(page, 'Сейчас будет полная перезагрузка', 'F5 на середине воронки', '03 · Состояние');
await beat(page, 1300);
await page.reload({ waitUntil: 'networkidle' });
await cap(page, 'Тот же шаг, те же ответы', 'URL потерял параметры — сессия восстановилась по session_id', '03 · Состояние');
await beat(page, 2200);

await cap(page, 'Кнопка «Назад»', 'Возвращаемся на шаг назад — выбранный ответ на месте', '03 · Состояние');
await click(page, 'button:has-text("Назад")');
await beat(page, 1800);
await click(page, 'button:has-text("Продолжить")', { after: 500 });

await type(page, 'input[type="number"]', '12000000');
await click(page, 'button:has-text("Продолжить")', { after: 500 });
await click(page, 'button:has-text("Оптимизация сборки заказов")', { after: 200 });
await click(page, 'button:has-text("Аналитика и отчётность")', { after: 200 });
await click(page, 'button:has-text("Продолжить")');
await cap(page, 'Экран результата', 'Исход выбирают правила конфига: они читают сырые ответы на сервере, наружу уходит только текст', '03 · Состояние');
await beat(page, 2600);

/* ════════════════ 04 · Версии: публикация без передеплоя ══════════ */

await capOff(page);
await card(page, {
  kicker: '04 — Версии',
  title: 'Публикация без передеплоя',
  sub: 'Конфиги лежат в базе, а не в бандле. Публикация добавляет версию, включение переставляет указатель.',
  html: `<ul class="bullets">
    <li>Вторая итерация: новая условная ветка, у варианта B удалён экран, добавлено событие <code>hint_expanded</code></li>
    <li>Ни миграции схемы, ни рестарта процесса</li>
  </ul>`,
  hold: 3200,
});
await hideCard(page);

await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle' });
await beat(page, 700);
await cap(page, 'Внутренняя страница управления', 'Активна v2. Рядом — конфиги из репозитория, готовые к публикации', '04 · Версии');
await beat(page, 1900);
await smoothScroll(page, 300);
await cap(page, 'Публикуем вторую итерацию', 'Каждый конфиг проходит валидацию, включая резолв по вариантам', '04 · Версии');
await beat(page, 1500);

const v3Card = page.locator('.lib', { hasText: 'funnel.v3.json' });
await click(page, v3Card.locator('button:has-text("Опубликовать и включить")'), { after: 1300 });
await smoothScroll(page, -300);
await cap(page, 'v3 опубликована и включена', 'Схема базы не изменилась', '04 · Версии');
await beat(page, 2100);

/* ═══════════ 05 · Версия закреплена за сессией ════════════════════ */

await capOff(page);
await card(page, {
  kicker: '05 — Закрепление версии',
  title: 'Старая сессия остаётся на своей версии',
  sub: 'Версия пишется в сессию при создании. Всё дальше — конфиг, переходы, события, бакет в аналитике — читает это поле, а не живой указатель.',
  hold: 2800,
});
await hideCard(page);

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await cap(page, 'Та же вкладка, что мы прошли', 'Активна уже v3, но сессия продолжается на v2 — так и задумано', '05 · Закрепление');
await beat(page, 2700);

await page.goto(`${BASE}/?reset=1&variant=B&utm_campaign=reel_demo`, { waitUntil: 'networkidle' });
await cap(page, 'Новая сессия — уже v3, вариант B', 'Новые сессии стартуют только на активной версии', '05 · Закрепление');
await beat(page, 1900);
await click(page, 'button:has-text("Начать подбор")', { after: 300 });
await click(page, 'button:has-text("Руководитель склада")', { after: 220 });
await click(page, 'button:has-text("Продолжить")');
await cap(page, 'У варианта B нет экрана о складах', 'removeSteps: ["warehouses"] — входящие переходы перевязаны автоматически', '05 · Закрепление');
await beat(page, 2500);

await click(page, 'button:has-text("Оптимизация сборки заказов")', { after: 200 });
await click(page, 'button:has-text("Инвентаризация и остатки")', { after: 200 });
await click(page, 'button:has-text("Продолжить")', { after: 450 });
await click(page, 'button:has-text("Более 50 000")', { after: 220 });
await click(page, 'button:has-text("Продолжить")', { after: 450 });
await type(page, 'input[type="number"]', '20000000');
await click(page, 'button:has-text("Продолжить")');
await cap(page, 'Новая ветка второй итерации', 'Экран регламента — только при enterprise-потоке или legacy-интеграции', '05 · Закрепление');
await beat(page, 2500);

/* ════════════════════════ 06 · События ════════════════════════════ */

await capOff(page);
await card(page, {
  kicker: '06 — Событийная система',
  title: 'Повторная пачка ничего не ломает',
  sub: 'event_id — первичный ключ. Ретрай после timeout схлопывается, битое событие не забирает с собой остальную пачку.',
  html: `<div class="cols">${code(
    'POST /api/events — первая отправка',
    `{
  <span class="k">"received"</span>: <span class="n">3</span>,
  <span class="k">"accepted"</span>: <span class="ok">2</span>,
  <span class="k">"duplicates"</span>: <span class="n">0</span>,
  <span class="k">"rejected"</span>: <span class="bad">1</span>
}
<span class="c">// отклонено: неизвестный
// event_type "teleported"</span>`,
  )}${code(
    'тот же запрос ещё раз',
    `{
  <span class="k">"received"</span>: <span class="n">3</span>,
  <span class="k">"accepted"</span>: <span class="ok">0</span>,
  <span class="k">"duplicates"</span>: <span class="hi">2</span>,
  <span class="k">"rejected"</span>: <span class="bad">1</span>
}
<span class="c">// в базе ничего
// не изменилось</span>`,
  )}</div>`,
  hold: 4600,
});

/* ═════════════════════════ 07 · Откат ═════════════════════════════ */

await card(page, {
  kicker: '07 — Откат',
  title: 'Откат — это включение прежней версии',
  sub: 'Отдельной операции нет: версии только добавляются, ничего не удаляется. Поэтому аналитика откаченной версии остаётся на месте.',
  hold: 2700,
});
await hideCard(page);

await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle' });
await beat(page, 700);
await cap(page, 'Откатываемся на v2', 'Одна кнопка', '07 · Откат');
await beat(page, 1200);
await click(page, 'button:has-text("Откатить на v2")', { after: 1400 });
await cap(page, 'Готово', 'Сессии на v3 продолжают работать, их данные никуда не делись', '07 · Откат');
await beat(page, 1700);
await smoothScroll(page, 1450, 900);
await cap(page, 'Журнал версий', 'Публикация и откат записаны с переходом между версиями', '07 · Откат');
await beat(page, 2600);

/* ═══════════════════════ 08 · Аналитика ═══════════════════════════ */

await capOff(page);
await card(page, {
  kicker: '08 — Аналитика',
  title: 'Считаем сессии, а не события',
  sub: 'Каждый показатель — мощность множества сессий. Поэтому дубли, возвраты назад и события не по порядку на цифры не влияют.',
  hold: 2900,
});
await hideCard(page);

await page.goto(`${BASE}/#/admin/analytics`, { waitUntil: 'networkidle' });
await page.waitForSelector('.kpi', { timeout: 15000 });
await beat(page, 600);
await cap(page, 'Дашборд', 'Начавшие, конверсия в результат, CTR основного CTA', '08 · Аналитика');
await beat(page, 2100);

await smoothScroll(page, 400, 700);
await cap(page, 'Воронка по шагам', 'Конверсия шага, отвал и распределение по веткам', '08 · Аналитика');
await beat(page, 2600);

await smoothScroll(page, 500, 700);
await cap(page, 'Сравнение A/B', 'Дельта в процентных пунктах к варианту A', '08 · Аналитика');
await beat(page, 2400);

await smoothScroll(page, 400, 650);
await cap(page, 'Сравнение версий', 'Все три версии на месте — откат ничего не стёр', '08 · Аналитика');
await beat(page, 2400);

await smoothScroll(page, 540, 700);
await cap(page, 'Кампании', 'Фильтрация по utm_campaign', '08 · Аналитика');
await beat(page, 1900);

await smoothScroll(page, 520, 700);
await cap(page, 'Качество данных', 'Дубли подавлены, брак отклонён, часть событий пришла не по порядку — агрегаты не дрогнули', '08 · Аналитика');
await beat(page, 3000);

/* ═══════════════════════ 09 · Тесты ═══════════════════════════════ */

await capOff(page);
await card(page, {
  kicker: '09 — Проверки',
  title: '54 теста на настоящем приложении',
  sub: 'Поднимают реальный сервер на SQLite :memory: и ходят в него по HTTP. Моков нет.',
  html: code(
    'npm test',
    `<span class="ok">✓</span> tests/analytics.test.ts            <span class="c">(16 tests)</span>
<span class="ok">✓</span> tests/second-iteration.test.ts     <span class="c">( 9 tests)</span>
<span class="ok">✓</span> tests/versioning-rollback.test.ts  <span class="c">( 8 tests)</span>
<span class="ok">✓</span> tests/ab-stability.test.ts         <span class="c">( 8 tests)</span>
<span class="ok">✓</span> tests/event-dedup.test.ts          <span class="c">( 7 tests)</span>
<span class="ok">✓</span> tests/version-pinning.test.ts      <span class="c">( 6 tests)</span>

 Test Files  <span class="ok">6 passed</span> (6)
      Tests  <span class="ok">54 passed</span> (54)`,
  ),
  hold: 4300,
});

/* ════════════════════════ 10 · Финал ══════════════════════════════ */

await card(page, {
  big: true,
  kicker: 'Готово',
  title: 'Funnel Runtime',
  sub: 'Один репозиторий · fullstack TypeScript · SQLite · без сторонних сервисов',
  html: `<ul class="bullets">
    <li>Воронка целиком из конфига, состояние переживает back и refresh</li>
    <li>Версии, закрепление за сессией и откат без потери аналитики</li>
    <li>Идемпотентный приём событий пачками, агрегаты по уникальным сессиям</li>
    <li>Генератор синтетического трафика и 54 автотеста</li>
  </ul>`,
  hold: 4200,
});

await ctx.close();
await browser.close();
console.log('ролик записан');
