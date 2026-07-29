import type { NoteRow } from './db.ts';
import { escapeHtml, type TocItem } from './render.ts';

/** Визуальный язык приложения sql-kai: zinc-шкала, sky-акцент, мелкий шрифт,
 *  mono для технических значений. Инлайним, чтобы страница заметки была
 *  самодостаточной и не зависела от сборки фронта. */
const CSS = `
:root {
  color-scheme: dark;
  --bg: #09090b;
  --panel: #101013;
  --panel-2: #18181b;
  --border: #27272a;
  --border-strong: #3f3f46;
  --fg: #e4e4e7;
  --fg-strong: #fafafa;
  --muted: #a1a1aa;
  --faint: #71717a;
  --dim: #52525b;
  --accent: #38bdf8;
  --accent-strong: #0ea5e9;
  --amber: #f59e0b;
  --red: #f87171;
  --emerald: #34d399;
  --violet: #a78bfa;
  --mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #fafafa;
    --panel: #ffffff;
    --panel-2: #f4f4f5;
    --border: #e4e4e7;
    --border-strong: #d4d4d8;
    --fg: #27272a;
    --fg-strong: #09090b;
    --muted: #52525b;
    --faint: #71717a;
    --dim: #a1a1aa;
    --accent: #0284c7;
    --accent-strong: #0369a1;
    --amber: #b45309;
    --red: #dc2626;
    --emerald: #059669;
    --violet: #7c3aed;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.topbar {
  position: sticky; top: 0; z-index: 10;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  max-width: 1120px; margin: 0 auto; padding: 10px 24px;
  display: flex; align-items: center; gap: 10px;
  font-size: 12px;
}
.brand { color: var(--faint); font-family: var(--mono); font-size: 12px; text-decoration: none; }
.brand:hover { color: var(--fg); }
.topbar .spacer { flex: 1; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 6px;
  padding: 2px 8px; font-size: 11px; color: var(--muted);
  text-decoration: none; background: var(--panel);
}
a.chip:hover { border-color: var(--border-strong); color: var(--fg-strong); }
.wrap {
  max-width: 1120px; margin: 0 auto; padding: 40px 24px 96px;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 48px;
}
@media (min-width: 1080px) { .wrap { grid-template-columns: minmax(0, 1fr) 200px; } }
header.doc { margin-bottom: 28px; }
header.doc h1 {
  margin: 0 0 10px; font-size: 27px; line-height: 1.25;
  letter-spacing: -0.02em; color: var(--fg-strong); font-weight: 600;
}
.meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  font-size: 11px; color: var(--faint); font-family: var(--mono);
}
.meta .dot { color: var(--dim); }
.tag {
  border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px;
  color: var(--muted); background: var(--panel-2); font-size: 10.5px;
}
article { min-width: 0; }
article > *:first-child { margin-top: 0; }
article h2 {
  margin: 42px 0 14px; padding-bottom: 8px; font-size: 20px; font-weight: 600;
  letter-spacing: -0.01em; color: var(--fg-strong); border-bottom: 1px solid var(--border);
  scroll-margin-top: 64px;
}
article h3 {
  margin: 28px 0 10px; font-size: 15.5px; font-weight: 600; color: var(--fg-strong);
  scroll-margin-top: 64px;
}
article h4 { margin: 22px 0 8px; font-size: 13.5px; font-weight: 600; color: var(--muted); }
article p { margin: 14px 0; }
article ul, article ol { margin: 14px 0; padding-left: 22px; }
article li { margin: 6px 0; }
article li::marker { color: var(--dim); }
article a { color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
article a:hover { color: var(--accent-strong); border-bottom-color: var(--accent-strong); }
article strong { color: var(--fg-strong); font-weight: 600; }
article hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
article img { max-width: 100%; border: 1px solid var(--border); border-radius: 8px; }
code, kbd, pre { font-family: var(--mono); }
code {
  font-size: 12.5px; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 5px; padding: 0.08em 0.34em; color: var(--fg-strong);
}
pre {
  position: relative; margin: 16px 0; padding: 14px 16px; overflow-x: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  font-size: 12.5px; line-height: 1.6;
}
pre code { background: none; border: none; padding: 0; font-size: inherit; color: var(--fg); }
/* До отрисовки виден исходник: страница остаётся осмысленной, если бандл mermaid
   не загрузился. После — превью 16:10 со схемой, вписанной целиком. */
pre.mermaid {
  background: none; border: none; padding: 8px 0; margin: 22px 0;
  line-height: 1.5; color: var(--dim); overflow-x: auto;
}
pre.mermaid[data-processed] {
  color: inherit; overflow: hidden; cursor: zoom-in;
  aspect-ratio: 16 / 10; display: grid; place-items: center;
  padding: 12px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px;
}
pre.mermaid[data-processed]:hover { border-color: var(--border-strong); }
/* Вписываем и по высоте тоже: иначе высокая схема растягивает страницу на экраны. */
pre.mermaid svg { max-width: 100%; max-height: 100%; width: auto; height: auto; }
/* Страница со схемами шире обычной: колонка текста остаётся комфортной, а
   диаграмме достаётся место, которое иначе пустует по краям. */
body.diagrams .wrap { max-width: 1500px; }

/* Врезка вписана по ширине — разглядывать схему идут в полноэкранный просмотр. */
.mermaid-wrap { position: relative; }
.mermaid-zoom {
  position: absolute; top: 8px; right: 8px; opacity: 0.5; transition: opacity 0.12s;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  border-radius: 6px; padding: 3px 8px; font-size: 12px; line-height: 1.3; cursor: pointer;
}
.mermaid-wrap:hover .mermaid-zoom, .mermaid-zoom:focus-visible { opacity: 1; }
.mermaid-zoom:hover { color: var(--fg-strong); border-color: var(--border-strong); }

.mermaid-modal {
  position: fixed; inset: 0; z-index: 100; background: var(--bg);
  display: flex; flex-direction: column;
}
.mermaid-modal .bar {
  display: flex; align-items: center; gap: 6px; padding: 8px 12px;
  border-bottom: 1px solid var(--border); background: var(--panel);
}
.mermaid-modal .bar button {
  border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  border-radius: 6px; padding: 2px 10px; font: inherit; font-size: 12px; cursor: pointer;
}
.mermaid-modal .bar button:hover { color: var(--fg-strong); border-color: var(--border-strong); }
.mermaid-modal .bar .spacer { flex: 1; }
.mermaid-modal .bar .hint { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.mermaid-modal .stage-scroll { flex: 1; overflow: auto; padding: 20px; cursor: grab; }
.mermaid-modal .stage-scroll.grabbing { cursor: grabbing; }
.mermaid-modal .holder { margin: 0 auto; }
.mermaid-modal .stage { transform-origin: 0 0; transition: transform 130ms ease-out; }
.mermaid-modal .stage svg { display: block; max-width: none; }
@media (prefers-reduced-motion: reduce) {
  .mermaid-modal .stage { transition: none; }
}
pre[data-lang]::before {
  content: attr(data-lang); position: absolute; top: 6px; right: 10px;
  font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim);
}
blockquote {
  margin: 16px 0; padding: 2px 0 2px 16px; color: var(--muted);
  border-left: 2px solid var(--border-strong);
}
.tablewrap { margin: 18px 0; max-width: 100%; overflow-x: auto; }
.tablewrap table { margin: 0; }
/* Заметки, отрендеренные до появления .tablewrap: таблица скроллится сама. */
article > table { display: block; max-width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13.5px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
th {
  background: var(--panel-2); color: var(--faint); font-weight: 600;
  font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}
tbody tr:hover td { background: color-mix(in srgb, var(--panel) 60%, transparent); }
/* Длинные пути в ячейках рвутся по месту: иначе одна строка кода распирает
   таблицу шире колонки и включает горизонтальный скролл на ровном месте. */
td code { overflow-wrap: anywhere; }
.note, .warn, .ok {
  margin: 18px 0; padding: 12px 16px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); font-size: 14px;
}
.note { border-left: 2px solid var(--accent); }
.warn { border-left: 2px solid var(--amber); }
.ok { border-left: 2px solid var(--emerald); }
.note > *:first-child, .warn > *:first-child, .ok > *:first-child { margin-top: 0; }
.note > *:last-child, .warn > *:last-child, .ok > *:last-child { margin-bottom: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin: 18px 0; }
.card {
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
  padding: 12px 14px; font-size: 13px;
}
.card:hover { border-color: var(--border-strong); }
.card h4 { margin: 0 0 6px; }
kbd {
  border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 5px;
  padding: 1px 5px; font-size: 11px; background: var(--panel-2); color: var(--muted);
}
nav.toc { display: none; }
@media (min-width: 1080px) {
  nav.toc {
    display: block; position: sticky; top: 88px; align-self: start;
    font-size: 12px; line-height: 1.55; max-height: calc(100vh - 120px); overflow-y: auto;
  }
  nav.toc .toc-title {
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--dim); margin-bottom: 10px; font-weight: 600;
  }
  nav.toc a {
    display: block; padding: 3px 0 3px 10px; color: var(--faint);
    text-decoration: none; border-left: 1px solid var(--border);
  }
  nav.toc a:hover { color: var(--fg-strong); border-left-color: var(--border-strong); }
  nav.toc a.d3 { padding-left: 22px; font-size: 11.5px; }
  nav.toc a.active {
    color: var(--fg-strong);
    border-left-color: var(--accent);
    background: linear-gradient(to right, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%);
  }
}
@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}
footer.doc {
  max-width: 1120px; margin: 0 auto; padding: 20px 24px 48px;
  border-top: 1px solid var(--border); color: var(--dim);
  font-size: 11px; font-family: var(--mono);
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
}
footer.doc a { color: var(--faint); text-decoration: none; }
footer.doc a:hover { color: var(--fg); }
.empty {
  max-width: 560px; margin: 18vh auto; padding: 0 24px; text-align: center;
}
.empty h1 { font-size: 20px; color: var(--fg-strong); margin: 0 0 8px; font-weight: 600; }
.empty p { color: var(--faint); font-size: 13px; margin: 0; }
`;

/** Подсветка активного пункта оглавления по мере прокрутки. */
const SCROLLSPY = `
(() => {
  const links = [...document.querySelectorAll('nav.toc a')];
  if (!links.length) return;

  const nav = document.querySelector('nav.toc');
  const targets = links
    .map((link) => ({ link, heading: document.getElementById(decodeURIComponent(link.hash.slice(1))) }))
    .filter((item) => item.heading);
  if (!targets.length) return;

  // Линия активации — под липкой шапкой: активен последний заголовок, который её пересёк.
  const LINE = 88;
  let current = null;

  const activate = (item) => {
    if (item === current) return;
    current?.link.classList.remove('active');
    current?.link.removeAttribute('aria-current');
    current = item;
    if (!current) return;
    current.link.classList.add('active');
    current.link.setAttribute('aria-current', 'true');

    // Держим активный пункт в поле зрения, если оглавление само прокручивается.
    // scrollIntoView() здесь нельзя: он утащил бы за собой всю страницу.
    const navBox = nav.getBoundingClientRect();
    const linkBox = current.link.getBoundingClientRect();
    if (linkBox.top < navBox.top) nav.scrollTop -= navBox.top - linkBox.top;
    else if (linkBox.bottom > navBox.bottom) nav.scrollTop += linkBox.bottom - navBox.bottom;
  };

  const sync = () => {
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
    if (atBottom) return activate(targets[targets.length - 1]);

    let found = null;
    for (const item of targets) {
      if (item.heading.getBoundingClientRect().top > LINE) break;
      found = item;
    }
    activate(found ?? targets[0]);
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; sync(); });
  };

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  sync();
})();
`;

/** Отрисовка ```mermaid-блоков. Бандл грузится динамически и только на страницах,
 *  где схема есть: он тяжелее всей остальной страницы вместе взятой. */
const MERMAID = `
(async () => {
  const nodes = [...document.querySelectorAll('pre.mermaid')];
  if (!nodes.length) return;

  const palette = (dark) => dark
    ? { background: '#09090b', mainBkg: '#18181b', nodeBorder: '#3f3f46', primaryColor: '#18181b',
        primaryTextColor: '#e4e4e7', primaryBorderColor: '#3f3f46', secondaryColor: '#101013',
        tertiaryColor: '#101013', lineColor: '#52525b', textColor: '#e4e4e7',
        edgeLabelBackground: '#09090b', clusterBkg: '#101013', clusterBorder: '#27272a',
        titleColor: '#fafafa' }
    : { background: '#fafafa', mainBkg: '#f4f4f5', nodeBorder: '#d4d4d8', primaryColor: '#f4f4f5',
        primaryTextColor: '#27272a', primaryBorderColor: '#d4d4d8', secondaryColor: '#ffffff',
        tertiaryColor: '#ffffff', lineColor: '#a1a1aa', textColor: '#27272a',
        edgeLabelBackground: '#fafafa', clusterBkg: '#ffffff', clusterBorder: '#e4e4e7',
        titleColor: '#09090b' };

  let mermaid;
  try {
    ({ default: mermaid } = await import('/vendor/mermaid.js'));
  } catch (e) {
    console.warn('[notes] mermaid не загрузился, схемы остались исходником', e);
    return;
  }

  const sources = nodes.map((el) => el.textContent);
  const dark = matchMedia('(prefers-color-scheme: dark)');

  const draw = async () => {
    nodes.forEach((el, i) => {
      el.textContent = sources[i];
      el.removeAttribute('data-processed');
    });
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      // Публиковать может только владелец токена, поэтому HTML в подписях
      // разрешён (нужен для <br/>), а скрипты вырезаются.
      securityLevel: 'antiscript',
      themeVariables: {
        ...palette(dark.matches),
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
      },
      flowchart: { htmlLabels: true, useMaxWidth: true },
    });
    try {
      await mermaid.run({ nodes });
    } catch (e) {
      console.warn('[notes] схема не отрисована', e);
      return;
    }
    nodes.forEach(decorate);
  };

  await draw();
  dark.addEventListener('change', draw);

  // --- превью → просмотрщик ---------------------------------------------------

  function decorate(pre) {
    if (pre.parentElement?.classList.contains('mermaid-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mermaid-zoom';
    btn.title = 'Открыть схему';
    btn.setAttribute('aria-label', 'Открыть схему в просмотрщике');
    btn.textContent = '⤢';
    wrap.append(btn);

    const open = () => viewer(pre);
    btn.addEventListener('click', open);
    pre.addEventListener('click', open);
  }

  function viewer(pre) {
    const svg = pre.querySelector('svg');
    if (!svg) return;

    const modal = document.createElement('div');
    modal.className = 'mermaid-modal';
    modal.innerHTML =
      '<div class="bar">' +
      '<button data-act="out" title="Отдалить">−</button>' +
      '<span class="hint" data-role="scale">100%</span>' +
      '<button data-act="in" title="Приблизить">+</button>' +
      '<button data-act="fit">вписать</button>' +
      '<button data-act="one">1:1</button>' +
      '<span class="spacer"></span>' +
      '<span class="hint">Ctrl + колесо — зум · тянуть мышью — двигать</span>' +
      '<button data-act="full">во весь экран</button>' +
      '<button data-act="close" title="Закрыть (Esc)">✕</button>' +
      '</div>' +
      '<div class="stage-scroll"><div class="holder"><div class="stage"></div></div></div>';

    const scroller = modal.querySelector('.stage-scroll');
    const holder = modal.querySelector('.holder');
    const stage = modal.querySelector('.stage');
    const label = modal.querySelector('[data-role="scale"]');

    const clone = svg.cloneNode(true);
    clone.removeAttribute('style');
    stage.append(clone);
    document.body.append(modal);
    document.body.style.overflow = 'hidden';

    const vb = (clone.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
    const natW = vb[2] || svg.getBoundingClientRect().width;
    const natH = vb[3] || svg.getBoundingClientRect().height;
    clone.setAttribute('width', String(natW));
    clone.setAttribute('height', String(natH));

    // Масштаб — трансформом с переходом: анимируется плавно, а размер холдера
    // держит полосы прокрутки в согласии с картинкой.
    let scale = 1;
    const setScale = (next, anchorX, anchorY) => {
      const prev = scale;
      scale = Math.min(8, Math.max(0.05, next));

      const cx = anchorX ?? scroller.clientWidth / 2;
      const cy = anchorY ?? scroller.clientHeight / 2;
      const px = (scroller.scrollLeft + cx) / prev;
      const py = (scroller.scrollTop + cy) / prev;

      holder.style.width = natW * scale + 'px';
      holder.style.height = natH * scale + 'px';
      stage.style.transform = 'scale(' + scale + ')';
      label.textContent = Math.round(scale * 100) + '%';

      scroller.scrollLeft = px * scale - cx;
      scroller.scrollTop = py * scale - cy;
    };

    const fit = () => {
      const box = scroller.getBoundingClientRect();
      setScale(Math.min((box.width - 40) / natW, (box.height - 40) / natH));
    };
    const zoom = (factor, x, y) => setScale(scale * factor, x, y);

    fit();

    const close = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      modal.remove();
      document.body.style.overflow = '';
      removeEventListener('keydown', onKey);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === '+' || e.key === '=') zoom(1.2);
      if (e.key === '-') zoom(1 / 1.2);
      if (e.key === '0') fit();
    };
    addEventListener('keydown', onKey);

    modal.querySelector('.bar').addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'in') zoom(1.2);
      if (act === 'out') zoom(1 / 1.2);
      if (act === 'fit') fit();
      if (act === 'one') setScale(1);
      if (act === 'close') close();
      if (act === 'full') {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else modal.requestFullscreen().catch(() => {});
      }
    });

    // Зум колесом только с Ctrl/⌘ (и тачпадным пинчем, он приходит тем же событием):
    // иначе отобрали бы обычную прокрутку. Во время жеста переход выключаем —
    // иначе анимация догоняет курсор и ощущается вязкой.
    let wheelIdle;
    scroller.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();

        stage.style.transition = 'none';
        clearTimeout(wheelIdle);
        wheelIdle = setTimeout(() => {
          stage.style.transition = '';
        }, 180);

        const box = scroller.getBoundingClientRect();
        zoom(Math.exp(-e.deltaY * 0.0016), e.clientX - box.left, e.clientY - box.top);
      },
      { passive: false },
    );

    let drag = null;
    scroller.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
      scroller.setPointerCapture(e.pointerId);
      scroller.classList.add('grabbing');
    });
    scroller.addEventListener('pointermove', (e) => {
      if (!drag) return;
      scroller.scrollLeft = drag.left - (e.clientX - drag.x);
      scroller.scrollTop = drag.top - (e.clientY - drag.y);
    });
    const endDrag = () => {
      drag = null;
      scroller.classList.remove('grabbing');
    };
    scroller.addEventListener('pointerup', endDrag);
    scroller.addEventListener('pointercancel', endDrag);
  }
})();
`;

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });

function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

function shell(title: string, body: string, withMermaid = false): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body${withMermaid ? ' class="diagrams"' : ''}>
${body}
<script>${SCROLLSPY}</script>
${withMermaid ? `<script>${MERMAID}</script>` : ''}
</body>
</html>`;
}

export function renderNotePage(note: NoteRow, siteName: string): string {
  const toc = JSON.parse(note.toc) as TocItem[];
  const tags = JSON.parse(note.tags) as string[];

  const tocHtml = toc.length
    ? `<nav class="toc">
  <div class="toc-title">Содержание</div>
  ${toc
    .map(
      (item) =>
        `<a class="d${item.depth}" href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a>`,
    )
    .join('\n  ')}
</nav>`
    : '<div></div>';

  const updated =
    note.updated_at !== note.created_at
      ? `<span class="dot">·</span><span>обновлено ${formatDate(note.updated_at)}</span>`
      : '';

  return shell(
    note.title,
    `<div class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">${escapeHtml(siteName)}</a>
    <span class="spacer"></span>
    <a class="chip" href="/${note.uuid}/raw">markdown</a>
  </div>
</div>
<div class="wrap">
  <div>
    <header class="doc">
      <h1>${escapeHtml(note.title)}</h1>
      <div class="meta">
        <span>${formatDate(note.created_at)}</span>
        ${updated}
        <span class="dot">·</span>
        <span>${note.uuid}</span>
        ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      </div>
    </header>
    <article>
${note.html}
    </article>
  </div>
  ${tocHtml}
</div>
<footer class="doc">
  <a href="/">${escapeHtml(siteName)}</a>
  <span>·</span>
  <a href="/${note.uuid}/raw">исходник</a>
</footer>`,
    note.html.includes('class="mermaid"'),
  );
}

export function renderNotFound(siteName: string): string {
  return shell(
    'Заметка не найдена',
    `<div class="empty">
  <h1>404</h1>
  <p>Такой заметки нет. Возможно, её удалили или ссылка неполная.</p>
  <p style="margin-top:16px"><a class="chip" href="/">${escapeHtml(siteName)}</a></p>
</div>`,
  );
}
