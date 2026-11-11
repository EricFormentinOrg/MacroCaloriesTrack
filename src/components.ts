import { fmtG, fmtInt } from './format.js';
import type { Food, Nutrients } from './model.js';
import { h } from './ui.js';

export function macroMini(n: Nutrients): HTMLElement {
  return h('span', { class: 'mini', 'aria-label': `Proteine ${fmtG(n.protein)} g, carboidrati ${fmtG(n.carbs)} g, grassi ${fmtG(n.fat)} g` },
    h('span', { class: 'mini-p' }, h('b', null, 'P'), ` ${fmtG(n.protein)}`),
    h('span', { class: 'mini-c' }, h('b', null, 'C'), ` ${fmtG(n.carbs)}`),
    h('span', { class: 'mini-f' }, h('b', null, 'G'), ` ${fmtG(n.fat)}`),
  );
}

/** Minuscole e senza accenti: "caffè" trova "caffe" e viceversa. */
export function norm(s: string): string {
  return s.toLocaleLowerCase('it').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function matchesFood(f: Food, tokens: string[]): boolean {
  const hay = norm(`${f.name} ${f.brand ?? ''}`);
  return tokens.every((t) => hay.includes(t));
}

export function foodRow(f: Food, onPick: (f: Food) => void): HTMLElement {
  return h('li', null,
    h('button', { type: 'button', class: 'row', onClick: () => onPick(f) },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, f.name),
        h('span', { class: 'row-sub' }, [f.brand, `${fmtInt(f.per100.kcal)} kcal per 100 ${f.unit}`].filter(Boolean).join(', ')),
      ),
      h('span', { class: 'row-side' }, macroMini(f.per100)),
    ),
  );
}
