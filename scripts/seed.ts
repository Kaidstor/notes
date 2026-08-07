/**
 * Наполнение локальной базы демо-заметками: bun scripts/seed.ts
 * Пишет напрямую в SQLite, минуя HTTP — токен не нужен.
 */
import { upsertNote } from '../src/server/db.ts';
import { parseFrontmatter, renderMarkdown } from '../src/server/render.ts';

const SAMPLES: { uuid: string; file?: string; markdown?: string; tags: string[] }[] = [
  {
    uuid: '0f0f9d4c-2b1e-4a7e-9d3f-6a1c8e2b4d51',
    file: '/Users/kaidstor/Projects/rebrandy/hidden-domains/docs/reverse-ip-discovery.md',
    tags: ['recon', 'whois'],
  },
  {
    uuid: '7c2b4a90-5d3e-4f18-b6a2-1e9c7d5f3a82',
    tags: ['инфра', 'traefik'],
    markdown: `---
title: Деплой на my-vpn
tags: инфра, traefik
---

# Деплой на my-vpn

Всё на сервере крутится в docker за **traefik v3**. Роутинг описан двумя способами
сразу: file-провайдер \`/app/traefik/dynamic.yml\` (с \`watch: true\`) и docker-провайдер
с \`exposedByDefault: false\`.

## Как добавить сервис

1. Положить \`compose.yml\` в \`/app/<имя>/\`.
2. Подключить контейнер к сети \`vpn\`.
3. Описать роутер и сервис в \`dynamic.yml\` — traefik подхватит без рестарта.

\`\`\`yaml
services:
  notes:
    image: notes:latest
    networks: [vpn]
    restart: unless-stopped
\`\`\`

<div class="warn">
Сертификаты выдаёт резолвер <code>myresolver</code> по TLS-challenge. Порт 80 занят
редиректом на https — новый сервис наружу не публикуем, только внутрь сети <code>vpn</code>.
</div>

## Проверка

| Что | Команда |
| --- | --- |
| Логи traefik | \`docker logs -f traefik\` |
| Живость | \`curl -sI https://notes.kaidstor.ru\` |
| Сертификат | \`openssl s_client -connect notes.kaidstor.ru:443\` |
`,
  },
  {
    uuid: 'b3d81f26-9a47-4c05-8e12-4f7b2c6d90a3',
    tags: ['заметка'],
    markdown: `---
title: Как это работает
tags: заметка
---

# Как это работает

Заметка публикуется скиллом \`publish-note\`: markdown уезжает POST-запросом на
сервер, там рендерится в эту вёрстку и получает адрес вида \`{домен}/{uuid}\`.

## Что доступно в markdown

Обычный GFM плюс **сырые HTML-блоки** — их рендерер пропускает как есть, так что
можно вставлять свою вёрстку под готовые классы.

<div class="note">
<b>.note</b> — синяя врезка для важного контекста.
</div>

<div class="ok">
<b>.ok</b> — зелёная, для «сделано / работает».
</div>

<div class="cards">
  <div class="card"><h4>.cards + .card</h4>Сетка карточек, которая сама переносится по ширине.</div>
  <div class="card"><h4>kbd</h4>Клавиши: <kbd>⌘</kbd> <kbd>K</kbd> — фокус в поиск.</div>
</div>

## Код и таблицы

\`\`\`ts
const note = await publish({ title: 'Привет', markdown });
console.log(note.url);
\`\`\`

> Цитата выглядит так — тонкая линия слева и приглушённый текст.

- Список с маркерами
- Второй пункт
- И третий
`,
  },
];

for (const sample of SAMPLES) {
  const source = sample.file ? await Bun.file(sample.file).text() : sample.markdown!;
  const { data, body } = parseFrontmatter(source);
  const rendered = renderMarkdown(body, data.title);

  upsertNote({
    uuid: sample.uuid,
    title: rendered.title,
    markdown: source,
    html: rendered.html,
    toc: JSON.stringify(rendered.toc),
    plain: rendered.plain,
    tags: data.tags ?? sample.tags,
    owner: 'admin',
  });

  console.log(`+ ${sample.uuid}  ${rendered.title}`);
}
