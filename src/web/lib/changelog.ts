/** «Что нового»: записи, отсортированные от свежих к старым. Дата — идентификатор
 *  записи, по ней же считается, что пользователь уже видел (localStorage). */
export interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-08-03',
    title: 'Блоки кода и «что нового»',
    items: [
      'У блока кода по наведению появляется панель: «копировать» и «перенос».',
      'Длинные строки в коде переносятся по умолчанию — горизонтальный скролл возвращает кнопка «перенос».',
      'Эта самая история изменений: всплывает после обновления, открыть заново — по иконке в шапке.',
    ],
  },
  {
    date: '2026-08-02',
    title: 'Правка заметок в браузере',
    items: [
      'Редактор с подсветкой markdown по кнопке «править» на странице заметки.',
      'На страницах заметок появился favicon.',
    ],
  },
  {
    date: '2026-07-29',
    title: 'Схемы mermaid',
    items: [
      'Схемы рисуются прямо на странице, их можно двигать и приближать во врезке или открыть на весь экран.',
      'Фильтр списка заметок по тегам.',
      'Колонка контента уже — длинные строки текста стало легче читать.',
    ],
  },
];

const SEEN_KEY = 'notes.changelogSeen';

const latest = (): string => CHANGELOG[0]?.date ?? '';

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markChangelogSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, latest());
  } catch {
    // приватный режим — покажем историю ещё раз, это не страшно
  }
}

/**
 * Записи, которых пользователь ещё не видел. Первый визит молчит: отметка
 * ставится сразу, чтобы новичку не прилетала история изменений с порога.
 */
export function unseenChangelog(): ChangelogEntry[] {
  const seen = readSeen();
  if (seen === null) {
    markChangelogSeen();
    return [];
  }
  return CHANGELOG.filter((entry) => entry.date > seen);
}
