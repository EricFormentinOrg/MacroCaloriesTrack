import { catalogFood, searchCatalog } from '../catalog.js';
import type { Catalog, CatalogItem } from '../catalog.js';
import { foodRow, itemRow, matchesFood, per100Label } from '../components.js';
import type { FavToggle } from '../components.js';
import { dayTitle, longDate } from '../dates.js';
import { fmtInt } from '../format.js';
import { mealLabel } from '../model.js';
import type { EntryServing, Food, Meal, Nutrients, Serving, Unit } from '../model.js';
import { isBarcode, offFood, reviewNotes } from '../off.js';
import type { OffProduct } from '../off.js';
import * as repo from '../repo.js';
import { rank, tokens } from '../search.js';
import { OffError, loadCatalog, productOff, searchOff } from '../sources.js';
import { h, toast } from '../ui.js';
import type { Child } from '../ui.js';
import { setPendingDraft, setPendingName } from './foodEdit.js';
import { openQtySheet } from './qtySheet.js';

type OffState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'done'; query: string; products: OffProduct[]; count: number; note?: string }
  | { status: 'error'; query: string; message: string };

export async function addView(date: string, meal: Meal, openFoodId?: string): Promise<HTMLElement> {
  const [initialFoods, recent] = await Promise.all([repo.listFoods(), repo.recentUsage(30)]);
  let foods = initialFoods;
  let byId = new Map(foods.map((f) => [f.id, f]));
  let query = '';
  let catalog: Catalog | undefined;
  let catalogError = '';
  let off: OffState = { status: 'idle' };

  const results = h('div', { class: 'results' });
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Cerca un alimento o un codice a barre',
    'aria-label': 'Cerca alimento',
    autocomplete: 'off',
    enterkeyhint: 'search',
    onInput: () => {
      query = search.value;
      render();
    },
    onKeydown: (e: KeyboardEvent) => {
      // Invio avvia la ricerca remota solo quando quella locale non trova niente.
      if (e.key === 'Enter' && query.trim() && !results.querySelector('.res-group[data-src="mine"], .res-group[data-src="ch"]')) void runOff();
    },
  });

  function setFoods(next: Food[]): void {
    foods = next.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    byId = new Map(foods.map((f) => [f.id, f]));
  }

  function replaceFood(f: Food): void {
    setFoods([...foods.filter((x) => x.id !== f.id), f]);
  }

  /** Copia personale già esistente per un alimento esterno. */
  const adopted = (source: 'ch' | 'off', id: string): Food | undefined => foods.find((f) => f.source === source && f.sourceId === id);

  function favOf(f: Food): FavToggle {
    return {
      on: !!f.favorite,
      toggle: async () => {
        const next = await repo.setFavorite(f.id, !f.favorite);
        if (!next) return undefined;
        replaceFood(next);
        return !!next.favorite;
      },
    };
  }

  const group = (src: string, title: string, ...content: Child[]) =>
    h('section', { class: 'res-group', 'data-src': src }, h('h2', { class: 'list-title' }, title), ...content);
  const list = (rows: HTMLElement[]) => h('ul', { class: 'list' }, ...rows);
  const mineList = (fs: Food[]) => list(fs.map((f) => foodRow(f, pickFood, favOf(f))));

  function catalogRow(x: CatalogItem): HTMLElement {
    return itemRow({
      title: x.name,
      sub: `${x.category}, ${per100Label(x.per100.kcal, 'g')}`,
      per100: x.per100,
      onPick: () => void pickCatalog(x),
      fav: {
        on: false,
        toggle: async () => {
          const f = await repo.adoptFood({ ...catalogFood(x), source: 'ch', sourceId: x.id, favorite: true });
          replaceFood(f);
          toast('Aggiunto ai preferiti e ai tuoi alimenti');
          render();
          return true;
        },
      },
    });
  }

  function offRow(p: OffProduct): HTMLElement {
    const notes = reviewNotes(p);
    const sub = [p.brand, notes.length ? 'da controllare' : per100Label(p.per100.kcal, p.unit)].filter(Boolean).join(', ');
    return itemRow({
      title: p.name,
      sub,
      per100: p.per100,
      onPick: () => void pickOff(p),
      fav: notes.length ? undefined : {
        on: false,
        toggle: async () => {
          const f = await repo.adoptFood({ ...offFood(p), per100: p.per100 as Nutrients, favorite: true });
          replaceFood(f);
          toast('Aggiunto ai preferiti e ai tuoi alimenti');
          render();
          return true;
        },
      },
    });
  }

  function offSection(toks: string[]): HTMLElement {
    const q = query.trim();
    const barcode = isBarcode(q);
    const cta = h('button', { type: 'button', class: 'btn btn-secondary off-cta', onClick: () => void runOff() },
      barcode ? 'Cerca il codice a barre su Open Food Facts' : `Cerca “${q}” su Open Food Facts`);
    const hint = h('p', { class: 'muted off-hint' }, 'Prodotti confezionati. La ricerca invia il testo a Open Food Facts.');
    if (off.status === 'idle' || off.query !== q) return group('off', 'Open Food Facts', cta, hint);
    if (off.status === 'loading') return group('off', 'Open Food Facts', h('p', { class: 'empty', role: 'status' }, 'Ricerca in corso…'));
    if (off.status === 'error') return group('off', 'Open Food Facts', h('p', { class: 'form-error', role: 'alert' }, off.message), cta);
    const mine = new Set(foods.filter((f) => f.source === 'off').map((f) => f.sourceId));
    const fresh = off.products.filter((p) => !mine.has(p.code));
    const ranked = barcode ? fresh : [...fresh].sort((a, b) => rank(b.name, toks) - rank(a.name, toks));
    const more = off.count > off.products.length ? ` Mostrati i primi ${fmtInt(off.products.length)} di ${fmtInt(off.count)}: aggiungi parole per restringere.` : '';
    return group('off', 'Open Food Facts',
      off.note ? h('p', { class: 'muted' }, off.note) : null,
      ranked.length
        ? list(ranked.map(offRow))
        : h('p', { class: 'empty' }, off.products.length ? 'I prodotti trovati sono già tra i tuoi alimenti.' : 'Nessun prodotto trovato.'),
      ...(more ? [h('p', { class: 'muted' }, more.trim())] : []),
    );
  }

  async function runOff(): Promise<void> {
    const q = query.trim();
    if (!q || off.status === 'loading') return;
    off = { status: 'loading', query: q };
    render();
    try {
      const r = isBarcode(q) ? await productOff(q) : await searchOff(q);
      off = { status: 'done', query: q, products: r.products, count: r.count, note: r.stale };
    } catch (e) {
      off = { status: 'error', query: q, message: e instanceof OffError ? e.message : 'Ricerca su Open Food Facts non riuscita.' };
      if (!(e instanceof OffError)) console.error(e);
    }
    if (query.trim() === q) render();
  }

  function render(): void {
    const toks = tokens(query);
    const blocks: Node[] = [];
    if (!toks.length) {
      const favs = foods.filter((f) => f.favorite);
      if (favs.length) blocks.push(group('fav', 'Preferiti', mineList(favs)));
      const rec = [...recent.keys()].map((id) => byId.get(id)).filter((f): f is Food => !!f).slice(0, 12);
      if (rec.length) blocks.push(group('recent', 'Usati di recente', mineList(rec)));
      if (foods.length) blocks.push(group('all', 'Tutti i tuoi alimenti', mineList(foods)));
      else blocks.push(h('p', { class: 'empty' }, 'Cerca un alimento: oltre ai tuoi trovi gli alimenti generici della banca dati svizzera e i prodotti confezionati di Open Food Facts. Puoi anche crearne uno copiando i valori dall’etichetta.'));
    } else {
      const mine = foods.filter((f) => matchesFood(f, toks)).sort((a, b) => rank(b.name, toks) - rank(a.name, toks));
      if (mine.length) blocks.push(group('mine', 'I tuoi alimenti', mineList(mine)));
      if (catalog) {
        const taken = new Set(foods.filter((f) => f.source === 'ch' && f.sourceId).map((f) => f.sourceId as string));
        const hits = searchCatalog(catalog.items, toks, 40, taken);
        if (hits.length) blocks.push(group('ch', 'Banca dati svizzera', list(hits.map(catalogRow))));
      } else if (catalogError) {
        blocks.push(h('p', { class: 'form-error' }, `Banca dati degli alimenti non disponibile: ${catalogError}`));
      }
      if (!blocks.length) blocks.push(h('p', { class: 'empty' }, `Niente tra i tuoi alimenti e nella banca dati per “${query.trim()}”.`));
      blocks.push(offSection(toks));
    }
    results.replaceChildren(...blocks);
  }

  interface Pickable { name: string; brand?: string; unit: Unit; per100: Nutrients; servings: Serving[] }

  /** Foglio quantità; restituisce l'esito solo se l'utente conferma. */
  function askQty(x: Pickable, lastId?: string) {
    const last = lastId ? recent.get(lastId) : undefined;
    return openQtySheet({
      title: x.name,
      brand: x.brand,
      unit: x.unit,
      per100: x.per100,
      servings: x.servings,
      meal,
      // Proponi l'ultima quantità usata: chi mangia lo stesso yogurt ogni mattina non la riscrive.
      initial: last ? { qty: last.qty, serving: last.serving } : { qty: 100 },
      confirmLabel: 'Aggiungi',
    });
  }

  async function addFood(f: Food, res: { meal: Meal; qty: number; serving?: EntryServing }): Promise<void> {
    const e = await repo.addEntry(date, res.meal, f, res.qty, res.serving);
    recent.set(f.id, e);
    toast(`Aggiunto a ${mealLabel(res.meal)}`);
  }

  async function pickFood(f: Food): Promise<void> {
    const res = await askQty(f, f.id);
    if (!res || res === 'delete') return;
    await addFood(f, res);
  }

  async function pickCatalog(x: CatalogItem): Promise<void> {
    const own = adopted('ch', x.id);
    if (own) return pickFood(own);
    const base = catalogFood(x);
    const res = await askQty(base);
    if (!res || res === 'delete') return;
    // Primo uso: copia tra gli alimenti personali, poi registra.
    const f = await repo.adoptFood({ ...base, source: 'ch', sourceId: x.id });
    replaceFood(f);
    await addFood(f, res);
    render();
  }

  async function pickOff(p: OffProduct): Promise<void> {
    const own = adopted('off', p.code);
    if (own) return pickFood(own);
    const base = offFood(p);
    const notes = reviewNotes(p);
    if (notes.length) {
      // Valori incompleti o incoerenti: prima si controllano nell'editor, poi si registra.
      setPendingDraft({ ...base, notes });
      location.hash = `#/alimento/nuovo/${date}/${meal}`;
      return;
    }
    const pick: Pickable = { ...base, per100: base.per100 as Nutrients };
    const res = await askQty(pick);
    if (!res || res === 'delete') return;
    const f = await repo.adoptFood({ ...pick, source: 'off', sourceId: p.code });
    replaceFood(f);
    await addFood(f, res);
    render();
  }

  render();
  loadCatalog().then(
    (c) => {
      catalog = c;
      if (tokens(query).length) render();
    },
    (e: unknown) => {
      catalogError = e instanceof Error ? e.message : String(e);
      if (tokens(query).length) render();
    },
  );

  if (openFoodId) {
    // Arrivo dalla creazione di un alimento: apri subito la quantità, poi pulisci l'URL.
    history.replaceState(null, '', `#/aggiungi/${date}/${meal}`);
    const f = byId.get(openFoodId);
    if (f) setTimeout(() => void pickFood(f), 0);
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
