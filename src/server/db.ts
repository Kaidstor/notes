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
  due: string | null;
  done: string | null;
  created_at: string;
  updated_at: string;
}

/** Тег, которым помечены отложенные задачи агента. */
export const SCHEDULE_TAG = 'agent:schedule';

/** due — с `due` ≤ сегодня; open — все невыполненные; done — выполненные; all — все. */
export type ScheduleState = 'due' | 'open' | 'done' | 'all';

export interface ScheduleItem {
  uuid: string;
  title: string;
  description: string | null;
  tags: string[];
  due: string | null;
  done: string | null;
  /** Сколько дней задача ждёт после `due`; 0 — срок сегодня, отрицательное — ещё не наступил. */
  overdue_days: number | null;
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
  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    size       INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const hasColumn = (name: string) =>
  db.query('PRAGMA table_info(notes)').all().some((c) => (c as { name: string }).name === name);

// Заметки, созданные до появления ролей, остаются за admin: дефолт колонки
// закрывает и уже лежащие строки, поэтому отдельного UPDATE не нужно.
if (!hasColumn('owner')) {
  db.exec("ALTER TABLE notes ADD COLUMN owner TEXT NOT NULL DEFAULT 'admin'");
}
// Заметки, опубликованные с датой во frontmatter до появления колонки, получили бы
// NULL до следующей правки: дату достаём из сохранённого markdown.
for (const column of ['stale_after', 'due', 'done'] as const) {
  if (hasColumn(column)) continue;
  db.transaction(() => {
    db.exec(`ALTER TABLE notes ADD COLUMN ${column} TEXT`);
    const rows = db.query('SELECT uuid, markdown FROM notes').all() as Pick<NoteRow, 'uuid' | 'markdown'>[];
    const update = db.query(`UPDATE notes SET ${column} = ? WHERE uuid = ?`);
    for (const row of rows) {
      const value = parseFrontmatter(row.markdown).data[column];
      if (value) update.run(value, row.uuid);
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
  due: string | null;
  done: string | null;
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
    `INSERT INTO notes (uuid, title, markdown, html, toc, plain, search, tags, owner, stale_after, due, done, created_at, updated_at)
     VALUES ($uuid, $title, $markdown, $html, $toc, $plain, $search, $tags, $owner, $stale_after, $due, $done, $now, $now)
     ON CONFLICT(uuid) DO UPDATE SET
       title = $title, markdown = $markdown, html = $html, toc = $toc, plain = $plain,
       search = $search, tags = $tags, stale_after = $stale_after, due = $due, done = $done, updated_at = $now`,
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
    $due: note.due,
    $done: note.done,
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

// --- картинки ------------------------------------------------------------------

export interface ImageRow {
  id: string;
  mime: string;
  data: Uint8Array<ArrayBuffer>;
  size: number;
  created_by: NoteOwner;
  created_at: string;
}

/** Сутки на то, чтобы вставленную картинку сохранили в заметке, иначе её сносит уборка. */
const ORPHAN_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

export function createImage(mime: string, data: Uint8Array, createdBy: NoteOwner): ImageRow {
  sweepOrphanImages();

  // 16 байт в base64url это ровно 22 символа: на эту длину завязан шаблон
  // маршрутов `/img/:file` и `/s/:token/img/:file`.
  const id = randomBytes(16).toString('base64url');
  db.query(
    `INSERT INTO images (id, mime, data, size, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, mime, data, data.byteLength, createdBy, new Date().toISOString());

  return getImage(id)!;
}

export function getImage(id: string): ImageRow | null {
  return db.query('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | null;
}

/**
 * Картинки, которые не упоминает ни одна заметка. Связи «картинка — заметка» нет
 * намеренно: markdown с картинкой копируют между заметками, и удаление исходной
 * заметки не должно ломать копию.
 */
export function sweepOrphanImages(): number {
  const before = new Date(Date.now() - ORPHAN_IMAGE_TTL_MS).toISOString();
  return db
    .query(
      `DELETE FROM images
        WHERE created_at < ?
          AND NOT EXISTS (SELECT 1 FROM notes WHERE instr(notes.markdown, images.id) > 0)`,
    )
    .run(before).changes;
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

/**
 * Отложенные задачи — заметки с тегом `agent:schedule`, по возрастанию `due`.
 * `tags` сужают выборку так же, как в индексе. Задача без `due` в `due` не попадает
 * никогда: у неё нет даты, с которой её пора делать.
 */
export function listSchedule(state: ScheduleState, tags: string[] = [], owner?: NoteOwner): ScheduleItem[] {
  const where = ['EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)'];
  const params: string[] = [SCHEDULE_TAG];
  const now = today();

  if (owner) {
    where.push('owner = ?');
    params.push(owner);
  }
  for (const tag of tags.map((t) => t.trim()).filter(Boolean)) {
    where.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    params.push(tag);
  }
  if (state === 'due') {
    where.push('done IS NULL AND due IS NOT NULL AND due <= ?');
    params.push(now);
  }
  if (state === 'open') where.push('done IS NULL');
  if (state === 'done') where.push('done IS NOT NULL');

  const rows = db
    .query(
      `SELECT uuid, title, markdown, tags, due, done, updated_at FROM notes
        WHERE ${where.join(' AND ')}
        ORDER BY due IS NULL, due ASC, updated_at DESC`,
    )
    .all(...params) as NoteRow[];

  return rows.map((row) => ({
    uuid: row.uuid,
    title: row.title,
    description: parseFrontmatter(row.markdown).data.description ?? null,
    tags: JSON.parse(row.tags) as string[],
    due: row.due,
    done: row.done,
    overdue_days: row.due ? daysBetween(row.due, now) : null,
    updated_at: row.updated_at,
  }));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function snippet(plain: string, q: string, width = 160): string {
  if (!q) return plain.slice(0, width).trim();

  const at = plain.toLowerCase().indexOf(q);
  if (at < 0) return plain.slice(0, width).trim();

  const from = Math.max(0, at - Math.floor(width / 3));
  const text = plain.slice(from, from + width).trim();

  return (from > 0 ? '…' : '') + text + (from + width < plain.length ? '…' : '');
}
