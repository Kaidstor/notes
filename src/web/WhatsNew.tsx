import clsx from 'clsx';
import { Sparkles, X } from 'lucide-react';
import { useEffect } from 'react';

import { CHANGELOG } from './lib/changelog.ts';

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

/** `fresh` — даты записей, помеченных как новые для этого пользователя. */
export function WhatsNew({ fresh, onClose }: { fresh: string[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // capture: у приложения свой обработчик Escape на window, он не должен
    // одновременно с закрытием сбрасывать поиск.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Что нового"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-zinc-700 bg-zinc-925 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Sparkles size={14} className="text-sky-400" />
          <h2 className="flex-1 text-[13px] font-semibold text-zinc-100">Что нового</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">
          {CHANGELOG.map((entry) => (
            <div key={entry.date}>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-zinc-100">{entry.title}</span>
                {fresh.includes(entry.date) && (
                  <span className="rounded border border-sky-700 bg-sky-500/15 px-1 py-px text-[9px] font-semibold tracking-wide text-sky-300">
                    NEW
                  </span>
                )}
                <span className="flex-1" />
                <span className="font-mono text-[10.5px] text-zinc-600">
                  {dateFmt.format(new Date(entry.date))}
                </span>
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {entry.items.map((item) => (
                  <li key={item} className="flex gap-2 text-[12px] leading-relaxed text-zinc-400">
                    <span className="text-zinc-600">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-zinc-800 px-4 py-3 text-right">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className={clsx(
              'rounded-md border border-sky-700 bg-sky-500/15 px-3 py-1 text-[12px] text-sky-300',
              'hover:bg-sky-500/25 focus:outline-none focus-visible:border-sky-500',
            )}
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
