import { foodRow, matchesFood, norm } from '../components.js';
import * as repo from '../repo.js';
import { h } from '../ui.js';

export async function foodsView(): Promise<HTMLElement> {
  const foods = await repo.listFoods();
  const results = h('div', { class: 'results' });
  const open = (id: string) => { location.hash = `#/alimento/${id}`; };

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Cerca',
    'aria-label': 'Cerca alimento',
    autocomplete: 'off',
    onInput: () => render(),
  });

  function render(): void {
    const tokens = norm(search.value).split(/\s+/).filter(Boolean);
    const hits = tokens.length ? foods.filter((f) => matchesFood(f, tokens)) : foods;
    if (!foods.length) {
      results.replaceChildren(h('p', { class: 'empty' }, 'Qui trovi gli alimenti che salvi. Il primo lo crei dai valori di un’etichetta.'));
    } else if (!hits.length) {
      results.replaceChildren(h('p', { class: 'empty' }, `Nessun alimento trovato per “${search.value.trim()}”.`));
    } else {
      results.replaceChildren(h('ul', { class: 'list' }, ...hits.map((f) => foodRow(f, (x) => open(x.id)))));
    }
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
