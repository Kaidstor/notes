import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { serveStatic } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import { logger } from 'hono/logger';

import type { NoteOwner } from './db.ts';
import { countNotes, deleteNote, getNote, listNotes, listTags, upsertNote } from './db.ts';
import { renderGate, renderNotFound, renderNotePage } from './page.ts';
import { parseFrontmatter, renderMarkdown } from './render.ts';

const PORT = Number(process.env.PORT ?? 3000);
const SITE_NAME = process.env.NOTES_SITE_NAME ?? 'notes.kaidstor.ru';
const PUBLIC_URL = (process.env.NOTES_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.NOTES_ADMIN_TOKEN;
const READ_TOKEN = process.env.NOTES_READ_TOKEN;

const COOKIE = 'notes_token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

if (process.env.NODE_ENV === 'production' && !(ADMIN_TOKEN && READ_TOKEN)) {
  throw new Error('NOTES_ADMIN_TOKEN и NOTES_READ_TOKEN обязательны при NODE_ENV=production');
}

if (!ADMIN_TOKEN || !READ_TOKEN) {
  console.warn('[notes] нет NOTES_ADMIN_TOKEN/NOTES_READ_TOKEN — доступ открыт всем');
}

type Env = { Variables: { role: NoteOwner } };

const app = new Hono<Env>();
app.use('*', logger());

// Страницы закрыты токеном, но ссылка всё равно утекает referer'ом и превью-ботами:
// заголовки — второй рубеж, чтобы адрес не разошёлся дальше того, кому его дали.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  c.header('Referrer-Policy', 'no-referrer');
});

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

function sameToken(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual бросает на разной длине, поэтому длину сверяем отдельно —
  // она и так видна по времени ответа и секретом не является
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Роль предъявленного токена: cookie в браузере, Bearer у агентов и CLI. */
function roleOf(c: Context<Env>): NoteOwner | null {
  if (!ADMIN_TOKEN || !READ_TOKEN) return 'admin';

  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const given = bearer || getCookie(c, COOKIE);
  if (!given) return null;

  if (sameToken(given, ADMIN_TOKEN)) return 'admin';
  if (sameToken(given, READ_TOKEN)) return 'read';

  return null;
}

/** Гейт: `admin` — только админский токен, `read` — любой из двух. */
function guard(need: NoteOwner): MiddlewareHandler<Env> {
  return async (c, next) => {
    const role = roleOf(c);

    if (role === 'admin' || (need === 'read' && role === 'read')) {
      c.set('role', role);
      return next();
    }

    // Браузеру — форма, всем остальным — честный 401. Различаем по Accept:
    // агент за markdown'ом не должен получить HTML вместо ошибки
    if (c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html')) {
      return c.html(renderGate(SITE_NAME, c.req.path, role !== null), 401);
    }

    return c.json({ error: role === null ? 'нужен токен' : 'недостаточно прав' }, 401);
  };
}

const guardRead = guard('read');
const guardAdmin = guard('admin');

app.get('/healthz', (c) => c.json({ ok: true, notes: countNotes() }));

// Токен из формы уезжает в cookie, а адрес остаётся чистым: в query его слать
// нельзя — он осел бы в истории браузера, логах traefik и в referer'е
app.post('/auth', async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? '');
  const next = String(form.next ?? '/');
  const role = sameToken(token, ADMIN_TOKEN) ? 'admin' : sameToken(token, READ_TOKEN) ? 'read' : null;

  if (!role) {
    return c.html(renderGate(SITE_NAME, next.startsWith('/') ? next : '/', true), 401);
  }

  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: PUBLIC_URL.startsWith('https://'),
    sameSite: 'Lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  // Открытый редирект: next приходит из формы, и без проверки на своё
  // происхождение страница входа уводила бы на чужой домен
  return c.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

/**
 * Правка существующей заметки: admin правит любую, read — только созданную им.
 * Возвращает владельца для upsert (у новой заметки это роль автора).
 */
function ownerForWrite(c: Context<Env>, uuid: string): NoteOwner | null {
  const role = (c.get('role') ?? 'admin') as NoteOwner;
  const existing = getNote(uuid);

  if (!existing) return role;
  if (role === 'admin') return existing.owner;

  return existing.owner === 'read' ? 'read' : null;
}

// --- публикация (Bearer) -----------------------------------------------------

app.post('/api/notes', guardRead, async (c) => {
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

  const owner = ownerForWrite(c, uuid);
  if (!owner) {
    return c.json({ error: 'заметка чужая: read-токен правит только свои' }, 403);
  }

  const note = upsertNote({
    uuid,
    title: rendered.title,
    markdown: payload.markdown,
    html: rendered.html,
    toc: JSON.stringify(rendered.toc),
    plain: rendered.plain,
    tags: payload.tags ?? data.tags ?? [],
    owner,
  });

  return c.json({
    uuid: note.uuid,
    title: note.title,
    url: `${PUBLIC_URL}/${note.uuid}`,
    created_at: note.created_at,
    updated_at: note.updated_at,
  });
});

app.delete('/api/notes/:uuid', guardRead, (c) => {
  const uuid = c.req.param('uuid');
  if (!ownerForWrite(c, uuid)) {
    return c.json({ error: 'заметка чужая: read-токен удаляет только свои' }, 403);
  }

  const removed = deleteNote(uuid);
  return removed ? c.json({ ok: true }) : c.json({ error: 'не найдено' }, 404);
});

// --- индекс и поиск (только admin) -------------------------------------------

app.get('/api/notes', guardAdmin, (c) =>
  c.json({
    site: SITE_NAME,
    total: countNotes(),
    tags: listTags(),
    notes: listNotes(c.req.query('q') ?? '', c.req.queries('tag') ?? []),
  }),
);

// --- редактор в браузере -----------------------------------------------------

app.get('/api/notes/:uuid{[0-9a-fA-F-]{36}}', guardRead, (c) => {
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

app.put('/api/notes/:uuid{[0-9a-fA-F-]{36}}', guardRead, async (c) => {
  const existing = getNote(c.req.param('uuid'));
  if (!existing) return c.json({ error: 'не найдено' }, 404);

  const owner = ownerForWrite(c, existing.uuid);
  if (!owner) return c.json({ error: 'заметка чужая: read-токен правит только свои' }, 403);

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
    owner,
  });

  return c.json({ uuid: note.uuid, title: note.title, updated_at: note.updated_at });
});

// --- страницы заметок (оба токена) -------------------------------------------

app.get('/:uuid{[0-9a-fA-F-]{36}}', guardRead, (c) => {
  const note = getNote(c.req.param('uuid'));
  if (!note) return c.html(renderNotFound(SITE_NAME), 404);

  return c.html(renderNotePage(note, SITE_NAME));
});

app.get('/:uuid{[0-9a-fA-F-]{36}}/raw', guardRead, (c) => {
  const note = getNote(c.req.param('uuid'));
  if (!note) return c.text('not found', 404);

  return c.text(note.markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

// --- SPA ---------------------------------------------------------------------

// Бандл mermaid: страница заметки импортирует его динамически, только если в ней есть схема.
app.use('/vendor/*', serveStatic({ root: './dist/web' }));
app.use('/assets/*', serveStatic({ root: './dist/web' }));
app.use('/favicon.svg', serveStatic({ root: './dist/web' }));
app.get('/', guardAdmin, serveStatic({ path: './dist/web/index.html' }));
// Редактор — та же SPA, маршрут разбирает фронт по pathname. Гейт здесь только
// на вход: правку по существу решает PUT, который сверяет владельца заметки.
app.get(
  '/:uuid{[0-9a-fA-F-]{36}}/edit',
  guardRead,
  serveStatic({ path: './dist/web/index.html' }),
);

console.log(`[notes] ${SITE_NAME} → http://localhost:${PORT} (${countNotes()} заметок)`);

export default { port: PORT, fetch: app.fetch };
