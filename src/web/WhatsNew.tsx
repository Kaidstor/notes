import clsx from 'clsx';
import { Sparkles, X } from 'lucide-react';
import { useEffect } from 'react';

import { CHANGELOG, changelogKey } from './lib/changelog.ts';

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

/** `fresh` — ключи (`changelogKey`) записей, помеченных как новые для этого пользователя. */
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
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-[18px] bg-zinc-925 shadow-2xl ring-1 ring-zinc-800"
      >
        <div className="flex items-center gap-2.5 px-6 pt-5 pb-3">
          <Sparkles size={16} className="text-sky-400" />
          <h2 className="flex-1 text-[20px] font-medium tracking-[-0.015em] text-zinc-100">
            Что нового
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-full p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto px-6 pt-2 pb-5">
          {CHANGELOG.map((entry) => (
            <div key={changelogKey(entry)}>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-zinc-100">{entry.title}</span>
                {fresh.includes(changelogKey(entry)) && (
                  <span className="rounded-full bg-sky-500/15 px-2 py-px text-[11px] font-medium text-sky-300">
                    новое
                  </span>
                )}
                <span className="flex-1" />
                <span className="shrink-0 text-[12.5px] text-zinc-500">
                  {dateFmt.format(new Date(entry.date))}
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-1.5 pl-5">
                {entry.items.map((item) => (
                  <li
                    key={item}
                    className="list-disc text-[14px] leading-relaxed text-zinc-400 marker:text-sky-400"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="px-6 pt-1 pb-5 text-right">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className={clsx(
              'rounded-full bg-sky-500/15 px-4 py-1 text-[13px] text-sky-300',
              'hover:bg-sky-500/25 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500',
            )}
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
