import { marked, Renderer, type Tokens } from 'marked';

export interface TocItem {
  id: string;
  text: string;
  depth: number;
}

export interface RenderedNote {
  title: string;
  html: string;
  toc: TocItem[];
  plain: string;
}

export interface Frontmatter {
  title?: string;
  uuid?: string;
  tags?: string[];
  /** OKF `stale_after`: с этой даты (`YYYY-MM-DD`) заметка считается устаревшей. */
  stale_after?: string;
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    heading(token: Tokens.Heading) {
      const text = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${slugify(token.text)}">${text}</h${token.depth}>\n`;
    },
    code(token: Tokens.Code) {
      const name = token.lang?.split(/\s/)[0];
      // Схему не подсвечиваем как код: исходник кладём как есть, рисует его
      // mermaid уже в браузере (страница подключает его, увидев class="mermaid").
      if (name === 'mermaid') {
        return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
      }
      const lang = name ? ` data-lang="${escapeHtml(name)}"` : '';
      return `<pre${lang}><code>${escapeHtml(token.text)}</code></pre>\n`;
    },
    table(token: Tokens.Table) {
      // Таблица шире колонки иначе вылезает поверх оглавления: скроллится обёртка,
      // а не страница.
      return `<div class="tablewrap">${Renderer.prototype.table.call(this, token)}</div>\n`;
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const external = /^https?:\/\//i.test(token.href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(token.href)}"${title}${attrs}>${text}</a>`;
    },
  },
});

/** `---\ntitle: …\ntags: a, b\n---` в начале файла. Значения — плоские строки. */
export function parseFrontmatter(source: string): { data: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };

  const data: Frontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    // Только ключи с колонки 0: у OKF-frontmatter вложенный `sources[].title`
    // иначе перебивает заголовок заметки.
    const kv = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;

    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '');

    if (key === 'title') data.title = value;
    if (key === 'uuid') data.uuid = value;
    if (key === 'stale_after') {
      const date = unquote(stripYamlComment(kv[2]!.trim()));
      if (isIsoDate(date)) data.stale_after = date;
    }
    if (key === 'tags') {
      data.tags = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }

  return { data, body: source.slice(match[0].length) };
}

/**
 * Хвостовой YAML-комментарий (` # …`) вне кавычек. Только для stale_after:
 * в title ` #` встречается как текст («Issue #5»), и там его не режем.
 */
function stripYamlComment(value: string): string {
  const quoted = /^(["'])(.*?)\1(\s+#.*)?$/.exec(value);
  if (quoted) return `${quoted[1]}${quoted[2]}${quoted[1]}`;
  return value.replace(/\s+#.*$/, '');
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

/** Строго `YYYY-MM-DD` и реальная дата: `2026-02-30` отвергается, а не переезжает на март. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function renderMarkdown(source: string, fallbackTitle?: string): RenderedNote {
  const tokens = marked.lexer(source);

  // Заголовок страницы рисуется шапкой — ведущий H1 из тела убираем, иначе он
  // продублируется.
  let title = fallbackTitle?.trim();
  const firstHeading = tokens.find((t) => t.type !== 'space') as Tokens.Heading | undefined;
  if (firstHeading?.type === 'heading' && firstHeading.depth === 1) {
    title ||= firstHeading.text.trim();
    tokens.splice(tokens.indexOf(firstHeading), 1);
  }

  const toc: TocItem[] = tokens
    .filter((t): t is Tokens.Heading => t.type === 'heading' && t.depth >= 2 && t.depth <= 3)
    .map((t) => ({ id: slugify(t.text), text: t.text, depth: t.depth }));

  const html = marked.parser(tokens);

  return {
    title: title || 'Без названия',
    html,
    toc,
    plain: htmlToPlain(html),
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
