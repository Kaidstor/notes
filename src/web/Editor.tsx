import clsx from 'clsx';
import { ImagePlus } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { IMAGE_ACCEPT, imageAlt, imageFiles, uploadImage } from './lib/images.ts';
import type { VisualHandle } from './VisualEditor.tsx';

// Milkdown тянет ProseMirror и CodeMirror — грузим только тем, кто открыл «Вид».
const VisualEditor = lazy(() => import('./VisualEditor.tsx'));

type Mode = 'markdown' | 'visual';

const MODE_KEY = 'notes.editorMode';

const NEW_NOTE = '---\ntitle: \ntags: []\n---\n\n';

function storedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'visual' ? 'visual' : 'markdown';
  } catch {
    return 'markdown';
  }
}

/** Frontmatter вместе с закрывающим `---` и переводом строки после него. */
function splitFrontmatter(source: string): { front: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
  return match
    ? { front: match[0], body: source.slice(match[0].length) }
    : { front: '', body: source };
}

interface NotePayload {
  uuid: string;
  title: string;
  markdown: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Подсветка лежит под прозрачным textarea, поэтому слои обязаны совпадать по
// метрикам до пикселя: шрифт, кегль, интерлиньяж, отступы и перенос меняются
// только синхронно. Жирный и курсив в подсветке допустимы: у mono-шрифтов
// ширина глифа от начертания не меняется, точки переноса совпадают.
const LAYER = 'px-4 py-3.5 font-mono text-[13px] leading-[1.7] whitespace-pre-wrap break-words';

/** `initialUuid === null` — новая заметка: она появится на сервере при первом сохранении. */
export default function Editor({ uuid: initialUuid }: { uuid: string | null }) {
  const [uuid, setUuid] = useState(initialUuid);
  const [note, setNote] = useState<NotePayload | null>(null);
  const [text, setText] = useState(initialUuid ? '' : NEW_NOTE);
  const [savedText, setSavedText] = useState(initialUuid ? '' : NEW_NOTE);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [removing, setRemoving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [mode, setMode] = useState<Mode>(storedMode);
  // Снимок на момент входа в «Вид»: frontmatter правится отдельным полем, тело —
  // визуальным редактором, который читает исходник только при создании.
  const [visual, setVisual] = useState<{ key: number; front: string; body: string } | null>(null);
  const visualBody = useRef('');
  const visualRef = useRef<VisualHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // После удаления уходим на индекс мимо вопроса «покинуть страницу?»: заметки
  // уже нет, а состояние dirty до перехода обновиться не успеет.
  const leaving = useRef(false);

  const dirty = text !== savedText;
  const ready = initialUuid === null || note !== null;

  const openVisual = useCallback((source: string) => {
    const { front, body } = splitFrontmatter(source);
    visualBody.current = body;
    setVisual((prev) => ({ key: (prev?.key ?? 0) + 1, front, body }));
  }, []);

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      if (next === 'visual') openVisual(text);
      setMode(next);
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch {
        // приватный режим — выбор просто не запомнится
      }
    },
    [mode, openVisual, text],
  );

  useEffect(() => {
    if (!initialUuid) {
      if (storedMode() === 'visual') openVisual(NEW_NOTE);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/notes/${initialUuid}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(res.status === 404 ? 'Такой заметки нет' : `HTTP ${res.status}`);
        }
        return (await res.json()) as NotePayload;
      })
      .then((data) => {
        setNote(data);
        setText(data.markdown);
        setSavedText(data.markdown);
        if (storedMode() === 'visual') openVisual(data.markdown);
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setLoadError((err as Error).message);
      });
    return () => controller.abort();
  }, [initialUuid, openVisual]);

  useEffect(() => {
    document.title = note ? `${note.title} · правка` : uuid ? 'правка' : 'новая заметка';
  }, [note, uuid]);

  const save = useCallback(async () => {
    if (!dirty || saving || removing) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(uuid ? `/api/notes/${uuid}` : '/api/notes', {
        method: uuid ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        uuid: string;
        title: string;
        created_at?: string;
        updated_at: string;
      };
      setSavedText(text);
      setSavedAt(timeFmt.format(new Date()));
      if (uuid) {
        setNote((prev) =>
          prev ? { ...prev, title: data.title, updated_at: data.updated_at } : prev,
        );
      } else {
        // Адрес меняем без перехода: перезагрузка сбросила бы курсор и историю правок.
        history.replaceState(null, '', `/${data.uuid}/edit`);
        setUuid(data.uuid);
        setNote({
          uuid: data.uuid,
          title: data.title,
          markdown: text,
          tags: [],
          created_at: data.created_at ?? data.updated_at,
          updated_at: data.updated_at,
        });
      }
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, removing, text, uuid]);

  const insertImages = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setUploading((n) => n + files.length);
      setSaveError('');
      try {
        const images = await Promise.all(
          files.map(async (file) => ({ src: await uploadImage(file), alt: imageAlt(file) })),
        );
        if (mode === 'visual') {
          for (const { src, alt } of images) visualRef.current?.insertImage(src, alt);
        } else {
          // Курсор textarea переживает потерю фокуса: картинка встанет туда, где он был.
          textareaRef.current?.focus();
          document.execCommand(
            'insertText',
            false,
            images.map(({ src, alt }) => `![${alt}](${src})`).join('\n'),
          );
        }
      } catch (err) {
        setSaveError((err as Error).message);
      } finally {
        setUploading((n) => n - files.length);
      }
    },
    [mode],
  );

  useEffect(() => {
    // e.code, а не e.key: на русской раскладке Cmd+S приходит как «ы».
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const remove = useCallback(async () => {
    if (!note || removing || saving) return;
    if (!confirm(`Удалить заметку «${note.title}»? Отменить будет нельзя.`)) return;
    setRemoving(true);
    setSaveError('');
    try {
      const res = await fetch(`/api/notes/${uuid}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      leaving.current = true;
      location.href = '/';
    } catch (err) {
      setSaveError((err as Error).message);
      setRemoving(false);
    }
  }, [note, removing, saving, uuid]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const highlighted = useMemo(() => (mode === 'markdown' ? highlight(text) : null), [mode, text]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950">
        <div className="text-[14px] text-zinc-300">{loadError}</div>
        <a
          href="/"
          className="rounded-md border border-zinc-700 px-3 py-1 text-[12px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
        >
          к списку заметок
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-2.5">
          <a
            href={uuid ? `/${uuid}` : '/'}
            title={uuid ? 'К странице заметки' : 'К списку заметок'}
            className="shrink-0 font-mono text-[12px] text-zinc-500 hover:text-zinc-200"
          >
            {uuid ? '← заметка' : '← список'}
          </a>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300">
            {note?.title ?? (uuid ? '…' : 'Новая заметка')}
          </span>
          <span
            className={clsx(
              'shrink-0 font-mono text-[11px]',
              saveError ? 'text-red-400' : dirty || uploading ? 'text-amber-400' : 'text-zinc-600',
            )}
          >
            {saveError
              ? `ошибка: ${saveError}`
              : uploading
                ? 'загружаю картинку…'
                : dirty
                  ? 'изменено'
                  : savedAt
                    ? `сохранено ${savedAt}`
                    : ''}
          </span>
          <div className="flex shrink-0 rounded-md border border-zinc-800 p-0.5 text-[12px]">
            {(
              [
                ['markdown', 'Markdown'],
                ['visual', 'Вид'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => switchMode(value)}
                aria-pressed={mode === value}
                disabled={!ready}
                className={clsx(
                  'rounded px-2 py-0.5 transition-colors',
                  mode === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!ready}
            title="Вставить картинку. Ещё можно вставить из буфера (⌘V) или перетащить файл"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 py-1 text-[12px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:cursor-default disabled:text-zinc-700"
          >
            <ImagePlus size={13} />
            Фото
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              void insertImages(imageFiles(e.target.files));
              e.target.value = '';
            }}
          />
          {uuid && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={!note || saving || removing}
              className="shrink-0 rounded-md border border-zinc-800 px-3 py-1 text-[12px] text-zinc-500 transition-colors hover:border-red-900 hover:text-red-400 disabled:cursor-default disabled:text-zinc-700 disabled:hover:border-zinc-800"
            >
              {removing ? 'Удаляю…' : 'Удалить'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving || removing}
            className="shrink-0 rounded-md border border-sky-700 bg-sky-500/15 px-3 py-1 text-[12px] text-sky-300 transition-colors hover:bg-sky-500/25 disabled:cursor-default disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-600"
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {mode === 'visual' ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-925 transition-colors focus-within:border-sky-600">
              {visual?.front && (
                <textarea
                  value={visual.front}
                  onChange={(e) => {
                    const front = e.target.value;
                    setVisual((prev) => (prev ? { ...prev, front } : prev));
                    setText(front + visualBody.current);
                  }}
                  rows={visual.front.trimEnd().split('\n').length}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Frontmatter заметки"
                  className="block w-full resize-none border-b border-zinc-800 bg-transparent px-4 py-3 font-mono text-[12px] leading-[1.7] text-zinc-400 focus:outline-none"
                />
              )}
              {visual && (
                <Suspense
                  fallback={<div className="px-4 py-3.5 text-[13px] text-zinc-500">загружаю редактор…</div>}
                >
                  <VisualEditor
                    key={visual.key}
                    ref={visualRef}
                    initial={visual.body}
                    onChange={(body) => {
                      visualBody.current = body;
                      setText(visual.front + body);
                    }}
                    onError={setSaveError}
                  />
                </Suspense>
              )}
            </div>
          ) : (
            <div className="relative rounded-lg border border-zinc-800 bg-zinc-925 transition-colors focus-within:border-sky-600">
              <pre aria-hidden className={clsx(LAYER, 'pointer-events-none min-h-[75vh] text-zinc-300')}>
                {highlighted}
              </pre>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Tab печатает отступ; вставка через execCommand, чтобы не сломать Cmd+Z.
                  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    document.execCommand('insertText', false, '  ');
                  }
                }}
                onPaste={(e) => {
                  // Word и Pages кладут в буфер рядом с текстом его картинку-превью:
                  // если текст есть, вставляем текст.
                  if (e.clipboardData.types.includes('text/plain')) return;
                  const files = imageFiles(e.clipboardData.files);
                  if (!files.length) return;
                  e.preventDefault();
                  void insertImages(files);
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                }}
                onDrop={(e) => {
                  const files = imageFiles(e.dataTransfer.files);
                  if (!files.length) return;
                  e.preventDefault();
                  void insertImages(files);
                }}
                disabled={!ready}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                autoFocus
                aria-label="Markdown заметки"
                className={clsx(
                  LAYER,
                  'absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-sky-400 selection:bg-sky-500/25 focus:outline-none',
                )}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-2 font-mono text-[10.5px] text-zinc-600">
            <span>⌘S — сохранить</span>
            <span>·</span>
            <span>картинки — ⌘V или перетащить</span>
            <span>·</span>
            <span>{uuid ?? 'появится после сохранения'}</span>
            {note && note.tags.length > 0 && (
              <>
                <span>·</span>
                <span>{note.tags.join(', ')}</span>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// --- подсветка ---------------------------------------------------------------
// Красятся только span'ы поверх посимвольно того же текста: убрать или добавить
// хоть символ нельзя — слой разъедется с textarea.

const MARK = 'text-zinc-600';

function highlight(source: string): ReactNode[] {
  const lines = source.split('\n');
  const out: ReactNode[] = [];
  let fence = false;
  let front = false;

  lines.forEach((line, i) => {
    let node: ReactNode;

    if (i === 0 && /^---\s*$/.test(line)) {
      front = true;
      node = <span className={MARK}>{line}</span>;
    } else if (front) {
      if (/^---\s*$/.test(line)) {
        front = false;
        node = <span className={MARK}>{line}</span>;
      } else {
        const kv = /^([\w-]+\s*:)(.*)$/.exec(line);
        node = kv ? (
          <>
            <span className="text-violet-400">{kv[1]}</span>
            <span className="text-zinc-400">{kv[2]}</span>
          </>
        ) : (
          <span className="text-zinc-400">{line}</span>
        );
      }
    } else if (fence) {
      if (/^\s*(`{3,}|~{3,})\s*$/.test(line)) {
        fence = false;
        node = <span className={MARK}>{line}</span>;
      } else {
        node = <span className="text-emerald-300/90">{line}</span>;
      }
    } else {
      const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (open) {
        fence = true;
        node = (
          <>
            {open[1]}
            <span className={MARK}>{open[2]}</span>
            <span className="text-violet-400">{open[3]}</span>
          </>
        );
      } else {
        node = blockLine(line);
      }
    }

    out.push(
      <span key={i}>
        {node}
        {i < lines.length - 1 ? '\n' : ''}
      </span>,
    );
  });

  // Хвостовой \n сам по себе строки не даёт — без этого символа подложка ниже
  // textarea на последней пустой строке.
  out.push('\u200b');
  return out;
}

function blockLine(line: string): ReactNode {
  const h = /^(#{1,6})(\s+)(.*)$/.exec(line);
  if (h) {
    return (
      <>
        <span className="text-sky-600">{h[1]}</span>
        {h[2]}
        <span className="font-semibold text-sky-300">{inline(h[3]!)}</span>
      </>
    );
  }

  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return <span className={MARK}>{line}</span>;

  const quote = /^(\s*>+\s?)(.*)$/.exec(line);
  if (quote) {
    return (
      <>
        <span className="text-sky-600">{quote[1]}</span>
        <span className="text-zinc-400 italic">{inline(quote[2]!)}</span>
      </>
    );
  }

  const list = /^(\s*)([-*+]|\d{1,3}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (list) {
    return (
      <>
        {list[1]}
        <span className="text-sky-400">{list[2]}</span>
        {list[3]}
        {list[4] && <span className={MARK}>{list[4]}</span>}
        {inline(list[5]!)}
      </>
    );
  }

  if (/^\s*\|/.test(line)) {
    if (/^\s*[|\s:-]+$/.test(line)) return <span className={MARK}>{line}</span>;
    return line.split('|').map((cell, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: подсветка — чистая функция от строки
      <span key={i}>
        {i > 0 && <span className={MARK}>|</span>}
        {inline(cell)}
      </span>
    ));
  }

  return <>{inline(line)}</>;
}

/** Инлайновая разметка: сперва код (внутри него ничего не красим), потом остальное. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;

  for (const m of text.matchAll(/(`+)([^`]+?)\1/g)) {
    if (m.index! > last) out.push(...rich(text.slice(last, m.index), last));
    out.push(
      <span key={`code${m.index}`}>
        <span className={MARK}>{m[1]}</span>
        <span className="text-amber-300">{m[2]}</span>
        <span className={MARK}>{m[1]}</span>
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...rich(text.slice(last), last));

  return out;
}

const RICH =
  /\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|~~[^~\n]+~~|!?\[[^\]\n]*\]\([^)\n]*\)/g;

function rich(text: string, keyBase: number): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;

  for (const m of text.matchAll(RICH)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(richToken(m[0], keyBase + m.index!));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));

  return out;
}

function richToken(token: string, key: number): ReactNode {
  const link = /^(!?\[)([^\]]*)(\]\()([^)]*)(\))$/.exec(token);
  if (link) {
    return (
      <span key={key}>
        <span className={MARK}>{link[1]}</span>
        <span className="text-zinc-100">{link[2]}</span>
        <span className={MARK}>{link[3]}</span>
        <span className="text-sky-400">{link[4]}</span>
        <span className={MARK}>{link[5]}</span>
      </span>
    );
  }

  if (token.startsWith('~~')) {
    return (
      <span key={key} className="text-zinc-500 line-through">
        {token}
      </span>
    );
  }

  if (token.startsWith('**') || token.startsWith('__')) {
    const mark = token.slice(0, 2);
    return (
      <span key={key}>
        <span className={MARK}>{mark}</span>
        <span className="font-semibold text-zinc-50">{token.slice(2, -2)}</span>
        <span className={MARK}>{mark}</span>
      </span>
    );
  }

  return (
    <span key={key}>
      <span className={MARK}>{token[0]}</span>
      <span className="text-zinc-200 italic">{token.slice(1, -1)}</span>
      <span className={MARK}>{token[0]}</span>
    </span>
  );
}
