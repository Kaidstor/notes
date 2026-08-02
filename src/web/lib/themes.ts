// Темы как в sql-kai: UI написан на zinc-шкале Tailwind плюс несколько
// семантических акцентов, Tailwind v4 компилирует утилиты в `var(--color-*)`,
// поэтому тема — это набор переопределений CSS-переменных на <html>.
// Светлые темы инвертируют шкалу: zinc-950 остаётся «фоном приложения»,
// zinc-100 — «основным текстом».
export interface Theme {
  id: string;
  label: string;
  light?: boolean;
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  { id: 'dark', label: 'Dark', vars: {} },
  {
    id: 'github-dark',
    label: 'GitHub',
    vars: {
      '--color-zinc-50': '#f0f6fc',
      '--color-zinc-100': '#e6edf3',
      '--color-zinc-200': '#c9d1d9',
      '--color-zinc-300': '#b1bac4',
      '--color-zinc-400': '#8b949e',
      '--color-zinc-500': '#6e7681',
      '--color-zinc-600': '#484f58',
      '--color-zinc-700': '#30363d',
      '--color-zinc-800': '#21262d',
      '--color-zinc-900': '#161b22',
      '--color-zinc-925': '#11161d',
      '--color-zinc-950': '#0d1117',
      '--color-sky-400': '#58a6ff',
      '--color-sky-500': '#388bfd',
      '--color-sky-600': '#1f6feb',
    },
  },
  {
    id: 'light',
    label: 'Light',
    light: true,
    vars: {
      '--color-zinc-50': '#09090b',
      '--color-zinc-100': '#18181b',
      '--color-zinc-200': '#27272a',
      '--color-zinc-300': '#3f3f46',
      '--color-zinc-400': '#52525b',
      '--color-zinc-500': '#71717a',
      '--color-zinc-600': '#a1a1aa',
      '--color-zinc-700': '#d4d4d8',
      '--color-zinc-800': '#e4e4e7',
      '--color-zinc-900': '#f4f4f5',
      '--color-zinc-925': '#ffffff',
      '--color-zinc-950': '#fafafa',
      '--color-sky-300': '#0284c7',
      '--color-sky-400': '#0284c7',
      '--color-sky-500': '#0284c7',
      '--color-sky-600': '#0369a1',
      // Акценты подсветки markdown в редакторе: дефолтные 300-е тона Tailwind
      // на белом фоне нечитаемы, значения — из светлой палитры страниц заметок.
      '--color-amber-300': '#b45309',
      '--color-amber-400': '#b45309',
      '--color-emerald-300': '#059669',
      '--color-violet-400': '#7c3aed',
      '--color-red-400': '#dc2626',
    },
  },
];

const STORAGE_KEY = 'notes.theme';

export function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  const root = document.documentElement;

  for (const t of THEMES) {
    for (const key of Object.keys(t.vars)) root.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(theme.vars)) root.style.setProperty(key, value);

  root.style.colorScheme = theme.light ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEY, theme.id);
}

export function currentTheme(): string {
  return localStorage.getItem(STORAGE_KEY) ?? 'dark';
}
