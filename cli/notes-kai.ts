#!/usr/bin/env bun
/**
 * notes-kai — отложенные задачи агента в notes: заметки с тегом `agent:schedule`,
 * дата исполнения — `due` во frontmatter, отметка выполнения — `done`.
 *
 * Состояние задачи целиком живёт в её markdown: CLI правит frontmatter и отправляет
 * заметку обратно, поэтому то же самое можно сделать руками в редакторе на сайте.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const VERSION = '0.1.0';
const TAG = 'agent:schedule';
const DEFAULT_HOST = 'https://notes.kaidstor.ru';
const DEFAULT_TOKEN_REF = 'notes/NOTES_ADMIN_TOKEN';
const REQUEST_TIMEOUT_MS = 20_000;

// Коды совпадают по смыслу с yk-kai, ci-kai и sec.
const EXIT = { ok: 0, notApplied: 1, tool: 2, notFound: 3, timeout: 4 } as const;

const USAGE = `notes-kai — отложенные задачи агента в notes (тег ${TAG})

Использование:
  notes-kai <команда> [аргументы]

Задачи:
  due [--tag T]                  задачи, которые пора делать: due ≤ сегодня, не выполнены
  tasks [--done | --all] [--tag T]
                                 открытые задачи по сроку; --done выполненные, --all все
  add <файл.md | -> --due <дата> [--tags a,b]
                                 завести задачу: due и тег ${TAG} дописываются во frontmatter;
                                 uuid во frontmatter файла — обновить ту же задачу
  get <uuid>                     markdown задачи
  done <uuid> [--result текст]   выполнено: done во frontmatter и раздел «## Результат <дата>»;
                                 без --result текст читается из stdin
  snooze <uuid> <дата>           перенести срок
  reopen <uuid>                  снять отметку о выполнении

Служебное:
  doctor                         токен, сервер, число открытых задач
  version

Дата: YYYY-MM-DD, today, tomorrow, +3d, +2w. «Сегодня» — по Москве (NOTES_TZ).

Общие флаги:
  --human                        вывод для человека вместо JSON
  --json                         машиночитаемый вывод (по умолчанию)
  --host <url>                   сервер; по умолчанию $NOTES_HOST или ${DEFAULT_HOST}
  -h, --help                     справка

Токен: $NOTES_ADMIN_TOKEN или $NOTES_READ_TOKEN, иначе sec get \${NOTES_TOKEN_REF:-${DEFAULT_TOKEN_REF}}.
Read-токен видит и правит только задачи, заведённые им самим.

Коды выхода:
  0 сделано                      2 ошибка инструмента или аргументов   4 сервер не ответил
  1 сервер не применил правку    3 задача не найдена`;

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
    console.log(JSON.stringify({ v: 1, command, exit: code, data, warning: warnings.length ? warnings : undefined, error: null }));
  }
  process.exit(code);
}

function failure(error: CliError): never {
  if (human) console.error(`ошибка: ${error.message}`);
  else console.log(JSON.stringify({ v: 1, command, exit: error.code, data: null, error: { kind: error.kind, message: error.message } }));
  process.exit(error.code);
}

// --- аргументы ---------------------------------------------------------------

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--tag', '--tags', '--due', '--result', '--host']);
const BOOL_FLAGS = new Set(['--human', '--json', '--done', '--all', '-h', '--help']);

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

// --- HTTP --------------------------------------------------------------------

let host = '';
let tokenCache: string | undefined;

function token(): string {
  if (tokenCache) return tokenCache;

  const env = process.env.NOTES_ADMIN_TOKEN || process.env.NOTES_READ_TOKEN;
  if (env) return (tokenCache = env.trim());

  const ref = process.env.NOTES_TOKEN_REF || DEFAULT_TOKEN_REF;
  const sec = spawnSync('sec', ['get', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (sec.error || sec.status !== 0 || !sec.stdout.trim()) {
    throw new CliError('auth', `токен не найден: нет $NOTES_ADMIN_TOKEN и не прочитался sec get ${ref}`);
  }
  return (tokenCache = sec.stdout.trim());
}

function tokenSource(): string {
  if (process.env.NOTES_ADMIN_TOKEN) return 'env:NOTES_ADMIN_TOKEN';
  if (process.env.NOTES_READ_TOKEN) return 'env:NOTES_READ_TOKEN';
  return `sec:${process.env.NOTES_TOKEN_REF || DEFAULT_TOKEN_REF}`;
}

async function api<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${host}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${token()}` } : {}),
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
}

async function readNote(uuid: string): Promise<NoteJson> {
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) throw new CliError('usage', `«${uuid}» — не uuid`);
  try {
    return await api<NoteJson>('GET', `/api/notes/${uuid}`);
  } catch (error) {
    if (error instanceof CliError && error.kind === 'not_found') {
      throw new CliError('not_found', `задачи ${uuid} нет`);
    }
    throw error;
  }
}

/** PUT и проверка, что сервер разобрал поля так, как их записали. */
async function saveNote(uuid: string, markdown: string, expect: Partial<Pick<Task, 'due' | 'done'>>): Promise<Task> {
  await api('PUT', `/api/notes/${uuid}`, { markdown });
  return verify(uuid, expect);
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

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf8');
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

// --- команды -----------------------------------------------------------------

async function list(args: Args, state: 'due' | 'open' | 'done' | 'all'): Promise<never> {
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

  let markdown = source === '-' ? readStdin() : readFileSync(source, 'utf8');
  if (!markdown.trim()) throw new CliError('usage', 'пустой markdown');

  const extra = (str(args, '--tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  markdown = addTags(setKey(markdown, 'due', due), [...extra, TAG]);
  markdown = setKey(markdown, 'done', null);

  const note = await api<{ uuid: string; title: string; url: string }>('POST', '/api/notes', { markdown });
  const task = await verify(note.uuid, { due, done: null });

  return result(EXIT.ok, task, () => {
    console.log(task.url);
    console.error(`«${task.title}» → ${task.uuid}, срок ${task.due}`);
  });
}

async function get(args: Args): Promise<never> {
  const note = await readNote(need(args, 0, 'uuid'));
  return result(EXIT.ok, note, () => process.stdout.write(note.markdown.endsWith('\n') ? note.markdown : `${note.markdown}\n`));
}

async function done(args: Args): Promise<never> {
  const uuid = need(args, 0, 'uuid');
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

  const task = await saveNote(uuid, markdown, { done: date });
  return result(EXIT.ok, task, () => console.log(`выполнена: ${task.title}`));
}

async function snooze(args: Args): Promise<never> {
  const uuid = need(args, 0, 'uuid');
  const due = parseDate(need(args, 1, 'дата'));

  const note = await readNote(uuid);
  if (getKey(note.markdown, 'done')) warnings.push('задача выполнена: срок сменён, в очередь она вернётся только после reopen');

  const task = await saveNote(uuid, setKey(note.markdown, 'due', due), { due });
  return result(EXIT.ok, task, () => console.log(`срок ${task.due}: ${task.title}`));
}

async function reopen(args: Args): Promise<never> {
  const uuid = need(args, 0, 'uuid');
  const note = await readNote(uuid);

  const doneAt = getKey(note.markdown, 'done');
  if (!doneAt) throw new CliError('usage', 'задача не выполнена, снимать нечего');

  let markdown = setKey(note.markdown, 'done', null);
  if (getKey(markdown, 'stale_after') === doneAt) markdown = setKey(markdown, 'stale_after', null);

  const task = await saveNote(uuid, markdown, { done: null });
  return result(EXIT.ok, task, () => console.log(`снова открыта: ${task.title}, срок ${task.due ?? '—'}`));
}

async function doctor(): Promise<never> {
  const health = await api<{ ok: boolean; notes: number }>('GET', '/healthz', undefined, false);
  const source = tokenSource();
  const value = token();
  const open = await api<{ role: string; tasks: Task[] }>('GET', '/api/schedule?state=open');
  const due = open.tasks.filter((t) => t.overdue_days !== null && t.overdue_days >= 0).length;

  const data = {
    host,
    token: { source, length: value.length },
    role: open.role,
    notes: health.notes,
    open: open.tasks.length,
    due,
  };
  return result(EXIT.ok, data, () => {
    console.log(`сервер   ${host} — ok, заметок ${health.notes}`);
    console.log(`токен    ${source} (${value.length} символов), роль ${open.role}`);
    console.log(`задачи   открытых ${open.tasks.length}, из них пора делать ${due}`);
  });
}

// --- роутер ------------------------------------------------------------------

async function main(): Promise<never> {
  const argv = process.argv.slice(2);
  command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const args = parseArgs(command ? argv.slice(1) : argv);

  human = args.flags.has('--human');
  host = (str(args, '--host') ?? process.env.NOTES_HOST ?? DEFAULT_HOST).replace(/\/+$/, '');

  if (!command || args.flags.has('--help') || args.flags.has('-h')) {
    console.log(USAGE);
    process.exit(command || args.flags.size ? EXIT.ok : EXIT.tool);
  }

  switch (command) {
    case 'due':
      return list(args, 'due');
    case 'tasks':
      return list(args, args.flags.has('--all') ? 'all' : args.flags.has('--done') ? 'done' : 'open');
    case 'add':
      return add(args);
    case 'get':
      return get(args);
    case 'done':
      return done(args);
    case 'snooze':
      return snooze(args);
    case 'reopen':
      return reopen(args);
    case 'doctor':
      return doctor();
    case 'version':
      return result(EXIT.ok, { version: VERSION }, () => console.log(VERSION));
    default:
      throw new CliError('usage', `неизвестная команда «${command}», см. notes-kai --help`);
  }
}

main().catch((error: unknown) =>
  failure(error instanceof CliError ? error : new CliError('api', (error as Error).message ?? String(error))),
);
