/**
 * Слой поверх приложения для ролика: полноэкранные карточки (титры, главы,
 * код) и нижняя строка подписи. Всё живёт в одном page-контексте и ставится
 * через addInitScript, поэтому переживает переходы между страницами без мигания.
 */

export const BASE = process.env.DEMO_BASE ?? 'http://localhost:8787';

export async function installStage(page) {
  if (page.__reelStage) return;
  page.__reelStage = true;

  await page.addInitScript(() => {
    const draw = () => {
      if (document.getElementById('reel-stage')) return;

      const css = document.createElement('style');
      css.textContent = `
        @keyframes reel-up { from { opacity:0; transform: translateY(14px) } to { opacity:1; transform:none } }

        #reel-stage {
          position: fixed; inset: 0; z-index: 2147483647;
          background: radial-gradient(130% 110% at 18% 0%, #161a24 0%, #0a0c11 58%, #07080c 100%);
          color: #f2f5fa;
          font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex; flex-direction: column; justify-content: center;
          padding: 0 92px; gap: 18px;
          opacity: 0; visibility: hidden;
          transition: opacity .42s cubic-bezier(.4,0,.2,1), visibility .42s;
        }
        #reel-stage.on { opacity: 1; visibility: visible; }
        #reel-stage.on > * { animation: reel-up .5s cubic-bezier(.22,1,.36,1) backwards; }
        #reel-stage.on > *:nth-child(2) { animation-delay: .07s }
        #reel-stage.on > *:nth-child(3) { animation-delay: .13s }
        #reel-stage.on > *:nth-child(4) { animation-delay: .19s }

        #reel-stage .kicker {
          font-size: 13px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
          color: #7c86f7; display: flex; align-items: center; gap: 12px;
        }
        #reel-stage .kicker::after { content:''; height:1px; flex:1; background: linear-gradient(90deg,#2a3150,transparent); }
        #reel-stage h1 { margin:0; font-size: 56px; line-height:1.04; letter-spacing:-.035em; font-weight: 680; }
        #reel-stage h2 { margin:0; font-size: 40px; line-height:1.1; letter-spacing:-.03em; font-weight: 660; }
        #reel-stage .sub { margin:0; font-size: 19px; color:#98a2b8; max-width: 860px; line-height:1.45; }
        #reel-stage .meta { font-size:14px; color:#5d677d; letter-spacing:.02em; }
        #reel-stage .cols { display:flex; gap:36px; align-items:flex-start; }
        #reel-stage .cols > * { flex:1; min-width:0; }

        #reel-stage pre {
          margin:0; padding: 20px 22px; border-radius: 12px;
          background: #0e1117; border:1px solid #1d2230;
          font: 400 13.5px/1.62 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          color:#c6cde0; overflow:hidden; white-space:pre;
          box-shadow: 0 24px 60px -30px rgba(0,0,0,.9);
        }
        #reel-stage pre .k { color:#8ab4ff }
        #reel-stage pre .s { color:#9ae6a4 }
        #reel-stage pre .n { color:#f0b36b }
        #reel-stage pre .c { color:#5a657d; font-style:italic }
        #reel-stage pre .ok { color:#4ade80 }
        #reel-stage pre .bad { color:#fb7185 }
        #reel-stage pre .hi { color:#fff; font-weight:600 }
        #reel-stage .pre-label {
          font-size:12px; letter-spacing:.08em; text-transform:uppercase;
          color:#5d677d; margin-bottom:9px; font-weight:600;
        }
        #reel-stage .bullets { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:12px; }
        #reel-stage .bullets li { display:flex; gap:12px; font-size:17px; color:#c3cad9; align-items:flex-start; }
        #reel-stage .bullets li::before {
          content:''; width:6px; height:6px; margin-top:9px; border-radius:50%;
          background:#6366f1; flex:none;
        }
        #reel-stage .chips { display:flex; gap:9px; flex-wrap:wrap; }
        #reel-stage .chips span {
          padding:6px 13px; border-radius:999px; border:1px solid #242a3a;
          background:#11141c; color:#9aa5bb; font-size:13.5px;
        }

        #reel-cap {
          position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;
          padding: 15px 26px 17px;
          background: linear-gradient(0deg, rgba(8,10,14,.975) 60%, rgba(8,10,14,.86));
          color:#fff; font: 500 15px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          border-top: 1px solid rgba(255,255,255,.1);
          display:flex; align-items:baseline; gap:14px;
          transform: translateY(104%); transition: transform .34s cubic-bezier(.4,0,.2,1);
        }
        #reel-cap.on { transform:none; }
        #reel-cap b { font-size:15.5px; font-weight:650; letter-spacing:-.01em; white-space:nowrap; }
        #reel-cap span { color:#99a3b7; font-size:13.5px; }
        #reel-cap i {
          margin-left:auto; font-style:normal; font-size:11.5px; color:#5d677d;
          letter-spacing:.1em; text-transform:uppercase; font-weight:600; white-space:nowrap;
        }
        body { scroll-padding-bottom: 110px; }

        .reel-ring {
          position: fixed; z-index: 2147483645; border: 2.5px solid #6366f1; border-radius: 10px;
          box-shadow: 0 0 0 4px rgba(99,102,241,.22); pointer-events:none;
          transition: opacity .16s; opacity:0;
        }
      `;
      document.head.appendChild(css);

      const stage = document.createElement('div');
      stage.id = 'reel-stage';
      document.body.appendChild(stage);

      const cap = document.createElement('div');
      cap.id = 'reel-cap';
      cap.innerHTML = '<b></b><span></span><i></i>';
      document.body.appendChild(cap);

      // Подпись переживает навигацию: без этого она пропадала бы на каждом
      // переходе между страницами приложения.
      try {
        const saved = JSON.parse(sessionStorage.getItem('reel-cap') || 'null');
        if (saved && saved[3]) {
          cap.querySelector('b').textContent = saved[0];
          cap.querySelector('span').textContent = saved[1];
          cap.querySelector('i').textContent = saved[2];
          requestAnimationFrame(() => cap.classList.add('on'));
        }
      } catch {}
    };

    if (document.body) draw();
    else document.addEventListener('DOMContentLoaded', draw, { once: true });
  });
}

/* ───────────────────────────── карточки ───────────────────────────── */

/** Показывает полноэкранную карточку. Вызывающий сам решает, когда скрыть. */
export async function card(page, spec) {
  await page.evaluate((s) => {
    const stage = document.getElementById('reel-stage');
    if (!stage) return;
    const parts = [];
    if (s.kicker) parts.push(`<div class="kicker">${s.kicker}</div>`);
    if (s.title) parts.push(s.big ? `<h1>${s.title}</h1>` : `<h2>${s.title}</h2>`);
    if (s.sub) parts.push(`<p class="sub">${s.sub}</p>`);
    if (s.html) parts.push(s.html);
    if (s.meta) parts.push(`<div class="meta">${s.meta}</div>`);
    stage.innerHTML = parts.join('');
    stage.classList.add('on');
  }, spec);
  await page.waitForTimeout(spec.hold ?? 1600);
}

export async function hideCard(page, settle = 420) {
  await page.evaluate(() => document.getElementById('reel-stage')?.classList.remove('on'));
  await page.waitForTimeout(settle);
}

/* ───────────────────────────── подпись ────────────────────────────── */

export async function cap(page, title, note = '', tag = '') {
  await page.evaluate(
    ([t, n, g]) => {
      try {
        sessionStorage.setItem('reel-cap', JSON.stringify([t, n, g, true]));
      } catch {}
      const el = document.getElementById('reel-cap');
      if (!el) return;
      el.querySelector('b').textContent = t;
      el.querySelector('span').textContent = n;
      el.querySelector('i').textContent = g;
      el.classList.add('on');
    },
    [title, note, tag],
  );
  await page.waitForTimeout(200);
}

export async function capOff(page) {
  await page.evaluate(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('reel-cap') || 'null');
      if (s) sessionStorage.setItem('reel-cap', JSON.stringify([s[0], s[1], s[2], false]));
    } catch {}
    document.getElementById('reel-cap')?.classList.remove('on');
  });
  await page.waitForTimeout(300);
}

/* ─────────────────────────── взаимодействие ───────────────────────── */

async function ring(page, locator, hold) {
  try {
    const box = await locator.boundingBox();
    if (!box) return;
    await page.evaluate((b) => {
      const r = document.createElement('div');
      r.className = 'reel-ring';
      r.style.cssText += `left:${b.x - 5}px;top:${b.y - 5}px;width:${b.width + 10}px;height:${b.height + 10}px`;
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.opacity = '1'; });
      setTimeout(() => { r.style.opacity = '0'; setTimeout(() => r.remove(), 200); }, 480);
    }, { x: box.x, y: box.y, width: box.width, height: box.height });
    await page.waitForTimeout(hold);
  } catch { /* элемент уехал — подсветка не критична */ }
}

export async function click(page, selector, opts = {}) {
  const loc = typeof selector === 'string' ? page.locator(selector).first() : selector;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await ring(page, loc, opts.hold ?? 300);
  await loc.click();
  await page.waitForTimeout(opts.after ?? 380);
}

export async function type(page, selector, text, opts = {}) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await ring(page, loc, 260);
  await loc.click();
  await loc.fill('');
  await loc.type(text, { delay: opts.delay ?? 42 });
  await page.waitForTimeout(opts.after ?? 320);
}

/** Плавный скролл: резкие прыжки в записи читаются плохо. */
export async function smoothScroll(page, deltaY, ms = 620) {
  const steps = Math.max(12, Math.round(ms / 24));
  for (let i = 0; i < steps; i += 1) {
    // ease-in-out, чтобы скролл не стартовал и не тормозил рывком
    const t = i / (steps - 1);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const prev = i === 0 ? 0 : (() => { const p = (i - 1) / (steps - 1); return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; })();
    await page.mouse.wheel(0, deltaY * (e - prev));
    await page.waitForTimeout(24);
  }
  await page.waitForTimeout(160);
}

export const beat = (page, ms = 700) => page.waitForTimeout(ms);
