import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { applyTheme, currentTheme, THEMES } from './lib/themes.ts';

interface Note {
  uuid: string;
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  snippet: string;
}

interface NotesResponse {
  site: string;
  total: number;
  notes: Note[];
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export default function App() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<NotesResponse>({ site: 'notes', total: 0, notes: [] });
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(currentTheme);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (q: string, signal: AbortSignal) => {
    const res = await fetch(`/api/notes?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as NotesResponse;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      load(query, controller.signal)
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
  }, [query, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === inputRef.current;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 'Escape' && typing) {
        setQuery('');
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          <span className="flex-1" />
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

          <div className="flex items-center gap-1.5 pt-6 pb-3 text-[11px] font-semibold tracking-wider text-zinc-500">
            <span>{query ? 'НАЙДЕНО' : 'ЗАМЕТКИ'}</span>
            <span className="text-zinc-600">· {data.notes.length}</span>
            {query && data.total !== data.notes.length && (
              <span className="text-zinc-700">из {data.total}</span>
            )}
            {loading && <span className="text-zinc-700">…</span>}
          </div>

          {data.notes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 py-12 text-center text-[12px] text-zinc-600">
              {query ? 'Ничего не нашлось' : 'Пока ни одной заметки'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {data.notes.map((note) => (
                <NoteCard key={note.uuid} note={note} query={query} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function NoteCard({ note, query }: { note: Note; query: string }) {
  return (
    <a
      href={`/${note.uuid}`}
      className="group block rounded-lg border border-zinc-800 bg-zinc-925 px-3.5 py-3 transition-colors hover:border-zinc-600"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{note.title}</span>
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
          <span
            key={tag}
            className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-px text-[10px] text-zinc-400"
          >
            {tag}
          </span>
        ))}
      </div>
    </a>
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
