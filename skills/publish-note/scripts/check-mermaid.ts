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
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

const mermaid = (await import('mermaid')).default;
const { readFileSync } = await import('node:fs');

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('usage: bun check-mermaid.ts <файл.md> [файл.md ...]');
  process.exit(2);
}

mermaid.initialize({ startOnLoad: false });

let failed = 0;
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
    checked++;

    try {
      await mermaid.render(`check-${index}`, code);
      console.log(`${file} — схема ${index + 1} (${kind}): ok`);
    } catch (error) {
      failed++;
      const message = String(error instanceof Error ? error.message : error).split('\n')[0];
      console.log(`${file} — схема ${index + 1} (${kind}): ОШИБКА — ${message}`);
    }
  }
}

console.log(`\nпроверено схем: ${checked}, с ошибками: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
