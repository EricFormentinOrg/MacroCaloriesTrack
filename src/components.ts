import { fmtG, fmtInt } from './format.js';
import type { Food, Nutrients, Unit } from './model.js';
import { matchesAll, norm } from './search.js';
import { h } from './ui.js';

export { norm };

export function macroMini(n: Nutrients): HTMLElement {
  return h('span', { class: 'mini', 'aria-label': `Proteine ${fmtG(n.protein)} g, carboidrati ${fmtG(n.carbs)} g, grassi ${fmtG(n.fat)} g` },
    h('span', { class: 'mini-p' }, h('b', null, 'P'), ` ${fmtG(n.protein)}`),
    h('span', { class: 'mini-c' }, h('b', null, 'C'), ` ${fmtG(n.carbs)}`),
    h('span', { class: 'mini-f' }, h('b', null, 'G'), ` ${fmtG(n.fat)}`),
  );
}

export function matchesFood(f: Food, toks: ReadonlyArray<string>): boolean {
  return matchesAll(norm(`${f.name} ${f.brand ?? ''}`), toks);
}

export interface FavToggle {
  on: boolean;
  /** Restituisce il nuovo stato, o undefined se l'operazione non è riuscita. */
  toggle: () => Promise<boolean | undefined>;
}

export interface RowData {
  title: string;
  sub: string;
  per100?: Partial<Nutrients>;
  onPick: () => void;
  fav?: FavToggle;
}

/** Riga di elenco: tocco per scegliere, stella separata (mai annidata nel pulsante) per i preferiti. */
export function itemRow(d: RowData): HTMLElement {
  const n = d.per100;
  const full = n && n.protein !== undefined && n.carbs !== undefined && n.fat !== undefined;
  const row = h('button', { type: 'button', class: 'row', onClick: d.onPick },
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, d.title),
      h('span', { class: 'row-sub' }, d.sub),
    ),
    full ? h('span', { class: 'row-side' }, macroMini(n as Nutrients)) : null,
  );
  if (!d.fav) return h('li', null, row);
  const fav = d.fav;
  const star = h('button', { type: 'button', class: 'fav-toggle' });
  const paint = (on: boolean) => {
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', on ? `Togli ${d.title} dai preferiti` : `Aggiungi ${d.title} ai preferiti`);
  };
  paint(fav.on);
  star.addEventListener('click', async () => {
    star.disabled = true;
    const next = await fav.toggle();
    star.disabled = false;
    if (next !== undefined) paint(next);
  });
  return h('li', { class: 'has-fav' }, row, star);
}

export const per100Label = (kcal: number | undefined, unit: Unit): string =>
  kcal === undefined ? `energia non indicata` : `${fmtInt(kcal)} kcal per 100 ${unit}`;

export function foodRow(f: Food, onPick: (f: Food) => void, fav?: FavToggle): HTMLElement {
  return itemRow({
    title: f.name,
    sub: [f.brand, per100Label(f.per100.kcal, f.unit)].filter(Boolean).join(', '),
    per100: f.per100,
    onPick: () => onPick(f),
    fav,
  });
}
