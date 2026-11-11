import { foodRow, matchesFood } from '../components.js';
import type { FavToggle } from '../components.js';
import type { Food } from '../model.js';
import * as repo from '../repo.js';
import { tokens } from '../search.js';
import { h } from '../ui.js';

export async function foodsView(): Promise<HTMLElement> {
  let foods = await repo.listFoods();
  const results = h('div', { class: 'results' });
  const open = (f: Food) => { location.hash = `#/alimento/${f.id}`; };

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Cerca',
    'aria-label': 'Cerca alimento',
    autocomplete: 'off',
    onInput: () => render(),
  });

  function favOf(f: Food): FavToggle {
    return {
      on: !!f.favorite,
      toggle: async () => {
        const next = await repo.setFavorite(f.id, !f.favorite);
        if (!next) return undefined;
        foods = foods.map((x) => (x.id === next.id ? next : x));
        // Senza ricerca la sezione "Preferiti" cambia: ridisegna. Con una ricerca basta la stella.
        if (!tokens(search.value).length) render();
        return !!next.favorite;
      },
    };
  }

  const list = (fs: Food[]) => h('ul', { class: 'list' }, ...fs.map((f) => foodRow(f, open, favOf(f))));
  const group = (src: string, title: string, fs: Food[]) =>
    h('section', { class: 'res-group', 'data-src': src }, h('h2', { class: 'list-title' }, title), list(fs));

  function render(): void {
    const toks = tokens(search.value);
    if (!foods.length) {
      results.replaceChildren(h('p', { class: 'empty' }, 'Qui trovi gli alimenti che salvi: quelli creati da te e quelli presi dalla banca dati o da Open Food Facts al primo uso.'));
      return;
    }
    if (toks.length) {
      const hits = foods.filter((f) => matchesFood(f, toks));
      results.replaceChildren(hits.length ? list(hits) : h('p', { class: 'empty' }, `Nessun alimento trovato per “${search.value.trim()}”.`));
      return;
    }
    const favs = foods.filter((f) => f.favorite);
    results.replaceChildren(
      ...(favs.length ? [group('fav', 'Preferiti', favs)] : []),
      group('all', favs.length ? 'Tutti' : 'I tuoi alimenti', foods),
    );
  }
  render();

  return h('div', { class: 'view foods' },
    h('header', { class: 'view-head' },
      h('h1', null, 'Alimenti'),
      h('p', { class: 'muted' }, foods.length === 1 ? '1 alimento salvato' : `${foods.length} alimenti salvati`),
    ),
    h('div', { class: 'search-row' },
      foods.length ? search : null,
      h('a', { class: 'btn btn-secondary', href: '#/alimento/nuovo' }, 'Nuovo alimento'),
    ),
    results,
  );
}
