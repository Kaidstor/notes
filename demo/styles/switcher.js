(() => {
  const VARIANTS = [
    { id: 'current', key: '0', name: 'Сейчас', about: 'Как на проде: zinc-шкала и sky-акцент из sql-kai.' },
    { id: 'book', key: '1', name: 'Книга', about: 'Literata, узкая колонка, таблицы в книжном стиле, врезки с заголовком в начале строки.' },
    { id: 'draft', key: '2', name: 'Чертёж', about: 'Калька с сеткой, рамка и штамп по ГОСТ, нумерация разделов, врезки со штриховкой.' },
    { id: 'poster', key: '3', name: 'Плакат', about: 'Onest, огромный заголовок, ультрамарин, врезки сплошной заливкой.' },
    { id: 'dusk', key: '4', name: 'Сумерки', about: 'Тёмная по умолчанию, янтарный акцент, оглавление на левой панели с полосой прочитанного.' },
    { id: 'md', key: '5', name: 'Markdown', about: 'JetBrains Mono, разметка markdown видна: #, **, ```, [ссылки].' },
  ];
  const THEMES = [
    { id: 'auto', name: 'авто' },
    { id: 'light', name: 'светлая' },
    { id: 'dark', name: 'тёмная' },
  ];

  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  let theme = new URLSearchParams(location.search).get('t') || localStorage.getItem('demo-theme') || 'auto';

  const readVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  window.__palette = () => {
    const v = (name, fallback) => readVar(name) || readVar(fallback);
    return {
      background: v('--mm-bg', '--panel'),
      mainBkg: v('--mm-node', '--panel-2'),
      primaryColor: v('--mm-node', '--panel-2'),
      nodeBorder: v('--mm-border', '--border-strong'),
      primaryBorderColor: v('--mm-border', '--border-strong'),
      primaryTextColor: v('--mm-text', '--fg'),
      textColor: v('--mm-text', '--fg'),
      secondaryColor: v('--mm-bg', '--panel'),
      tertiaryColor: v('--mm-bg', '--panel'),
      lineColor: v('--mm-line', '--faint'),
      edgeLabelBackground: v('--mm-bg', '--panel'),
      clusterBkg: v('--mm-bg', '--panel'),
      clusterBorder: v('--border', '--border'),
      titleColor: v('--fg-strong', '--fg-strong'),
    };
  };

  const bar = document.createElement('div');
  bar.id = 'demo-switch';
  bar.innerHTML = `
    <p class="ds-about" data-role="about"></p>
    <div class="ds-row">
      <div class="ds-group" role="radiogroup" aria-label="Вариант оформления">
        ${VARIANTS.map(
          (v) =>
            `<button type="button" role="radio" data-v="${v.id}" title="Клавиша ${v.key}"><span class="ds-key">${v.key}</span>${v.name}</button>`,
        ).join('')}
      </div>
      <div class="ds-group" role="radiogroup" aria-label="Тема">
        ${THEMES.map((t) => `<button type="button" role="radio" data-t="${t.id}" title="Клавиша T">${t.name}</button>`).join('')}
      </div>
      <button type="button" class="ds-hide" data-act="hide" title="Спрятать панель (H)">✕</button>
    </div>`;
  document.body.append(bar);

  const tab = document.createElement('button');
  tab.id = 'demo-switch-tab';
  tab.type = 'button';
  tab.hidden = true;
  tab.textContent = 'варианты';
  document.body.append(tab);

  const about = bar.querySelector('[data-role="about"]');

  const redraw = async () => {
    await document.fonts.ready;
    dispatchEvent(new Event('variantchange'));
  };

  const sync = () => {
    for (const b of bar.querySelectorAll('[data-v]')) b.setAttribute('aria-checked', String(b.dataset.v === root.dataset.v));
    for (const b of bar.querySelectorAll('[data-t]')) b.setAttribute('aria-checked', String(b.dataset.t === theme));
    const current = VARIANTS.find((v) => v.id === root.dataset.v);
    about.textContent = current ? current.about : '';
  };

  const setVariant = (id) => {
    if (root.dataset.v === id) return;
    root.dataset.v = id;
    localStorage.setItem('demo-v', id);
    const url = new URL(location.href);
    url.searchParams.set('v', id);
    history.replaceState(null, '', url);
    sync();
    redraw();
  };

  const applyTheme = () => {
    const dark = theme === 'dark' || (theme === 'auto' && media.matches);
    const next = dark ? 'dark' : 'light';
    const changed = root.dataset.theme !== next;
    root.dataset.theme = next;
    sync();
    if (changed) redraw();
  };

  const setTheme = (id) => {
    theme = id;
    localStorage.setItem('demo-theme', id);
    applyTheme();
  };

  const toggleBar = (show) => {
    bar.hidden = !show;
    tab.hidden = show;
  };

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v) setVariant(b.dataset.v);
    if (b.dataset.t) setTheme(b.dataset.t);
    if (b.dataset.act === 'hide') toggleBar(false);
  });
  tab.addEventListener('click', () => toggleBar(true));
  media.addEventListener('change', applyTheme);

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (document.querySelector('.mermaid-modal')) return;
    const v = VARIANTS.find((x) => x.key === e.key);
    if (v) setVariant(v.id);
    if (e.key === 't' || e.key === 'е') {
      const i = THEMES.findIndex((t) => t.id === theme);
      setTheme(THEMES[(i + 1) % THEMES.length].id);
    }
    if (e.key === 'h' || e.key === 'р') toggleBar(bar.hidden);
  });

  sync();
})();
