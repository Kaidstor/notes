import { Combobox } from '@base-ui/react/combobox';
import clsx from 'clsx';
import { Check, Pencil, Search, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { markChangelogSeen, unseenChangelog } from './lib/changelog.ts';
import { applyTheme, currentTheme, THEMES } from './lib/themes.ts';
import { WhatsNew } from './WhatsNew.tsx';

interface Note {
  uuid: string;
  title: string;
  tags: string[];
  stale_after: string | null;
  stale: boolean;
  created_at: string;
  updated_at: string;
  snippet: string;
}

interface TagCount {
  tag: string;
  count: number;
}

interface NotesResponse {
  site: string;
  role: 'admin' | 'read';
  total: number;
  staleCount: number;
  tags: TagCount[];
  notes: Note[];
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export default function App() {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [showStale, setShowStale] = useState(false);
  const [data, setData] = useState<NotesResponse>({
    site: 'notes',
    role: 'admin',
    total: 0,
    staleCount: 0,
    tags: [],
    notes: [],
  });
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(currentTheme);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (q: string, tags: string[], stale: boolean, signal: AbortSignal) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      for (const tag of tags) params.append('tag', tag);
      if (stale) params.set('stale', '1');

      const res = await fetch(`/api/notes?${params}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as NotesResponse;
    },
    [],
  );

  const toggleTag = useCallback((tag: string) => {
    setPicked((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);

  const tagsKey = picked.join('\u0000');

  const remove = useCallback(async (note: Note) => {
    if (!confirm(`Удалить заметку «${note.title}»? Отменить будет нельзя.`)) return;
    setError('');
    try {
      const res = await fetch(`/api/notes/${note.uuid}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Счётчики и теги считает сервер, поэтому список перезапрашивается целиком.
      setGeneration((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      load(query, tagsKey ? tagsKey.split('\u0000') : [], showStale, controller.signal)
        .then(setData)
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') console.error(err);
        })
        .finally(() => setLoading(false));
    }, 140);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, tagsKey, showStale, load, generation]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inSearch = document.activeElement === inputRef.current;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !isEditable(e.target))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 'Escape' && inSearch) {
        setQuery('');
        setPicked([]);
        setShowStale(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const unseen = unseenChangelog();
    if (unseen.length) setFresh(unseen.map((entry) => entry.date));
  }, []);

  const closeWhatsNew = useCallback(() => {
    markChangelogSeen();
    setFresh(null);
  }, []);

  const pickTheme = (id: string) => {
    applyTheme(id);
    setTheme(id);
  };

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 py-2.5">
          <span className="font-mono text-[12px] text-zinc-500">{data.site}</span>
          {data.role === 'read' && (
            <span
              title="Вход по токену публикации: в списке — только заметки, опубликованные им"
              className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-px font-mono text-[10px] text-zinc-500"
            >
              read
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setFresh([])}
            title="Что нового"
            aria-label="Что нового"
            className="rounded p-1 text-zinc-600 transition-colors hover:text-zinc-200"
          >
            <Sparkles size={13} />
          </button>
          <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 p-0.5">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pickTheme(t.id)}
                className={clsx(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  theme === t.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-600"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по заметкам"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pr-16 pl-7.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-zinc-600 hover:text-zinc-300"
              >
                <X size={13} />
              </button>
            ) : (
              <kbd className="absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[10px] text-zinc-600">
                ⌘K
              </kbd>
            )}
          </div>

          {data.role === 'read' && (
            <p className="pt-2.5 text-[11.5px] leading-relaxed text-zinc-500">
              Токен публикации принят: он открывает любую заметку по ссылке, а здесь
              показывает опубликованное им. Весь список заметок — под полным токеном.
            </p>
          )}

          {error && (
            <p className="flex items-center gap-2 pt-2.5 text-[11.5px] text-red-400">
              <span className="flex-1">Не удалилось: {error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                aria-label="Скрыть ошибку"
                className="rounded p-0.5 text-red-400/70 hover:text-red-300"
              >
                <X size={12} />
              </button>
            </p>
          )}

          {(data.tags.length > 0 || picked.length > 0) && (
            <TagPicker
              tags={data.tags}
              picked={picked}
              onChange={setPicked}
              onToggle={toggleTag}
            />
          )}

          <div className="flex items-center gap-1.5 pt-6 pb-3 text-[11px] font-semibold tracking-wider text-zinc-500">
            <span>
              {query || picked.length ? 'НАЙДЕНО' : data.role === 'read' ? 'МОИ ЗАМЕТКИ' : 'ЗАМЕТКИ'}
            </span>
            <span className="text-zinc-600">· {data.notes.length}</span>
            {(query || picked.length > 0) && data.total !== data.notes.length && (
              <span className="text-zinc-700">из {data.total}</span>
            )}
            {loading && <span className="text-zinc-700">…</span>}
            <span className="flex-1" />
            {(data.staleCount > 0 || showStale) && (
              <button
                type="button"
                onClick={() => setShowStale((v) => !v)}
                aria-pressed={showStale}
                title={
                  showStale
                    ? 'Скрыть заметки, срок которых по stale_after прошёл'
                    : 'Показать заметки, срок которых по stale_after прошёл'
                }
                className={clsx(
                  'rounded border px-1.5 py-px font-mono text-[10.5px] font-normal tracking-normal transition-colors',
                  showStale
                    ? 'border-sky-700 bg-sky-500/15 text-sky-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300',
                )}
              >
                устаревшие
                <span className="pl-1 text-zinc-600">{data.staleCount}</span>
              </button>
            )}
          </div>

          {data.notes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 py-12 text-center text-[12px] text-zinc-600">
              {query || picked.length
                ? 'Ничего не нашлось'
                : data.role === 'read'
                  ? 'Этим токеном пока ничего не опубликовано'
                  : 'Пока ни одной заметки'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {data.notes.map((note) => (
                <NoteCard
                  key={note.uuid}
                  note={note}
                  query={query}
                  picked={picked}
                  onTag={toggleTag}
                  onDelete={remove}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {fresh && <WhatsNew fresh={fresh} onClose={closeWhatsNew} />}
    </div>
  );
}

function NoteCard({
  note,
  query,
  picked,
  onTag,
  onDelete,
}: {
  note: Note;
  query: string;
  picked: string[];
  onTag: (tag: string) => void;
  onDelete: (note: Note) => void;
}) {
  return (
    // Ссылка растянута на всю карточку, а теги лежат выше неё по z — так карточка
    // остаётся кликабельной целиком, но тег не утаскивает на страницу заметки.
    <div
      className={clsx(
        'group relative rounded-lg border border-zinc-800 bg-zinc-925 px-3.5 py-3 transition-[border-color,opacity] hover:border-zinc-600',
        note.stale && 'opacity-55 hover:opacity-100',
      )}
    >
      <a href={`/${note.uuid}`} className="absolute inset-0 rounded-lg" aria-label={note.title} />
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{note.title}</span>
        <a
          href={`/${note.uuid}/edit`}
          title="Править"
          aria-label={`Править «${note.title}»`}
          className="relative z-10 shrink-0 self-center rounded p-0.5 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-zinc-200 focus-visible:opacity-100"
        >
          <Pencil size={12} />
        </a>
        <button
          type="button"
          onClick={() => onDelete(note)}
          title="Удалить"
          aria-label={`Удалить «${note.title}»`}
          className="relative z-10 shrink-0 self-center rounded p-0.5 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400 focus-visible:opacity-100"
        >
          <Trash2 size={12} />
        </button>
        {note.stale && note.stale_after && (
          <span className="shrink-0 rounded border border-amber-800/60 bg-amber-500/10 px-1.5 py-px font-mono text-[10px] text-amber-400/90">
            устарела {dateFmt.format(new Date(`${note.stale_after}T00:00:00`))}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-zinc-600">
          {dateFmt.format(new Date(note.updated_at))}
        </span>
      </div>

      {note.snippet && (
        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-zinc-400">
          <Highlight text={note.snippet} query={query} />
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="truncate font-mono text-[10.5px] text-zinc-600 group-hover:text-zinc-500">
          {note.uuid}
        </span>
        {note.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => onTag(tag)}
            aria-pressed={picked.includes(tag)}
            title={picked.includes(tag) ? `Убрать фильтр «${tag}»` : `Отобрать по тегу «${tag}»`}
            className={clsx(
              'relative z-10 shrink-0 rounded border px-1.5 py-px text-[10px] transition-colors',
              picked.includes(tag)
                ? 'border-sky-700 bg-sky-500/15 text-sky-300'
                : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
            )}
          >
            {tag}
          </button>
        ))}
      </div>
    </div>
  );
}

const QUICK_TAGS = 8;

function TagPicker({
  tags,
  picked,
  onChange,
  onToggle,
}: {
  tags: TagCount[];
  picked: string[];
  onChange: (tags: string[]) => void;
  onToggle: (tag: string) => void;
}) {
  const items = useMemo(() => tags.map((t) => t.tag), [tags]);
  const counts = useMemo(() => new Map(tags.map((t) => [t.tag, t.count])), [tags]);

  return (
    <div className="flex flex-col gap-1.5 pt-3">
      <div className="flex flex-wrap items-center gap-1">
        {tags.slice(0, QUICK_TAGS).map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            aria-pressed={picked.includes(tag)}
            className={clsx(
              'rounded border px-1.5 py-px font-mono text-[10.5px] transition-colors',
              picked.includes(tag)
                ? 'border-sky-700 bg-sky-500/15 text-sky-300'
                : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300',
            )}
          >
            {tag}
            <span className="pl-1 text-zinc-600">{count}</span>
          </button>
        ))}
        {picked.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="px-1.5 py-px text-[10.5px] text-zinc-600 hover:text-zinc-300"
          >
            сбросить
          </button>
        )}
      </div>

      <Combobox.Root
        items={items}
        multiple
        value={picked}
        onValueChange={(value: string[]) => onChange(value)}
        autoHighlight
      >
        <Combobox.InputGroup className="flex min-h-[30px] cursor-text flex-wrap items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 focus-within:border-sky-600">
          <Combobox.Value>
            {(value: string[]) => (
              <Combobox.Chips className="flex w-full flex-wrap items-center gap-1">
                {value.map((tag) => (
                  <Combobox.Chip
                    key={tag}
                    aria-label={tag}
                    className="flex items-center gap-0.5 rounded border border-sky-700 bg-sky-500/15 py-px pr-0.5 pl-1.5 font-mono text-[10.5px] text-sky-300 outline-none focus-within:border-sky-500 data-highlighted:border-sky-500"
                  >
                    {tag}
                    <Combobox.ChipRemove
                      aria-label={`Убрать тег «${tag}»`}
                      className="rounded p-px text-sky-400/70 hover:bg-sky-500/20 hover:text-sky-200"
                    >
                      <X size={10} />
                    </Combobox.ChipRemove>
                  </Combobox.Chip>
                ))}
                <Combobox.Input
                  placeholder={value.length ? '' : 'теги…'}
                  spellCheck={false}
                  className="h-5 min-w-16 flex-1 border-0 bg-transparent p-0 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
                />
              </Combobox.Chips>
            )}
          </Combobox.Value>
        </Combobox.InputGroup>

        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} className="z-50 outline-none">
            <Combobox.Popup className="max-h-[min(var(--available-height),18rem)] w-(--anchor-width) max-w-(--available-width) overflow-y-auto overscroll-contain rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-lg shadow-black/40">
              <Combobox.Empty>
                <div className="px-2.5 py-1.5 text-[12px] text-zinc-600">Такого тега нет</div>
              </Combobox.Empty>
              <Combobox.List>
                {(tag: string) => (
                  <Combobox.Item
                    key={tag}
                    value={tag}
                    className="grid cursor-default grid-cols-[12px_1fr_auto] items-center gap-2 px-2.5 py-1 font-mono text-[11.5px] text-zinc-300 outline-none select-none data-highlighted:bg-zinc-800 data-highlighted:text-zinc-100 data-selected:text-sky-300"
                  >
                    <Combobox.ItemIndicator className="col-start-1">
                      <Check size={11} />
                    </Combobox.ItemIndicator>
                    <span className="col-start-2 truncate">{tag}</span>
                    <span className="col-start-3 text-[10.5px] text-zinc-600">{counts.get(tag)}</span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;

  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: подсветка — чистая функция от строки
          <mark key={i} className="rounded-sm bg-sky-500/20 px-0.5 text-sky-300">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable)
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
