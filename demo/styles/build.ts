/**
 * Демо вариантов оформления страницы заметки: bun demo/styles/build.ts
 * Страница собирается настоящим renderNotePage, варианты подменяют только CSS.
 */
import { parseFrontmatter, renderMarkdown } from '../../src/server/render.ts';
import { renderNotePage } from '../../src/server/page.ts';
import type { NoteRow } from '../../src/server/db.ts';

const dir = import.meta.dir;
const VARIANTS = ['current', 'book', 'draft', 'poster', 'dusk', 'md'];

const source = await Bun.file(`${dir}/sample.md`).text();
const { data, body } = parseFrontmatter(source);
const rendered = renderMarkdown(body, data.title);

const note: NoteRow = {
  uuid: '0f0f9d4c-2b1e-4a7e-9d3f-6a1c8e2b4d51',
  title: rendered.title,
  markdown: source,
  html: rendered.html,
  toc: JSON.stringify(rendered.toc),
  plain: rendered.plain,
  tags: JSON.stringify(data.tags ?? []),
  owner: 'admin',
  created_at: '2026-07-27T09:12:00.000Z',
  updated_at: '2026-09-18T15:40:00.000Z',
};

let html = renderNotePage(note, 'notes.kaidstor.ru');

const patch = (from: string, to: string) => {
  if (!html.includes(from)) throw new Error(`не нашёл в странице: ${from}`);
  html = html.replace(from, to);
};

// Схемы перекрашиваются под вариант: палитра берётся из CSS-переменных,
// перерисовка — по событию переключателя.
patch("import('/vendor/mermaid.js')", "import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')");
patch('const palette = (dark) => dark', 'const palette = (dark) => window.__palette ? window.__palette() : dark');
patch(
  `fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',`,
  'fontFamily: getComputedStyle(document.body).fontFamily,',
);
patch('  await draw();\n', '  await document.fonts.ready;\n  await draw();\n  addEventListener(\'variantchange\', draw);\n');

const baseCss = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
const variantCss = await Promise.all(VARIANTS.map((v) => Bun.file(`${dir}/variants/${v}.css`).text()));
const switcherCss = await Bun.file(`${dir}/switcher.css`).text();
const switcherJs = await Bun.file(`${dir}/switcher.js`).text();

const fonts =
  'https://fonts.googleapis.com/css2?' +
  [
    'family=Literata:ital,opsz,wght@0,7..72,300..700;1,7..72,300..600',
    'family=IBM+Plex+Sans+Condensed:wght@400;500;600;700',
    'family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400',
    'family=IBM+Plex+Mono:wght@400;500',
    'family=Onest:wght@400;500;600;700;800;900',
    'family=Commissioner:wght@300..700',
    'family=JetBrains+Mono:ital,wght@0,400..800;1,400',
  ].join('&') +
  '&display=swap';

// Тема и вариант ставятся до первой отрисовки, иначе при перезагрузке мигает дефолт.
const boot = `<script>
(() => {
  const q = new URLSearchParams(location.search);
  const v = q.get('v') || localStorage.getItem('demo-v') || 'book';
  const t = q.get('t') || localStorage.getItem('demo-theme') || 'auto';
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.v = v;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
</script>`;

html = html.replace(
  /<style>[\s\S]*?<\/style>/,
  () => `${boot}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${baseCss}
${variantCss.join('\n')}
${switcherCss}</style>`,
);
html = html.replace('</body>', () => `<script>${switcherJs}</script>\n</body>`);

await Bun.write(`${dir}/index.html`, html);
console.log(`${dir}/index.html`);
