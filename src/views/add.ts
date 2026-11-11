import { foodRow, matchesFood, norm } from '../components.js';
import { dayTitle, longDate } from '../dates.js';
import { mealLabel } from '../model.js';
import type { Food, Meal } from '../model.js';
import * as repo from '../repo.js';
import { h, toast } from '../ui.js';
import { setPendingName } from './foodEdit.js';
import { openQtySheet } from './qtySheet.js';

export async function addView(date: string, meal: Meal, openFoodId?: string): Promise<HTMLElement> {
  const [foods, recent] = await Promise.all([repo.listFoods(), repo.recentUsage(30)]);
  const byId = new Map(foods.map((f) => [f.id, f]));
  let query = '';

  const results = h('div', { class: 'results' });
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Cerca tra i tuoi alimenti',
    'aria-label': 'Cerca alimento',
    autocomplete: 'off',
    enterkeyhint: 'search',
    onInput: () => {
      query = search.value;
      render();
    },
  });

  const list = (fs: Food[]) => h('ul', { class: 'list' }, ...fs.map((f) => foodRow(f, pick)));

  function render(): void {
    const tokens = norm(query).split(/\s+/).filter(Boolean);
    const blocks: Node[] = [];
    if (!foods.length) {
      blocks.push(h('p', { class: 'empty' }, 'Non hai ancora alimenti salvati. Creane uno copiando i valori dall’etichetta: bastano nome, energia e i tre macronutrienti per 100 g.'));
    } else if (tokens.length) {
      const hits = foods.filter((f) => matchesFood(f, tokens));
      blocks.push(hits.length ? list(hits) : h('p', { class: 'empty' }, `Nessun alimento trovato per “${query.trim()}”.`));
    } else {
      const rec = [...recent.keys()].map((id) => byId.get(id)).filter((f): f is Food => !!f).slice(0, 12);
      if (rec.length) blocks.push(h('h2', { class: 'list-title' }, 'Usati di recente'), list(rec));
      blocks.push(h('h2', { class: 'list-title' }, 'Tutti i tuoi alimenti'), list(foods));
    }
    results.replaceChildren(...blocks);
  }

  async function pick(f: Food): Promise<void> {
    const last = recent.get(f.id);
    const res = await openQtySheet({
      title: f.name,
      brand: f.brand,
      unit: f.unit,
      per100: f.per100,
      servings: f.servings,
      meal,
      // Proponi l'ultima quantità usata: chi mangia lo stesso yogurt ogni mattina non la riscrive.
      initial: last ? { qty: last.qty, serving: last.serving } : { qty: 100 },
      confirmLabel: 'Aggiungi',
    });
    if (!res || res === 'delete') return;
    const e = await repo.addEntry(date, res.meal, f, res.qty, res.serving);
    recent.set(f.id, e);
    toast(`Aggiunto a ${mealLabel(res.meal)}`);
  }

  render();

  if (openFoodId) {
    // Arrivo dalla creazione di un alimento: apri subito la quantità, poi pulisci l'URL.
    history.replaceState(null, '', `#/aggiungi/${date}/${meal}`);
    const f = byId.get(openFoodId);
    if (f) setTimeout(() => void pick(f), 0);
  }

  return h('div', { class: 'view add' },
    h('header', { class: 'view-head' },
      h('a', { class: 'back', href: `#/diario/${date}` }, '‹ Diario'),
      h('h1', null, `Aggiungi a ${mealLabel(meal)}`),
      h('p', { class: 'muted' }, dayTitle(date) === 'Oggi' ? 'Oggi' : longDate(date)),
    ),
    h('div', { class: 'search-row' },
      search,
      h('a', { class: 'btn btn-secondary', href: `#/alimento/nuovo/${date}/${meal}`, onClick: () => setPendingName(query.trim()) }, 'Crea un alimento'),
    ),
    results,
  );
}
