import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { basicAuth } from 'hono/basic-auth';
import { bearerAuth } from 'hono/bearer-auth';
import { logger } from 'hono/logger';

import { countNotes, deleteNote, getNote, listNotes, listTags, upsertNote } from './db.ts';
import { renderNotFound, renderNotePage } from './page.ts';
import { parseFrontmatter, renderMarkdown } from './render.ts';

const PORT = Number(process.env.PORT ?? 3000);
const SITE_NAME = process.env.NOTES_SITE_NAME ?? 'notes.kaidstor.ru';
const PUBLIC_URL = (process.env.NOTES_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const USER = process.env.NOTES_USER;
const PASSWORD = process.env.NOTES_PASSWORD;
const PUBLISH_TOKEN = process.env.NOTES_PUBLISH_TOKEN;

if (process.env.NODE_ENV === 'production' && !(USER && PASSWORD && PUBLISH_TOKEN)) {
  throw new Error(
    'NOTES_USER, NOTES_PASSWORD и NOTES_PUBLISH_TOKEN обязательны при NODE_ENV=production',
  );
}

const app = new Hono();
app.use('*', logger());

const guardIndex =
  USER && PASSWORD
    ? basicAuth({ username: USER, password: PASSWORD, realm: SITE_NAME })
    : passthrough('индекс и поиск открыты: не заданы NOTES_USER/NOTES_PASSWORD');

const guardWrite = PUBLISH_TOKEN
  ? bearerAuth({ token: PUBLISH_TOKEN })
  : passthrough('публикация без токена: не задан NOTES_PUBLISH_TOKEN');

function passthrough(warning: string) {
  console.warn(`[notes] ${warning}`);
  return async (_c: unknown, next: () => Promise<void>) => next();
}

app.get('/healthz', (c) => c.json({ ok: true, notes: countNotes() }));

// --- публикация (Bearer) -----------------------------------------------------

app.post('/api/notes', guardWrite, async (c) => {
  const payload = (await c.req.json()) as {
    uuid?: string;
    title?: string;
    markdown?: string;
    tags?: string[];
  };

  if (!payload.markdown?.trim()) {
    return c.json({ error: 'markdown обязателен' }, 400);
  }

  const { data, body } = parseFrontmatter(payload.markdown);
  const rendered = renderMarkdown(body, payload.title ?? data.title);
  const uuid = payload.uuid ?? data.uuid ?? crypto.randomUUID();

  const note = upsertNote({
    uuid,
    title: rendered.title,
    markdown: payload.markdown,
    html: rendered.html,
    toc: JSON.stringify(rendered.toc),
    plain: rendered.plain,
    tags: payload.tags ?? data.tags ?? [],
  });

  return c.json({
    uuid: note.uuid,
    title: note.title,
    url: `${PUBLIC_URL}/${note.uuid}`,
    created_at: note.created_at,
    updated_at: note.updated_at,
  });
});

app.delete('/api/notes/:uuid', guardWrite, (c) => {
  const removed = deleteNote(c.req.param('uuid'));
  return removed ? c.json({ ok: true }) : c.json({ error: 'не найдено' }, 404);
});

// --- индекс и поиск (Basic) --------------------------------------------------

app.get('/api/notes', guardIndex, (c) =>
  c.json({
    site: SITE_NAME,
    total: countNotes(),
    tags: listTags(),
    notes: listNotes(c.req.query('q') ?? '', c.req.queries('tag') ?? []),
  }),
);

// --- редактор в браузере (Basic) ----------------------------------------------

app.get('/api/notes/:uuid{[0-9a-fA-F-]{36}}', guardIndex, (c) => {
  const note = getNote(c.req.param('uuid'));
  if (!note) return c.json({ error: 'не найдено' }, 404);

  return c.json({
    uuid: note.uuid,
    title: note.title,
    markdown: note.markdown,
    tags: JSON.parse(note.tags) as string[],
    created_at: note.created_at,
    updated_at: note.updated_at,
  });
});

app.put('/api/notes/:uuid{[0-9a-fA-F-]{36}}', guardIndex, async (c) => {
  const existing = getNote(c.req.param('uuid'));
  if (!existing) return c.json({ error: 'не найдено' }, 404);

  const payload = (await c.req.json()) as { markdown?: string };
  if (!payload.markdown?.trim()) return c.json({ error: 'markdown обязателен' }, 400);

  const { data, body } = parseFrontmatter(payload.markdown);
  const rendered = renderMarkdown(body, data.title);

  const note = upsertNote({
    uuid: existing.uuid,
    title: rendered.title,
    markdown: payload.markdown,
    html: rendered.html,
    toc: JSON.stringify(rendered.toc),
    plain: rendered.plain,
    // Теги, заданные при публикации параметром (мимо frontmatter), не теряем.
    tags: data.tags ?? (JSON.parse(existing.tags) as string[]),
  });

  return c.json({ uuid: note.uuid, title: note.title, updated_at: note.updated_at });
});

// --- публичные страницы заметок ---------------------------------------------

app.get('/:uuid{[0-9a-fA-F-]{36}}', (c) => {
  const note = getNote(c.req.param('uuid'));
  if (!note) return c.html(renderNotFound(SITE_NAME), 404);

  return c.html(renderNotePage(note, SITE_NAME));
});

app.get('/:uuid{[0-9a-fA-F-]{36}}/raw', (c) => {
  const note = getNote(c.req.param('uuid'));
  if (!note) return c.text('not found', 404);

  return c.text(note.markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

// --- SPA ---------------------------------------------------------------------

// Бандл mermaid: страница заметки импортирует его динамически, только если в ней есть схема.
app.use('/vendor/*', serveStatic({ root: './dist/web' }));
app.use('/assets/*', serveStatic({ root: './dist/web' }));
app.use('/favicon.svg', serveStatic({ root: './dist/web' }));
app.get('/', guardIndex, serveStatic({ path: './dist/web/index.html' }));
// Редактор — та же SPA, маршрут разбирает фронт по pathname.
app.get(
  '/:uuid{[0-9a-fA-F-]{36}}/edit',
  guardIndex,
  serveStatic({ path: './dist/web/index.html' }),
);

console.log(`[notes] ${SITE_NAME} → http://localhost:${PORT} (${countNotes()} заметок)`);

export default { port: PORT, fetch: app.fetch };
