#!/usr/bin/env bun
/**
 * Проверка mermaid-схем в markdown перед публикацией.
 *
 * Гоча: гоняем render, а не parse. Гантт, у которого в подписи задачи есть
 * двоеточие, parse проходит молча (id задачи при этом не регистрируется), а
 * падает уже отрисовка на ссылке `after <id>` — заметка публикуется «зелёной»,
 * а на странице вместо схемы «Syntax error in text».
 *
 * Гоча: DOM регистрируется до импорта mermaid — тот на импорте дёргает
 * DOMPurify.addHook, и без window импорт падает. Отсюда динамический import.
 *
 * Гоча: соотношение сторон здесь проверить НЕЛЬЗЯ, и пытаться не стоит. Под
 * happy-dom render отдаёт пустую строку вместо SVG (в DOM его тоже не остаётся,
 * контейнером не лечится): раскладка отрабатывает достаточно, чтобы поймать
 * синтаксис, но сериализации нет — а без viewBox мерить нечего. Проверка
 * соотношения живёт в SKILL.md и делается на живой странице.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

const mermaid = (await import('mermaid')).default;
const { readFileSync } = await import('node:fs');

/**
 * Отказы happy-dom, а не поломка схемы — в браузере такие схемы рисуются.
 * Гасим до предупреждения, иначе ложный отказ неотличим от настоящего по коду
 * возврата. Оба случая наступают уже ПОСЛЕ успешного parse, так что синтаксис
 * к этому моменту проверен:
 *  - «suitable point» — ромбовидный узел с подписанным ребром во flowchart;
 *  - «svg element not in render tree» — любой sequenceDiagram: happy-dom не
 *    держит svg в render tree, реальные ошибки синтаксиса приходят раньше и
 *    с другим текстом.
 */
const HAPPY_DOM_LIMITATIONS = [
  'Could not find a suitable point for the given distance',
  'svg element not in render tree',
];

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('usage: bun check-mermaid.ts <файл.md> [файл.md ...]');
  process.exit(2);
}

mermaid.initialize({ startOnLoad: false });

let failed = 0;
let warned = 0;
let checked = 0;

for (const file of files) {
  const markdown = readFileSync(file, 'utf8');
  const blocks = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

  if (blocks.length === 0) {
    console.log(`${file}: схем нет`);
    continue;
  }

  for (const [index, code] of blocks.entries()) {
    const kind = code.trim().split('\n')[0];
    const label = `${file} — схема ${index + 1} (${kind})`;
    checked++;

    try {
      await mermaid.render(`check-${index}`, code);
      console.log(`${label}: ok`);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).split(
        '\n',
      )[0];

      if (HAPPY_DOM_LIMITATIONS.some((limitation) => message.includes(limitation))) {
        warned++;
        console.log(
          `${label}: предупреждение — ограничение happy-dom, а не схемы; посмотреть опубликованную страницу глазами`,
        );
        continue;
      }

      failed++;
      console.log(`${label}: ОШИБКА — ${message}`);
    }
  }
}

const summary = [`проверено схем: ${checked}`, `с ошибками: ${failed}`];

if (warned) {
  summary.push(`предупреждений: ${warned}`);
}

console.log(`\n${summary.join(', ')}`);
console.log('соотношение сторон здесь не проверяется — см. SKILL.md, раздел про mermaid');

process.exit(failed > 0 ? 1 : 0);
