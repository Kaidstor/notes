#!/usr/bin/env bun
/**
 * notes-kai — CLI сервиса notes: публикация заметок, чтение, поиск, удаление,
 * временные ссылки и отложенные задачи агента (заметки с тегом `agent:schedule`,
 * дата исполнения — `due` во frontmatter, отметка выполнения — `done`).
 *
 * Состояние задачи целиком живёт в её markdown: CLI правит frontmatter и отправляет
 * заметку обратно, поэтому то же самое можно сделать руками в редакторе на сайте.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Подставляет `bun build --define` в cli/build.sh; при запуске исходника идентификатора нет.
declare const NOTES_KAI_VERSION: string | undefined;
const VERSION = typeof NOTES_KAI_VERSION === 'string' ? NOTES_KAI_VERSION : 'dev';
const TAG = 'agent:schedule';
const DEFAULT_HOST = 'https://notes.kaidstor.ru';
const LOCAL_HOST = 'http://localhost:3000';
const ADMIN_TOKEN_REF = 'notes/NOTES_ADMIN_TOKEN';
const READ_TOKEN_REF = 'notes/NOTES_READ_TOKEN';
const REQUEST_TIMEOUT_MS = 20_000;

const TTL: Record<string, number> = { '1h': 3600, '1d': 86400, '7d': 604800 };

// Коды совпадают по смыслу с yk-kai, ci-kai и sec.
const EXIT = { ok: 0, notApplied: 1, tool: 2, notFound: 3, timeout: 4 } as const;

const USAGE = `notes-kai — заметки на notes.kaidstor.ru и отложенные задачи агента (тег ${TAG})

Использование:
  notes-kai <команда> [аргументы]

Заметки:
  publish <файл.md | -> [--pin] [--uuid U] [--title T] [--tags a,b]
                                 опубликовать; uuid во frontmatter или --uuid — обновить ту же
                                 страницу; --pin дописывает uuid: и url: в начало frontmatter файла
  get <uuid>                     исходный markdown заметки
  list [запрос] [--tag T]        что опубликовано, включая устаревшие
  delete <uuid>                  удалить заметку вместе с её ссылками
  share <uuid> [--ttl 1h|1d|7d]  ссылка без токена, по умолчанию на 1d
  shares <uuid>                  активные ссылки заметки
  unshare <token>                отозвать ссылку раньше срока

Задачи:
  due [--open | --done | --all] [--tag T]
                                 задачи, которые пора делать: due ≤ сегодня, не выполнены;
                                 --open все невыполненные, --done выполненные, --all все
  add <файл.md | -> --due <дата> [--tags a,b]
                                 завести задачу: due и тег ${TAG} дописываются во frontmatter;
                                 uuid во frontmatter файла — обновить ту же задачу
  done <uuid> [--result текст]   выполнено: done во frontmatter и раздел «## Результат <дата>»;
                                 без --result текст читается из stdin
  snooze <uuid> <дата>           перенести срок
  reopen <uuid>                  снять отметку о выполнении
  Задача — обычная заметка: читать её get, удалять delete.

Служебное:
  doctor                         токен, сервер, число открытых задач
  version

Дата: YYYY-MM-DD, today, tomorrow, +3d, +2w. «Сегодня» — по Москве (NOTES_TZ).

Общие флаги:
  --human                        вывод для человека вместо JSON
  --json                         машиночитаемый вывод (по умолчанию)
  --host <url>                   сервер; по умолчанию $NOTES_HOST или ${DEFAULT_HOST}
  --local                        сервер ${LOCAL_HOST}
  -h, --help                     справка

Токен: $NOTES_ADMIN_TOKEN, иначе $NOTES_READ_TOKEN, иначе sec get ${ADMIN_TOKEN_REF},
иначе sec get ${READ_TOKEN_REF}; $NOTES_TOKEN_REF заменяет оба sec-адреса одним.
Read-токен правит, удаляет и видит в list только заметки и задачи, заведённые им самим.

Коды выхода:
  0 сделано                      2 ошибка инструмента или аргументов   4 сервер не ответил
  1 сервер не применил правку    3 заметка, задача или ссылка не найдена`;

// --- вывод -------------------------------------------------------------------

type Kind = 'auth' | 'network' | 'usage' | 'not_found' | 'timeout' | 'api';

class CliError extends Error {
  constructor(
    readonly kind: Kind,
    message: string,
    readonly code: number = kind === 'not_found' ? EXIT.notFound : kind === 'timeout' ? EXIT.timeout : EXIT.tool,
  ) {
    super(message);
  }
}

let human = false;
let command = '';
const warnings: string[] = [];

function result(code: number, data: unknown, print: () => void): never {
  if (human) {
    for (const w of warnings) console.error(`warn: ${w}`);
    print();
  } else {
    console.log(JSON.stringify({ v: 1, command, exit: code, data, warning: warnings.length ? warnings : undefined, error: null }, null, 2));
  }
  process.exit(code);
}

function failure(error: CliError): never {
  if (human) console.error(`ошибка: ${error.message}`);
  else console.log(JSON.stringify({ v: 1, command, exit: error.code, data: null, error: { kind: error.kind, message: error.message } }, null, 2));
  process.exit(error.code);
}

// --- аргументы ---------------------------------------------------------------

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--tag', '--tags', '--due', '--result', '--host', '--uuid', '--title', '--ttl']);
const BOOL_FLAGS = new Set(['--human', '--json', '--open', '--done', '--all', '--pin', '--local', '-h', '--help']);

const GLOBAL_FLAGS = new Set(['--human', '--json', '--host', '--local', '-h', '--help']);
const COMMAND_FLAGS: Record<string, string[]> = {
  publish: ['--pin', '--uuid', '--title', '--tags'],
  get: [],
  list: ['--tag'],
  delete: [],
  share: ['--ttl'],
  shares: [],
  unshare: [],
  due: ['--open', '--done', '--all', '--tag'],
  add: ['--due', '--tags'],
  done: ['--result'],
  snooze: [],
  reopen: [],
  doctor: [],
  version: [],
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const tags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // `-` — законный аргумент (stdin), остальное с дефиса — забытое значение флага.
      if (value === undefined || (value.startsWith('-') && value !== '-' && !/^-\d/.test(value))) {
        throw new CliError('usage', `флагу ${arg} нужен аргумент`);
      }
      i++;
      if (arg === '--tag') tags.push(value);
      else flags.set(arg, value);
    } else if (BOOL_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith('--')) {
      throw new CliError('usage', `неизвестный флаг ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (tags.length) flags.set('--tag', tags.join('\n'));

  return { positional, flags };
}

const str = (args: Args, flag: string) => {
  const v = args.flags.get(flag);
  return typeof v === 'string' ? v : undefined;
};

function need(args: Args, index: number, what: string): string {
  const value = args.positional[index];
  if (!value) throw new CliError('usage', `нужен аргумент: ${what}`);
  return value;
}

function tagList(spec: string | undefined): string[] {
  return (spec ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

const UUID = /^[0-9a-fA-F-]{36}$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function needUuid(args: Args, index = 0): string {
  const uuid = need(args, index, 'uuid');
  if (!UUID.test(uuid)) throw new CliError('usage', `«${uuid}» — не uuid`);
  return uuid;
}

// --- даты --------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.NOTES_TZ ?? 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function today(): string {
  return dayFmt.format(new Date());
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function parseDate(spec: string): string {
  if (spec === 'today') return today();
  if (spec === 'tomorrow') return addDays(today(), 1);

  const rel = /^\+(\d+)([dw])$/.exec(spec);
  if (rel) return addDays(today(), Number(rel[1]) * (rel[2] === 'w' ? 7 : 1));

  const date = /^\d{4}-\d{2}-\d{2}$/.test(spec) ? new Date(`${spec}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== spec) {
    throw new CliError('usage', `дата «${spec}»: нужна YYYY-MM-DD, today, tomorrow, +Nd или +Nw`);
  }
  return spec;
}

// --- frontmatter -------------------------------------------------------------

const FM = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** Ставит ключ с колонки 0 во frontmatter (null — убирает); без frontmatter заводит его. */
function setKey(markdown: string, key: string, value: string | null): string {
  const match = FM.exec(markdown);
  if (!match) {
    return value === null ? markdown : `---\n${key}: ${value}\n---\n\n${markdown}`;
  }

  const lines = match[1]!.split(/\r?\n/);
  const at = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (value === null) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) {
    lines[at] = `${key}: ${value}`;
  } else {
    lines.push(`${key}: ${value}`);
  }

  return `---\n${lines.join('\n')}\n---${match[2]}${markdown.slice(match[0].length)}`;
}

function getKey(markdown: string, key: string): string | undefined {
  const match = FM.exec(markdown);
  const line = match?.[1]!.split(/\r?\n/).find((l) => new RegExp(`^${key}\\s*:`).test(l));
  return line?.replace(/^[^:]+:\s*/, '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
}

function addTags(markdown: string, extra: string[]): string {
  const raw = getKey(markdown, 'tags');
  // `tags:` без значения — многострочный YAML-список, строки `- a` ниже. Сервер его не
  // читает, а setKey заменил бы только первую строку и оставил хвост сиротой.
  if (raw === '') {
    throw new CliError('usage', 'tags во frontmatter многострочным списком: сервер его не читает, нужен [a, b]');
  }

  const current = (raw ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const tags = [...current, ...extra.filter((t) => !current.includes(t))];

  return setKey(markdown, 'tags', `[${tags.join(', ')}]`);
}

/**
 * Дописывает uuid и url первыми строками frontmatter: uuid делает следующую публикацию
 * обновлением той же страницы, url оставляет в репозитории грепаемую ссылку.
 */
function pinFile(file: string, uuid: string, url: string): void {
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

// --- HTTP --------------------------------------------------------------------

let host = '';
let tokenCache: { value: string; source: string } | undefined;

/** Админский, если он есть, иначе read: под admin доступно всё. */
function resolveToken(): { value: string; source: string } {
  if (tokenCache) return tokenCache;

  for (const name of ['NOTES_ADMIN_TOKEN', 'NOTES_READ_TOKEN']) {
    const value = process.env[name]?.trim();
    if (value) return (tokenCache = { value, source: `env:${name}` });
  }

  const refs = process.env.NOTES_TOKEN_REF ? [process.env.NOTES_TOKEN_REF] : [ADMIN_TOKEN_REF, READ_TOKEN_REF];
  for (const ref of refs) {
    const sec = spawnSync('sec', ['get', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const value = sec.error || sec.status !== 0 ? '' : sec.stdout.trim();
    if (value) return (tokenCache = { value, source: `sec:${ref}` });
  }

  throw new CliError('auth', `токен не найден: нет $NOTES_ADMIN_TOKEN/$NOTES_READ_TOKEN и не прочитался sec get ${refs.join(', ')}`);
}

async function api<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${host}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${resolveToken().value}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    const name = (error as Error).name;
    if (name === 'TimeoutError') throw new CliError('timeout', `${host} не ответил за ${REQUEST_TIMEOUT_MS / 1000} с`);
    throw new CliError('network', `${host}: ${(error as Error).message}`);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Вместо JSON пришёл HTML: прокси, страница входа или чужой сервер на адресе.
    throw new CliError('api', `${method} ${path}: HTTP ${res.status}, ответ не JSON: ${text.slice(0, 120)}`);
  }

  const message = (json as { error?: string }).error ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new CliError('auth', message);
  if (res.status === 404) throw new CliError('not_found', message);
  if (!res.ok) throw new CliError('api', `${method} ${path}: ${message}`);

  return json as T;
}

/** 404 сервера («не найдено») с тем, чего именно нет. */
async function orNotFound<T>(request: Promise<T>, what: string): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof CliError && error.kind === 'not_found') throw new CliError('not_found', what);
    throw error;
  }
}

interface Task {
  uuid: string;
  title: string;
  description: string | null;
  tags: string[];
  due: string | null;
  done: string | null;
  overdue_days: number | null;
  url: string;
}

interface NoteJson {
  uuid: string;
  title: string;
  markdown: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface Published {
  uuid: string;
  title: string;
  url: string;
  created_at: string;
  updated_at: string;
}

interface NoteListItem {
  uuid: string;
  title: string;
  tags: string[];
  stale_after: string | null;
  stale: boolean;
  created_at: string;
  updated_at: string;
}

interface Share {
  token: string;
  url: string;
  created_by: string;
  created_at: string;
  expires_at: string;
}

// --- ядро: единственные пути к API заметок -------------------------------------

function readNote(uuid: string): Promise<NoteJson> {
  return orNotFound(api<NoteJson>('GET', `/api/notes/${uuid}`), `заметки ${uuid} нет`);
}

function publishNote(note: { markdown: string; uuid?: string; title?: string; tags?: string[] }): Promise<Published> {
  return api<Published>('POST', '/api/notes', note);
}

function readSource(source: string): string {
  let markdown: string;
  try {
    markdown = source === '-' ? readStdin() : readFileSync(source, 'utf8');
  } catch (error) {
    throw new CliError('usage', `файл ${source} не прочитан: ${(error as Error).message}`);
  }
  if (!markdown.trim()) throw new CliError('usage', 'пустой markdown');
  return markdown;
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf8');
}

// --- задачи: сохранение и проверка ---------------------------------------------

/** Публикация по uuid и проверка, что сервер разобрал поля так, как их записали. */
async function saveTask(note: NoteJson, markdown: string, expect: Partial<Pick<Task, 'due' | 'done'>>): Promise<Task> {
  // POST без ключа tags во frontmatter обнуляет теги заметки (PUT редактора сохранял
  // прежние), и задача, получившая тег параметром, молча выпала бы из очереди.
  if (getKey(markdown, 'tags') === undefined && note.tags.length) markdown = addTags(markdown, note.tags);

  await publishNote({ markdown, uuid: note.uuid });
  return verify(note.uuid, expect);
}

async function verify(uuid: string, expect: Partial<Pick<Task, 'due' | 'done'>>): Promise<Task> {
  const { tasks } = await api<{ tasks: Task[] }>('GET', '/api/schedule?state=all');
  const task = tasks.find((t) => t.uuid === uuid);
  if (!task) {
    throw new CliError('api', `заметка ${uuid} сохранена, но в задачи не попала: тег ${TAG} не дошёл`, EXIT.notApplied);
  }
  for (const [key, value] of Object.entries(expect) as [keyof typeof expect, string | null][]) {
    if (task[key] !== value) {
      throw new CliError('api', `сервер записал ${key}=${task[key]}, а не ${value}`, EXIT.notApplied);
    }
  }
  return task;
}

// --- человеческий вывод ------------------------------------------------------

function when(task: Task): string {
  if (task.done) return `выполнена ${task.done}`;
  if (task.overdue_days === null) return 'без срока';
  if (task.overdue_days === 0) return 'сегодня';
  if (task.overdue_days > 0) return `ждёт ${task.overdue_days} дн.`;
  return `через ${-task.overdue_days} дн.`;
}

function printTasks(tasks: Task[], empty: string): void {
  if (!tasks.length) {
    console.log(empty);
    return;
  }
  for (const task of tasks) {
    const tags = task.tags.filter((t) => t !== TAG).join(', ');
    console.log(`${task.due ?? '—'.padEnd(10)}  ${when(task).padEnd(14)}  ${task.title}${tags ? `  [${tags}]` : ''}`);
    console.log(`${' '.repeat(28)}${task.uuid}`);
  }
}

// --- команды: заметки ----------------------------------------------------------

async function publish(args: Args): Promise<never> {
  const source = need(args, 0, 'файл .md или «-» для stdin');
  const pin = args.flags.has('--pin');
  if (pin && source === '-') throw new CliError('usage', '--pin дописывает uuid в файл, а markdown пришёл из stdin');

  const uuid = str(args, '--uuid');
  if (uuid !== undefined && !UUID.test(uuid)) throw new CliError('usage', `--uuid «${uuid}» — не uuid`);

  const tags = tagList(str(args, '--tags'));
  const note = await publishNote({
    markdown: readSource(source),
    uuid,
    title: str(args, '--title'),
    tags: tags.length ? tags : undefined,
  });
  if (pin) pinFile(source, note.uuid, note.url);

  return result(EXIT.ok, { ...note, pinned: pin }, () => {
    console.log(note.url);
    console.error(`«${note.title}» → ${note.uuid}`);
  });
}

async function get(args: Args): Promise<never> {
  const note = await readNote(needUuid(args));
  return result(EXIT.ok, note, () => process.stdout.write(note.markdown.endsWith('\n') ? note.markdown : `${note.markdown}\n`));
}

async function list(args: Args): Promise<never> {
  const query = new URLSearchParams({ stale: '1', q: args.positional.join(' ') });
  for (const tag of str(args, '--tag')?.split('\n') ?? []) query.append('tag', tag);

  const data = await api<{ role: string; notes: NoteListItem[] }>('GET', `/api/notes?${query}`);
  // Под read-токеном пусто ≠ «на сервере ничего нет»: он видит только свои публикации.
  if (data.role === 'read') warnings.push('read-токен: видны только заметки, опубликованные им');

  return result(EXIT.ok, { role: data.role, notes: data.notes }, () => {
    for (const note of data.notes) {
      const stale = note.stale ? `  [устарела ${note.stale_after}]` : '';
      console.log(`${note.uuid}  ${note.updated_at.slice(0, 10)}  ${note.title}${stale}`);
    }
  });
}

async function remove(args: Args): Promise<never> {
  const uuid = needUuid(args);
  await orNotFound(api('DELETE', `/api/notes/${uuid}`), `заметки ${uuid} нет`);
  return result(EXIT.ok, { uuid, deleted: true }, () => console.log(`удалено: ${uuid}`));
}

async function share(args: Args): Promise<never> {
  const uuid = needUuid(args);
  const ttl = str(args, '--ttl') ?? '1d';
  if (!TTL[ttl]) throw new CliError('usage', `--ttl принимает 1h, 1d или 7d, а не «${ttl}»`);

  const link = await orNotFound(api<Share>('POST', `/api/notes/${uuid}/shares`, { ttl: TTL[ttl] }), `заметки ${uuid} нет`);
  return result(EXIT.ok, link, () => {
    console.log(link.url);
    console.error(`до ${link.expires_at}`);
  });
}

async function shares(args: Args): Promise<never> {
  const uuid = needUuid(args);
  const data = await orNotFound(api<{ shares: Share[] }>('GET', `/api/notes/${uuid}/shares`), `заметки ${uuid} нет`);
  return result(EXIT.ok, data, () => {
    if (!data.shares.length) console.error('активных ссылок нет');
    for (const link of data.shares) console.log(`${link.token}  ${link.expires_at}`);
  });
}

async function unshare(args: Args): Promise<never> {
  const token = need(args, 0, 'токен ссылки');
  if (!SHARE_TOKEN.test(token)) throw new CliError('usage', 'токен ссылки — 43 символа base64url, последний сегмент адреса /s/<token>');

  // Чужая для read-токена ссылка отвечает тем же 404, что и несуществующая.
  await orNotFound(api('DELETE', `/api/shares/${token}`), 'ссылки нет: истекла, отозвана или выдана другим токеном');
  return result(EXIT.ok, { token, revoked: true }, () => console.log(`отозвано: ${token}`));
}

// --- команды: задачи -----------------------------------------------------------

async function schedule(args: Args, state: 'due' | 'open' | 'done' | 'all'): Promise<never> {
  const query = new URLSearchParams({ state });
  for (const tag of str(args, '--tag')?.split('\n') ?? []) query.append('tag', tag);

  const data = await api<{ role: string; today: string; tasks: Task[] }>('GET', `/api/schedule?${query}`);
  if (data.role === 'read') warnings.push('read-токен: видны только задачи, заведённые им');

  return result(EXIT.ok, data, () =>
    printTasks(data.tasks, state === 'due' ? `на ${data.today} задач нет` : 'задач нет'),
  );
}

async function add(args: Args): Promise<never> {
  const source = need(args, 0, 'файл .md или «-» для stdin');
  const dueSpec = str(args, '--due');
  if (!dueSpec) throw new CliError('usage', 'нужен --due <дата>');
  const due = parseDate(dueSpec);

  let markdown = readSource(source);
  markdown = addTags(setKey(markdown, 'due', due), [...tagList(str(args, '--tags')), TAG]);
  markdown = setKey(markdown, 'done', null);

  const note = await publishNote({ markdown });
  const task = await verify(note.uuid, { due, done: null });

  return result(EXIT.ok, task, () => {
    console.log(task.url);
    console.error(`«${task.title}» → ${task.uuid}, срок ${task.due}`);
  });
}

async function done(args: Args): Promise<never> {
  const uuid = needUuid(args);
  const text = (str(args, '--result') ?? readStdin()).trim();
  if (!text) throw new CliError('usage', 'нужен результат: --result <текст> или stdin');

  const note = await readNote(uuid);
  if (getKey(note.markdown, 'done')) throw new CliError('usage', `задача уже выполнена ${getKey(note.markdown, 'done')}`);

  const date = today();
  let markdown = setKey(note.markdown, 'done', date);
  // Выполненная задача уходит из списка на главной так же, как устаревшая заметка;
  // более ранний stale_after, заданный руками, не сдвигаем.
  const stale = getKey(markdown, 'stale_after');
  if (!stale || stale > date) markdown = setKey(markdown, 'stale_after', date);
  markdown = `${markdown.replace(/\s*$/, '')}\n\n## Результат ${date}\n\n${text}\n`;

  const task = await saveTask(note, markdown, { done: date });
  return result(EXIT.ok, task, () => console.log(`выполнена: ${task.title}`));
}

async function snooze(args: Args): Promise<never> {
  const uuid = needUuid(args);
  const due = parseDate(need(args, 1, 'дата'));

  const note = await readNote(uuid);
  if (getKey(note.markdown, 'done')) warnings.push('задача выполнена: срок сменён, в очередь она вернётся только после reopen');

  const task = await saveTask(note, setKey(note.markdown, 'due', due), { due });
  return result(EXIT.ok, task, () => console.log(`срок ${task.due}: ${task.title}`));
}

async function reopen(args: Args): Promise<never> {
  const uuid = needUuid(args);
  const note = await readNote(uuid);

  const doneAt = getKey(note.markdown, 'done');
  if (!doneAt) throw new CliError('usage', 'задача не выполнена, снимать нечего');

  let markdown = setKey(note.markdown, 'done', null);
  if (getKey(markdown, 'stale_after') === doneAt) markdown = setKey(markdown, 'stale_after', null);

  const task = await saveTask(note, markdown, { done: null });
  return result(EXIT.ok, task, () => console.log(`снова открыта: ${task.title}, срок ${task.due ?? '—'}`));
}

// --- служебное -----------------------------------------------------------------

async function doctor(): Promise<never> {
  const health = await api<{ ok: boolean; notes: number }>('GET', '/healthz', undefined, false);
  const token = resolveToken();
  const open = await api<{ role: string; tasks: Task[] }>('GET', '/api/schedule?state=open');
  const due = open.tasks.filter((t) => t.overdue_days !== null && t.overdue_days >= 0).length;

  const data = {
    host,
    token: { source: token.source, length: token.value.length },
    role: open.role,
    notes: health.notes,
    open: open.tasks.length,
    due,
  };
  return result(EXIT.ok, data, () => {
    console.log(`сервер   ${host} — ok, заметок ${health.notes}`);
    console.log(`токен    ${token.source} (${token.value.length} символов), роль ${open.role}`);
    console.log(`задачи   открытых ${open.tasks.length}, из них пора делать ${due}`);
  });
}

// --- роутер ------------------------------------------------------------------

async function main(): Promise<never> {
  const argv = process.argv.slice(2);
  command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const args = parseArgs(command ? argv.slice(1) : argv);

  human = args.flags.has('--human');
  const hostFlag = str(args, '--host') ?? (args.flags.has('--local') ? LOCAL_HOST : undefined);
  host = (hostFlag ?? process.env.NOTES_HOST ?? DEFAULT_HOST).replace(/\/+$/, '');

  if (!command || args.flags.has('--help') || args.flags.has('-h')) {
    console.log(USAGE);
    process.exit(command || args.flags.size ? EXIT.ok : EXIT.tool);
  }

  if (command === 'tasks') throw new CliError('usage', 'команды tasks больше нет: due --open, due --done или due --all');
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw new CliError('usage', `неизвестная команда «${command}», см. notes-kai --help`);
  for (const flag of args.flags.keys()) {
    if (!GLOBAL_FLAGS.has(flag) && !allowed.includes(flag)) {
      throw new CliError('usage', `флаг ${flag} не относится к команде ${command}`);
    }
  }

  switch (command) {
    case 'publish':
      return publish(args);
    case 'get':
      return get(args);
    case 'list':
      return list(args);
    case 'delete':
      return remove(args);
    case 'share':
      return share(args);
    case 'shares':
      return shares(args);
    case 'unshare':
      return unshare(args);
    case 'due': {
      const states = (['open', 'done', 'all'] as const).filter((s) => args.flags.has(`--${s}`));
      if (states.length > 1) throw new CliError('usage', `--open, --done и --all взаимоисключающие, передано: ${states.join(', ')}`);
      return schedule(args, states[0] ?? 'due');
    }
    case 'add':
      return add(args);
    case 'done':
      return done(args);
    case 'snooze':
      return snooze(args);
    case 'reopen':
      return reopen(args);
    case 'doctor':
      return doctor();
    default:
      return result(EXIT.ok, { version: VERSION }, () => console.log(VERSION));
  }
}

main().catch((error: unknown) =>
  failure(error instanceof CliError ? error : new CliError('api', (error as Error).message ?? String(error))),
);
