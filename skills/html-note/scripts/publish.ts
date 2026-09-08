#!/usr/bin/env bun
/**
 * Публикация markdown-заметки на notes.kaidstor.ru.
 *
 * Токен и креды берутся ТОЛЬКО из окружения — запускать через
 * `sec run notes -- bun publish.ts …`, чтобы значения не попали в argv и вывод.
 *
 *   NOTES_ADMIN_TOKEN — правит и удаляет любую заметку, в --list видит все
 *   NOTES_READ_TOKEN  — читает страницы и raw, публикует, правит и видит в --list свои
 *
 * Берётся админский, если он есть в окружении: под ним доступно всё. Read-токен
 * остаётся рабочим вариантом для агента, которому листинг чужих заметок не нужен.
 *
 * Временная ссылка без токена: --share <uuid> [--ttl 1h|1d|7d], список выданных
 * --shares <uuid>, отзыв --unshare <token>. Отозвать read-токеном можно только
 * ссылку, выданную им же.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_HOST = 'https://notes.kaidstor.ru';
const LOCAL_HOST = 'http://localhost:3000';

const TTL: Record<string, number> = { '1h': 3600, '1d': 86400, '7d': 604800 };

interface Options {
  file?: string;
  host: string;
  title?: string;
  tags?: string[];
  uuid?: string;
  pin: boolean;
  list?: string;
  remove?: string;
  share?: string;
  ttl: string;
  shares?: string;
  unshare?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { host: DEFAULT_HOST, pin: false, ttl: '1d' };
  const modes: string[] = [];
  let ttlGiven = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Аргумент флага не может быть другим флагом: иначе `--share --delete X`
    // молча съедает `--delete` как uuid.
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`флагу ${arg} нужен аргумент`);
      i++;
      return value;
    };

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
        modes.push(arg);
        options.list = argv[i + 1]?.startsWith('--') === false ? next() : '';
        break;
      case '--delete':
        modes.push(arg);
        options.remove = next();
        break;
      case '--share':
        modes.push(arg);
        options.share = next();
        break;
      case '--ttl':
        ttlGiven = true;
        options.ttl = next();
        if (!TTL[options.ttl]) fail(`--ttl принимает 1h, 1d или 7d, а не «${options.ttl}»`);
        break;
      case '--shares':
        modes.push(arg);
        options.shares = next();
        break;
      case '--unshare':
        modes.push(arg);
        options.unshare = next();
        break;
      default:
        if (arg.startsWith('--')) fail(`неизвестный флаг ${arg}`);
        modes.push(`файл ${arg}`);
        options.file = arg;
    }
  }

  if (modes.length > 1) fail(`нужен ровно один режим, передано: ${modes.join(', ')}`);
  if (ttlGiven && !options.share) fail('--ttl работает только вместе с --share');

  return options;
}

function fail(message: string): never {
  console.error(`ошибка: ${message}`);
  process.exit(1);
}

function requireToken(): string {
  const token = process.env.NOTES_ADMIN_TOKEN || process.env.NOTES_READ_TOKEN;
  if (!token) {
    fail('нет NOTES_ADMIN_TOKEN/NOTES_READ_TOKEN — запусти через `sec run notes -- bun …`');
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
  const url = `${options.host}/api/notes?q=${encodeURIComponent(options.list)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${requireToken()}` } });
  if (!res.ok) fail(`список не получен: HTTP ${res.status}`);

  const data = (await res.json()) as {
    role: 'admin' | 'read';
    notes: { uuid: string; title: string; updated_at: string }[];
  };
  // Под read-токеном пусто ≠ «на сервере ничего нет»: он видит только свои
  // публикации, и молчаливый пустой вывод читался бы как отсутствие заметки
  if (data.role === 'read') {
    console.log('# read-токен: только заметки, опубликованные им');
  }
  for (const note of data.notes) {
    console.log(`${note.uuid}  ${note.updated_at.slice(0, 10)}  ${note.title}`);
  }
  process.exit(0);
}

if (options.share) {
  const res = await fetch(`${options.host}/api/notes/${options.share}/shares`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${requireToken()}`,
    },
    body: JSON.stringify({ ttl: TTL[options.ttl] }),
  });
  if (!res.ok) fail(`ссылка не выдана: HTTP ${res.status} ${await res.text()}`);

  const share = (await res.json()) as { url: string; expires_at: string };
  console.log(share.url);
  console.error(`до ${share.expires_at}`);
  process.exit(0);
}

if (options.shares) {
  const res = await fetch(`${options.host}/api/notes/${options.shares}/shares`, {
    headers: { authorization: `Bearer ${requireToken()}` },
  });
  if (!res.ok) fail(`список ссылок не получен: HTTP ${res.status}`);

  const data = (await res.json()) as { shares: { token: string; expires_at: string }[] };
  for (const share of data.shares) {
    console.log(`${share.token}  ${share.expires_at}`);
  }
  process.exit(0);
}

if (options.unshare) {
  const res = await fetch(`${options.host}/api/shares/${options.unshare}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${requireToken()}` },
  });
  if (!res.ok) fail(`отзыв не прошёл: HTTP ${res.status} ${await res.text()}`);

  console.log(`отозвано: ${options.unshare}`);
  process.exit(0);
}

if (!options.file) {
  fail('укажи путь к .md файлу (или --list / --delete <uuid> / --share <uuid>)');
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
