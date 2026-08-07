import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  created_at: string;
  updated_at: string;
  snippet: string;
}

const dbPath = process.env.NOTES_DB ?? './data/notes.db';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });
db.exec('PRAGMA journal_mode = WAL');

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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_updated_at ON notes(updated_at DESC);
`);

// Заметки, созданные до появления ролей, остаются за admin: дефолт колонки
// закрывает и уже лежащие строки, поэтому отдельного UPDATE не нужно.
if (!db.query('PRAGMA table_info(notes)').all().some((c) => (c as { name: string }).name === 'owner')) {
  db.exec("ALTER TABLE notes ADD COLUMN owner TEXT NOT NULL DEFAULT 'admin'");
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
    `INSERT INTO notes (uuid, title, markdown, html, toc, plain, search, tags, owner, created_at, updated_at)
     VALUES ($uuid, $title, $markdown, $html, $toc, $plain, $search, $tags, $owner, $now, $now)
     ON CONFLICT(uuid) DO UPDATE SET
       title = $title, markdown = $markdown, html = $html, toc = $toc,
       plain = $plain, search = $search, tags = $tags, updated_at = $now`,
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
    $now: now,
  });

  return getNote(note.uuid)!;
}

export function getNote(uuid: string): NoteRow | null {
  return db.query('SELECT * FROM notes WHERE uuid = ?').get(uuid) as NoteRow | null;
}

export function deleteNote(uuid: string): boolean {
  return db.query('DELETE FROM notes WHERE uuid = ?').run(uuid).changes > 0;
}

/** `owner` сужает выборку до заметок одной роли: read видит в индексе только свои. */
export function listNotes(
  query: string,
  tags: string[] = [],
  owner?: NoteOwner,
  limit = 200,
): NoteListItem[] {
  const q = query.trim().toLowerCase();
  const picked = tags.map((t) => t.trim()).filter(Boolean);

  const where: string[] = [];
  const params: (string | number)[] = [];

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

  const rows = db
    .query(
      `SELECT uuid, title, plain, tags, created_at, updated_at
         FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as NoteRow[];

  return rows.map((row) => ({
    uuid: row.uuid,
    title: row.title,
    tags: JSON.parse(row.tags) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
    snippet: snippet(row.plain, q),
  }));
}

/** Все теги с числом заметок — из них рисуется фильтр в индексе. */
export function listTags(owner?: NoteOwner): TagCount[] {
  return db
    .query(
      `SELECT value AS tag, count(*) AS count
         FROM notes, json_each(notes.tags)
         ${owner ? 'WHERE owner = ?' : ''}
         GROUP BY value
         ORDER BY count DESC, value ASC`,
    )
    .all(...(owner ? [owner] : [])) as TagCount[];
}

export function countNotes(owner?: NoteOwner): number {
  const row = (
    owner
      ? db.query('SELECT count(*) AS n FROM notes WHERE owner = ?').get(owner)
      : db.query('SELECT count(*) AS n FROM notes').get()
  ) as { n: number };

  return row.n;
}

function snippet(plain: string, q: string, width = 160): string {
  if (!q) return plain.slice(0, width).trim();

  const at = plain.toLowerCase().indexOf(q);
  if (at < 0) return plain.slice(0, width).trim();

  const from = Math.max(0, at - Math.floor(width / 3));
  const text = plain.slice(from, from + width).trim();

  return (from > 0 ? '…' : '') + text + (from + width < plain.length ? '…' : '');
}
