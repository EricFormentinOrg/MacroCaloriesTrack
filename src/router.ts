import { isISODate, todayISO } from './dates.js';
import { isMeal } from './model.js';
import { setRefresher } from './nav.js';
import { h } from './ui.js';
import { addView } from './views/add.js';
import { diaryView } from './views/diary.js';
import { foodEditView } from './views/foodEdit.js';
import { foodsView } from './views/foods.js';
import { profileView } from './views/profile.js';
import { settingsView } from './views/settings.js';
import { trendsView } from './views/trends.js';

type Tab = 'diario' | 'andamento' | 'alimenti' | 'profilo' | 'impostazioni';

interface Route {
  tab: Tab;
  render: () => Promise<HTMLElement>;
}

// Routing su hash: funziona su GitHub Pages senza riscritture lato server.
function resolve(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [head, a, b, c] = parts;
  switch (head) {
    case 'aggiungi':
      if (isISODate(a) && isMeal(b)) return { tab: 'diario', render: () => addView(a, b, c) };
      break;
    case 'alimenti':
      return { tab: 'alimenti', render: foodsView };
    case 'alimento': {
      const ctx = isISODate(b) && isMeal(c) ? { date: b, meal: c } : undefined;
      return { tab: ctx ? 'diario' : 'alimenti', render: () => foodEditView(a ?? 'nuovo', ctx) };
    }
    case 'andamento':
      return { tab: 'andamento', render: trendsView };
    case 'profilo':
      return { tab: 'profilo', render: profileView };
    case 'impostazioni':
      return { tab: 'impostazioni', render: settingsView };
    case 'diario':
      if (isISODate(a)) return { tab: 'diario', render: () => diaryView(a) };
      break;
  }
  return { tab: 'diario', render: () => diaryView(todayISO()) };
}

let main: HTMLElement;
let token = 0;

async function render(keepScroll: boolean): Promise<void> {
  const t = ++token;
  const route = resolve(location.hash);
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
    if (a.dataset.tab === route.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const y = window.scrollY;
  try {
    const node = await route.render();
    if (t !== token) return; // nel frattempo è partita un'altra navigazione
    main.replaceChildren(node);
    window.scrollTo(0, keepScroll ? y : 0);
  } catch (e) {
    console.error(e);
    if (t !== token) return;
    main.replaceChildren(h('div', { class: 'view' }, h('p', { class: 'form-error' }, `Errore: ${e instanceof Error ? e.message : String(e)}`)));
  }
}

export function startRouter(root: HTMLElement): void {
  main = root;
  window.addEventListener('hashchange', () => void render(false));
  setRefresher(() => void render(true));
  void render(false);
}
