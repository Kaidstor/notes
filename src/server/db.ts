import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseFrontmatter } from './render.ts';

/** Роль токена, которым заметка создана. Заметки до появления ролей — admin. */
export type NoteOwner = 'admin' | 'read';

export interface NoteRow {
  uuid: string;
  title: string;
  markdown: string;
  html: string;
  toc: string;
  plain: string;
  tags: string;
  owner: NoteOwner;
  stale_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface NoteListItem {
  uuid: string;
  title: string;
  tags: string[];
  stale_after: string | null;
  /** Посчитано сервером в поясе NOTES_TZ: клиенту в другом поясе дату не сравнивать. */
  stale: boolean;
  created_at: string;
  updated_at: string;
  snippet: string;
}

/** Отбор индекса: без `withStale` устаревшие заметки в выборку не попадают. */
export interface NoteFilter {
  query?: string;
  tags?: string[];
  owner?: NoteOwner;
  withStale?: boolean;
}

/** Временная ссылка на заметку: открывает страницу без токена до `expires_at`. */
export interface ShareRow {
  token: string;
  note_uuid: string;
  created_by: NoteOwner;
  created_at: string;
  expires_at: string;
}

const dbPath = process.env.NOTES_DB ?? './data/notes.db';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });
db.exec('PRAGMA journal_mode = WAL');
// Внешние ключи в SQLite выключены по умолчанию и включаются на соединение,
// без этой строки REFERENCES у shares остаётся декларацией.
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    uuid       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    markdown   TEXT NOT NULL,
    html       TEXT NOT NULL,
    toc        TEXT NOT NULL DEFAULT '[]',
    plain      TEXT NOT NULL,
    search     TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    owner      TEXT NOT NULL DEFAULT 'admin',
    stale_after TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_updated_at ON notes(updated_at DESC);
  CREATE TABLE IF NOT EXISTS shares (
    token      TEXT PRIMARY KEY,
    note_uuid  TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shares_note_uuid ON shares(note_uuid);
`);

const hasColumn = (name: string) =>
  db.query('PRAGMA table_info(notes)').all().some((c) => (c as { name: string }).name === name);

// Заметки, созданные до появления ролей, остаются за admin: дефолт колонки
// закрывает и уже лежащие строки, поэтому отдельного UPDATE не нужно.
if (!hasColumn('owner')) {
  db.exec("ALTER TABLE notes ADD COLUMN owner TEXT NOT NULL DEFAULT 'admin'");
}
// Заметки, опубликованные со stale_after до появления колонки, получили бы NULL и
// оставались бессрочными до следующей правки: срок достаём из сохранённого markdown.
if (!hasColumn('stale_after')) {
  db.transaction(() => {
    db.exec('ALTER TABLE notes ADD COLUMN stale_after TEXT');
    const rows = db.query('SELECT uuid, markdown FROM notes').all() as Pick<NoteRow, 'uuid' | 'markdown'>[];
    const update = db.query('UPDATE notes SET stale_after = ? WHERE uuid = ?');
    for (const row of rows) {
      const staleAfter = parseFrontmatter(row.markdown).data.stale_after;
      if (staleAfter) update.run(staleAfter, row.uuid);
    }
  })();
}

// Пояс задаётся явно: в контейнере TZ не выставлен, и по его часам (UTC) заметка
// с `stale_after` на завтра висела бы до 03:00 МСК. Кривой NOTES_TZ роняет старт.
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.NOTES_TZ ?? 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Сегодня в поясе NOTES_TZ, `YYYY-MM-DD`: с этой строкой сравнивается `stale_after`. */
export function today(): string {
  return dayFmt.format(new Date());
}

export function isStale(staleAfter: string | null): boolean {
  return staleAfter !== null && staleAfter <= today();
}

export function upsertNote(note: {
  uuid: string;
  title: string;
  markdown: string;
  html: string;
  toc: string;
  plain: string;
  tags: string[];
  owner: NoteOwner;
  stale_after: string | null;
}): NoteRow {
  const now = new Date().toISOString();
  // search — заранее приведённая к нижнему регистру копия: LIKE в SQLite
  // регистронезависим только для ASCII, кириллица иначе не найдётся.
  // Теги входят в индекс: по ним ищут сервисные заметки (`--list hidden-domains`).
  const search = `${note.title}\n${note.tags.join(' ')}\n${note.plain}`.toLowerCase();

  // owner проставляется только при вставке: правка чужой ролью (admin по
  // заметке read) не должна переписывать владельца — иначе автор потеряет
  // доступ к собственной заметке после первой же admin-правки
  db.query(
    `INSERT INTO notes (uuid, title, markdown, html, toc, plain, search, tags, owner, stale_after, created_at, updated_at)
     VALUES ($uuid, $title, $markdown, $html, $toc, $plain, $search, $tags, $owner, $stale_after, $now, $now)
     ON CONFLICT(uuid) DO UPDATE SET
       title = $title, markdown = $markdown, html = $html, toc = $toc,
       plain = $plain, search = $search, tags = $tags, stale_after = $stale_after, updated_at = $now`,
  ).run({
    $uuid: note.uuid,
    $title: note.title,
    $markdown: note.markdown,
    $html: note.html,
    $toc: note.toc,
    $plain: note.plain,
    $search: search,
    $tags: JSON.stringify(note.tags),
    $owner: note.owner,
    $stale_after: note.stale_after,
    $now: now,
  });

  return getNote(note.uuid)!;
}

export function getNote(uuid: string): NoteRow | null {
  return db.query('SELECT * FROM notes WHERE uuid = ?').get(uuid) as NoteRow | null;
}

// Каскад по FK работает только при PRAGMA foreign_keys на этом соединении;
// явный DELETE держит ссылки мёртвыми и там, где прагму забыли или сняли.
export const deleteNote = db.transaction((uuid: string): boolean => {
  db.query('DELETE FROM shares WHERE note_uuid = ?').run(uuid);
  return db.query('DELETE FROM notes WHERE uuid = ?').run(uuid).changes > 0;
});

// --- временные ссылки --------------------------------------------------------

export function createShare(noteUuid: string, createdBy: NoteOwner, ttlSeconds: number): ShareRow {
  sweepExpiredShares();

  // 32 байта в base64url это ровно 43 символа без паддинга: на эту длину
  // завязан шаблон маршрута `/s/:token{[A-Za-z0-9_-]{43}}`.
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);

  db.query(
    `INSERT INTO shares (token, note_uuid, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, noteUuid, createdBy, now.toISOString(), expires.toISOString());

  return getShare(token)!;
}

/** Только живая ссылка: истёкшая для вызывающего неотличима от отозванной. */
export function getShare(token: string): ShareRow | null {
  return db
    .query('SELECT * FROM shares WHERE token = ? AND expires_at > ?')
    .get(token, new Date().toISOString()) as ShareRow | null;
}

export function listShares(noteUuid: string, createdBy?: NoteOwner): ShareRow[] {
  const params: string[] = [noteUuid, new Date().toISOString()];
  if (createdBy) params.push(createdBy);

  return db
    .query(
      `SELECT * FROM shares
        WHERE note_uuid = ? AND expires_at > ? ${createdBy ? 'AND created_by = ?' : ''}
        ORDER BY created_at DESC`,
    )
    .all(...params) as ShareRow[];
}

export function revokeShare(token: string, createdBy?: NoteOwner): boolean {
  const params: string[] = [token];
  if (createdBy) params.push(createdBy);

  return (
    db
      .query(`DELETE FROM shares WHERE token = ? ${createdBy ? 'AND created_by = ?' : ''}`)
      .run(...params).changes > 0
  );
}

export function sweepExpiredShares(): number {
  return db.query('DELETE FROM shares WHERE expires_at <= ?').run(new Date().toISOString()).changes;
}

/**
 * WHERE по фильтру индекса. `owner` сужает выборку до заметок одной роли: read
 * видит в индексе только свои. `stale` переопределяет `withStale`: true — только
 * устаревшие (для счётчика), false — только живые.
 */
function filterWhere(
  { query = '', tags = [], owner, withStale = false }: NoteFilter,
  stale: boolean | undefined = withStale ? undefined : false,
): { sql: string; params: string[] } {
  const q = query.trim().toLowerCase();
  const picked = tags.map((t) => t.trim()).filter(Boolean);

  const where: string[] = [];
  const params: string[] = [];

  if (owner) {
    where.push('owner = ?');
    params.push(owner);
  }
  if (q) {
    where.push('search LIKE ?');
    params.push(`%${q}%`);
  }
  // Точное совпадение тега, а не подстрока: LIKE по JSON нашёл бы `recon` внутри
  // `recon-front`. Несколько тегов — И, отбор сужается с каждым выбранным.
  for (const tag of picked) {
    where.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    params.push(tag);
  }
  if (stale === true) {
    where.push('stale_after IS NOT NULL AND stale_after <= ?');
    params.push(today());
  }
  if (stale === false) {
    where.push('(stale_after IS NULL OR stale_after > ?)');
    params.push(today());
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listNotes(filter: NoteFilter, limit = 200): NoteListItem[] {
  const { sql, params } = filterWhere(filter);

  const rows = db
    .query(
      `SELECT uuid, title, plain, tags, stale_after, created_at, updated_at
         FROM notes ${sql}
         ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as NoteRow[];

  const q = (filter.query ?? '').trim().toLowerCase();
  return rows.map((row) => ({
    uuid: row.uuid,
    title: row.title,
    tags: JSON.parse(row.tags) as string[],
    stale_after: row.stale_after,
    stale: isStale(row.stale_after),
    created_at: row.created_at,
    updated_at: row.updated_at,
    snippet: snippet(row.plain, q),
  }));
}

/** Сколько устаревших заметок подходит под тот же отбор — для переключателя в индексе. */
export function countStale(filter: NoteFilter): number {
  const { sql, params } = filterWhere(filter, true);
  return (db.query(`SELECT count(*) AS n FROM notes ${sql}`).get(...params) as { n: number }).n;
}

/** Теги видимых заметок с их числом — из них рисуется фильтр в индексе. */
export function listTags(owner?: NoteOwner, withStale = false): TagCount[] {
  const { sql, params } = filterWhere({ owner, withStale });
  return db
    .query(
      `SELECT value AS tag, count(*) AS count
         FROM notes, json_each(notes.tags)
         ${sql}
         GROUP BY value
         ORDER BY count DESC, value ASC`,
    )
    .all(...params) as TagCount[];
}

/** Без `withStale` — только живые; `countNotes()` без аргументов считает все заметки. */
export function countNotes(owner?: NoteOwner, withStale = true): number {
  const { sql, params } = filterWhere({ owner, withStale });
  return (db.query(`SELECT count(*) AS n FROM notes ${sql}`).get(...params) as { n: number }).n;
}

function snippet(plain: string, q: string, width = 160): string {
  if (!q) return plain.slice(0, width).trim();

  const at = plain.toLowerCase().indexOf(q);
  if (at < 0) return plain.slice(0, width).trim();

  const from = Math.max(0, at - Math.floor(width / 3));
  const text = plain.slice(from, from + width).trim();

  return (from > 0 ? '…' : '') + text + (from + width < plain.length ? '…' : '');
}
