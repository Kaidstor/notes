import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/toolbar.css';
import '@milkdown/crepe/theme/common/table.css';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { insertImageCommand } from '@milkdown/kit/preset/commonmark';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import type { Node } from '@milkdown/kit/prose/model';
import { Decoration } from '@milkdown/kit/prose/view';
import { $remark, callCommand } from '@milkdown/kit/utils';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';

import { imageAlt, imageFiles, uploadImage } from './lib/images.ts';

type MdNode = { type: string; title?: string | null; children?: MdNode[] };

// Milkdown 7.22: у картинки без title парсер отдаёт title: null, ProseMirror
// отвергает узел, и `![](…)` молча пропадает из документа вместе с абзацем.
const imageTitleFix = $remark('imageTitleFix', () => () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (node.type === 'image' && node.title == null) node.title = '';
    node.children?.forEach(walk);
  };
  walk(tree);
});

export interface VisualHandle {
  insertImage: (src: string, alt: string) => void;
}

export default function VisualEditor({
  initial,
  onChange,
  onError,
  ref,
}: {
  /** Тело заметки без frontmatter: Milkdown его не знает и превратил бы в линию и абзац. */
  initial: string;
  onChange: (markdown: string) => void;
  onError: (message: string) => void;
  ref: Ref<VisualHandle>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const crepe = useRef<Crepe | null>(null);
  const handlers = useRef({ onChange, onError });
  handlers.current = { onChange, onError };

  useImperativeHandle(ref, () => ({
    insertImage: (src, alt) => crepe.current?.editor.action(callCommand(insertImageCommand.key, { src, alt })),
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial читается один раз при создании редактора
  useEffect(() => {
    const editor = new Crepe({
      root: root.current,
      defaultValue: initial,
      features: {
        // Блок-картинка пишет в alt свой масштаб (`![1.00](…)`) и затирает подпись.
        [Crepe.Feature.ImageBlock]: false,
        // Сервер формулы не рисует: `$…$` из обычного текста превратился бы в формулу.
        [Crepe.Feature.Latex]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: 'Текст заметки…', mode: 'doc' },
      },
    });

    editor.editor.use(imageTitleFix).config((ctx) => {
      // Ближе к тому, как пишут заметки руками и агенты: `-` в списках, таблица
      // без выравнивания пробелами. Иначе первая же правка перепишет весь файл.
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const, rule: '-' as const }));
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        uploadWidgetFactory: (pos, spec) => {
          const widget = document.createElement('span');
          widget.className = 'upload-widget';
          widget.textContent = 'загружаю картинку…';
          return Decoration.widget(pos, widget, spec);
        },
        uploader: async (files, schema) => {
          try {
            const nodes = await Promise.all(
              imageFiles(files).map(async (file) =>
                schema.nodes.image!.createAndFill({ src: await uploadImage(file), alt: imageAlt(file) }),
              ),
            );
            return nodes.filter((node): node is Node => node !== null);
          } catch (err) {
            handlers.current.onError((err as Error).message);
            return [];
          }
        },
      }));
    });

    // Сериализатор Milkdown переписывает markdown по-своему (маркеры списков,
    // экранирование, выравнивание таблиц). Пока правок не было, текст заметки
    // не трогаем вовсе, а вернувшись к исходному документу — отдаём исходник.
    let baseline: string | null = null;
    const lead = /^\s*/.exec(initial)![0];
    editor.on((listener) =>
      listener.markdownUpdated((_ctx, markdown) => {
        if (baseline === null) return;
        handlers.current.onChange(markdown === baseline ? initial : lead + markdown);
      }),
    );

    let alive = true;
    void editor.create().then(() => {
      if (!alive) return;
      baseline = editor.getMarkdown();
      crepe.current = editor;
    });

    return () => {
      alive = false;
      crepe.current = null;
      void editor.destroy();
    };
  }, []);

  return <div ref={root} className="visual-editor min-h-[75vh]" />;
}
