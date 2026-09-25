import { Combobox } from '@base-ui/react/combobox';
import clsx from 'clsx';
import { Check, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { changelogKey, markChangelogSeen, unseenChangelog } from './lib/changelog.ts';
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
    if (unseen.length) setFresh(unseen.map(changelogKey));
  }, []);

  const closeWhatsNew = useCallback(() => {
    markChangelogSeen();
    setFresh(null);
  }, []);

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <header className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-[14px]">
        <div className="mx-auto flex w-full max-w-[860px] items-center gap-2.5 px-6 py-2.5">
          <span className="text-[13.5px] text-zinc-500">{data.site}</span>
          {data.role === 'read' && (
            <span
              title="Вход по токену публикации: в списке — только заметки, опубликованные им"
              className="rounded-full bg-zinc-925 px-2.5 py-0.5 text-[12px] text-zinc-400"
            >
              read
            </span>
          )}
          <span className="flex-1" />
          <a
            href="/new"
            className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-3 py-0.5 text-[12.5px] text-sky-300 transition-colors hover:bg-sky-500/25"
          >
            <Plus size={12} />
            новая заметка
          </a>
          <button
            type="button"
            onClick={() => setFresh([])}
            className="inline-flex items-center gap-1.5 rounded-full bg-zinc-925 px-3 py-0.5 text-[12.5px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
          >
            <Sparkles size={12} />
            что нового
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-6 pt-12 pb-24">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 pb-6">
            <h1 className="text-[32px] leading-tight font-medium tracking-[-0.025em] text-zinc-100">
              {query || picked.length ? 'Найдено' : data.role === 'read' ? 'Мои заметки' : 'Заметки'}
            </h1>
            <span className="text-[14px] text-zinc-500 tabular-nums">
              {data.notes.length}
              {(query || picked.length > 0) && data.total !== data.notes.length && (
                <span className="text-zinc-600"> из {data.total}</span>
              )}
              {loading && <span className="text-zinc-600"> …</span>}
            </span>
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
                  'self-center rounded-full px-3 py-0.5 text-[12.5px] transition-colors',
                  showStale
                    ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
                    : 'bg-zinc-925 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
                )}
              >
                устаревшие
                <span className="pl-1.5 text-zinc-500 tabular-nums">{data.staleCount}</span>
              </button>
            )}
          </div>

          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-zinc-500"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по заметкам"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-full border border-zinc-800 bg-zinc-925 py-2 pr-16 pl-10 text-[14px] text-zinc-100 transition-colors placeholder:text-zinc-500 focus:border-zinc-700 focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Очистить поиск"
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
              >
                <X size={13} />
              </button>
            ) : (
              <kbd className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md border border-b-2 border-zinc-700 bg-zinc-900 px-1.5 text-[11px] text-zinc-400">
                ⌘K
              </kbd>
            )}
          </div>

          {data.role === 'read' && (
            <p className="px-1 pt-3 text-[13px] leading-relaxed text-zinc-500">
              Токен публикации принят: он открывает любую заметку по ссылке, а здесь
              показывает опубликованное им. Весь список заметок — под полным токеном.
            </p>
          )}

          {error && (
            <p className="mt-3 flex items-center gap-2 rounded-[14px] bg-red-400/10 px-4 py-2.5 text-[13px] text-red-400">
              <span className="flex-1">Не удалилось: {error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                aria-label="Скрыть ошибку"
                className="rounded-full p-1 text-red-400/70 hover:bg-red-400/15 hover:text-red-300"
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

          {data.notes.length === 0 ? (
            <div className="mt-8 rounded-[14px] bg-zinc-925 py-14 text-center text-[14px] text-zinc-500">
              {query || picked.length
                ? 'Ничего не нашлось'
                : data.role === 'read'
                  ? 'Этим токеном пока ничего не опубликовано'
                  : 'Пока ни одной заметки'}
            </div>
          ) : (
            <div className="mt-8 flex flex-col gap-2.5">
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
        'group relative rounded-[14px] bg-zinc-925 px-[18px] py-4 transition-[background-color,opacity] hover:bg-zinc-900',
        note.stale && 'opacity-55 hover:opacity-100',
      )}
    >
      <a href={`/${note.uuid}`} className="absolute inset-0 rounded-[14px]" aria-label={note.title} />
      <div className="flex items-baseline gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium tracking-[-0.01em] text-zinc-100">
          {note.title}
        </span>
        <a
          href={`/${note.uuid}/edit`}
          title="Править"
          aria-label={`Править «${note.title}»`}
          className="relative z-10 shrink-0 self-center rounded-full p-1 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:opacity-100"
        >
          <Pencil size={13} />
        </a>
        <button
          type="button"
          onClick={() => onDelete(note)}
          title="Удалить"
          aria-label={`Удалить «${note.title}»`}
          className="relative z-10 shrink-0 self-center rounded-full p-1 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-400/15 hover:text-red-400 focus-visible:opacity-100"
        >
          <Trash2 size={13} />
        </button>
        {note.stale && note.stale_after && (
          <span className="shrink-0 self-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[12px] text-amber-400">
            устарела {dateFmt.format(new Date(`${note.stale_after}T00:00:00`))}
          </span>
        )}
        <span className="shrink-0 text-[13px] text-zinc-500 tabular-nums">
          {dateFmt.format(new Date(note.updated_at))}
        </span>
      </div>

      {note.snippet && (
        <p className="mt-1.5 line-clamp-2 text-[14px] leading-relaxed text-zinc-400">
          <Highlight text={note.snippet} query={query} />
        </p>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        {note.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => onTag(tag)}
            aria-pressed={picked.includes(tag)}
            title={picked.includes(tag) ? `Убрать фильтр «${tag}»` : `Отобрать по тегу «${tag}»`}
            className={clsx(
              'relative z-10 shrink-0 rounded-full px-2.5 py-0.5 text-[12px] transition-colors',
              picked.includes(tag)
                ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
                : 'bg-zinc-900 text-zinc-400 group-hover:bg-zinc-800 hover:text-zinc-100',
            )}
          >
            {tag}
          </button>
        ))}
        <span className="min-w-0 truncate pl-1 font-mono text-[11px] text-zinc-600 group-hover:text-zinc-500">
          {note.uuid}
        </span>
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
    <div className="flex flex-col gap-2.5 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.slice(0, QUICK_TAGS).map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            aria-pressed={picked.includes(tag)}
            className={clsx(
              'rounded-full px-2.5 py-0.5 text-[12.5px] transition-colors',
              picked.includes(tag)
                ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
                : 'bg-zinc-925 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
            )}
          >
            {tag}
            <span className="pl-1.5 text-zinc-500 tabular-nums">{count}</span>
          </button>
        ))}
        {picked.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="rounded-full px-2.5 py-0.5 text-[12.5px] text-zinc-500 hover:bg-zinc-925 hover:text-zinc-100"
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
        <Combobox.InputGroup className="flex min-h-[38px] cursor-text flex-wrap items-center gap-1 rounded-[19px] border border-zinc-800 bg-zinc-925 px-2 py-1.5 transition-colors focus-within:border-zinc-700">
          <Combobox.Value>
            {(value: string[]) => (
              <Combobox.Chips className="flex w-full flex-wrap items-center gap-1">
                {value.map((tag) => (
                  <Combobox.Chip
                    key={tag}
                    aria-label={tag}
                    className="flex items-center gap-0.5 rounded-full bg-sky-500/15 py-0.5 pr-1 pl-2.5 text-[12px] text-sky-300 outline-none data-highlighted:bg-sky-500/30"
                  >
                    {tag}
                    <Combobox.ChipRemove
                      aria-label={`Убрать тег «${tag}»`}
                      className="rounded-full p-0.5 text-sky-400/70 hover:bg-sky-500/20 hover:text-sky-200"
                    >
                      <X size={11} />
                    </Combobox.ChipRemove>
                  </Combobox.Chip>
                ))}
                <Combobox.Input
                  placeholder={value.length ? '' : 'Теги…'}
                  spellCheck={false}
                  className="h-6 min-w-16 flex-1 border-0 bg-transparent px-2 py-0 text-[14px] text-zinc-100 outline-none placeholder:text-zinc-500"
                />
              </Combobox.Chips>
            )}
          </Combobox.Value>
        </Combobox.InputGroup>

        <Combobox.Portal>
          <Combobox.Positioner sideOffset={6} className="z-50 outline-none">
            <Combobox.Popup className="max-h-[min(var(--available-height),18rem)] w-(--anchor-width) max-w-(--available-width) overflow-y-auto overscroll-contain rounded-[14px] bg-zinc-925 p-1.5 shadow-xl shadow-black/30 ring-1 ring-zinc-800">
              <Combobox.Empty>
                <div className="px-3 py-1.5 text-[13px] text-zinc-500">Такого тега нет</div>
              </Combobox.Empty>
              <Combobox.List>
                {(tag: string) => (
                  <Combobox.Item
                    key={tag}
                    value={tag}
                    className="grid cursor-default grid-cols-[14px_1fr_auto] items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px] text-zinc-300 outline-none select-none data-highlighted:bg-zinc-900 data-highlighted:text-zinc-100 data-selected:text-sky-300"
                  >
                    <Combobox.ItemIndicator className="col-start-1">
                      <Check size={12} />
                    </Combobox.ItemIndicator>
                    <span className="col-start-2 truncate">{tag}</span>
                    <span className="col-start-3 text-[12px] text-zinc-500 tabular-nums">{counts.get(tag)}</span>
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
