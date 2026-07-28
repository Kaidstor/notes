#!/usr/bin/env bun
/**
 * Публикация markdown-заметки на notes.kaidstor.ru.
 *
 * Токен и креды берутся ТОЛЬКО из окружения — запускать через
 * `sec run notes -- bun publish.ts …`, чтобы значения не попали в argv и вывод.
 *
 *   NOTES_PUBLISH_TOKEN  — bearer для публикации и удаления
 *   NOTES_USER/NOTES_PASSWORD — basic-auth, нужен только для --list
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_HOST = 'https://notes.kaidstor.ru';
const LOCAL_HOST = 'http://localhost:3000';

interface Options {
  file?: string;
  host: string;
  title?: string;
  tags?: string[];
  uuid?: string;
  pin: boolean;
  list?: string;
  remove?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { host: DEFAULT_HOST, pin: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? '';

    switch (arg) {
      case '--local':
        options.host = LOCAL_HOST;
        break;
      case '--host':
        options.host = next().replace(/\/+$/, '');
        break;
      case '--title':
        options.title = next();
        break;
      case '--tags':
        options.tags = next()
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case '--uuid':
        options.uuid = next();
        break;
      case '--pin':
        options.pin = true;
        break;
      case '--list':
        options.list = argv[i + 1]?.startsWith('--') === false ? next() : '';
        break;
      case '--delete':
        options.remove = next();
        break;
      default:
        if (arg.startsWith('--')) fail(`неизвестный флаг ${arg}`);
        options.file = arg;
    }
  }

  return options;
}

function fail(message: string): never {
  console.error(`ошибка: ${message}`);
  process.exit(1);
}

function requireToken(): string {
  const token = process.env.NOTES_PUBLISH_TOKEN;
  if (!token) {
    fail('нет NOTES_PUBLISH_TOKEN — запусти через `sec run notes -- bun …`');
  }
  return token;
}

/**
 * Дописывает uuid и url во frontmatter: uuid делает следующую публикацию
 * обновлением той же страницы, url оставляет в репозитории грепаемую ссылку.
 */
function pinUuid(file: string, uuid: string, url: string): void {
  let source = readFileSync(file, 'utf8');

  if (!/^---\r?\n[\s\S]*?^uuid:/m.test(source)) {
    source = /^---\r?\n/.test(source)
      ? source.replace(/^---\r?\n/, `---\nuuid: ${uuid}\n`)
      : `---\nuuid: ${uuid}\n---\n\n${source}`;
  }

  if (!/^---\r?\n[\s\S]*?^url:/m.test(source)) {
    source = source.replace(/^---\r?\n/, `---\nurl: ${url}\n`);
  }

  writeFileSync(file, source);
}

const options = parseArgs(process.argv.slice(2));

if (options.remove) {
  const res = await fetch(`${options.host}/api/notes/${options.remove}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${requireToken()}` },
  });
  if (!res.ok) fail(`удаление не прошло: HTTP ${res.status}`);

  console.log(`удалено: ${options.remove}`);
  process.exit(0);
}

if (options.list !== undefined) {
  const user = process.env.NOTES_USER;
  const password = process.env.NOTES_PASSWORD;
  if (!user || !password) fail('для --list нужны NOTES_USER и NOTES_PASSWORD');

  const url = `${options.host}/api/notes?q=${encodeURIComponent(options.list)}`;
  const res = await fetch(url, {
    headers: { authorization: `Basic ${btoa(`${user}:${password}`)}` },
  });
  if (!res.ok) fail(`список не получен: HTTP ${res.status}`);

  const data = (await res.json()) as {
    notes: { uuid: string; title: string; updated_at: string }[];
  };
  for (const note of data.notes) {
    console.log(`${note.uuid}  ${note.updated_at.slice(0, 10)}  ${note.title}`);
  }
  process.exit(0);
}

if (!options.file) {
  fail('укажи путь к .md файлу (или --list / --delete <uuid>)');
}

const markdown = readFileSync(options.file, 'utf8');

const res = await fetch(`${options.host}/api/notes`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${requireToken()}`,
  },
  body: JSON.stringify({
    markdown,
    title: options.title,
    tags: options.tags,
    uuid: options.uuid,
  }),
});

if (!res.ok) {
  fail(`публикация не прошла: HTTP ${res.status} ${await res.text()}`);
}

const note = (await res.json()) as { uuid: string; title: string; url: string };

if (options.pin) pinUuid(options.file, note.uuid, note.url);

console.log(note.url);
console.error(`«${note.title}» → ${note.uuid}`);
