import { macroMini } from '../components.js';
import { fmtG, fmtInt, parseDecimal, round, toInput } from '../format.js';
import { MEALS } from '../model.js';
import type { EntryServing, Meal, Nutrients, Serving, Unit } from '../model.js';
import { scale } from '../nutrition.js';
import { decimalInput, h, openSheet, segmented } from '../ui.js';

export interface QtyResult {
  meal: Meal;
  qty: number;
  serving?: EntryServing;
}

export interface QtyOptions {
  title: string;
  brand?: string;
  unit: Unit;
  per100: Nutrients;
  servings: ReadonlyArray<Serving>;
  meal: Meal;
  initial: { qty: number; serving?: EntryServing };
  confirmLabel: string;
  allowDelete?: boolean;
}

export const MAX_QTY = 10000;

export function openQtySheet(o: QtyOptions): Promise<QtyResult | 'delete' | undefined> {
  return openSheet<QtyResult | 'delete'>(o.title, (close) => {
    let meal = o.meal;
    const servings: Serving[] = o.servings.filter((s) => s.qty > 0).map((s) => ({ ...s }));
    let sel = -1; // -1 = unità base (g o ml)
    const init = o.initial.serving;
    if (init) {
      sel = servings.findIndex((s) => s.label === init.label && s.qty === init.qty);
      if (sel < 0) {
        servings.push({ label: init.label, qty: init.qty });
        sel = servings.length - 1;
      }
    }

    const preview = h('div', { class: 'qty-preview', 'aria-live': 'polite' });
    const error = h('p', { class: 'form-error', role: 'alert' });

    const amount = decimalInput({
      class: 'qty-input',
      'aria-label': 'Quantità',
      autofocus: true,
      value: toInput(sel >= 0 && init ? init.count : o.initial.qty),
      onFocus: () => amount.select(),
      onInput: update,
    });

    const unitSel = h('select', {
      class: 'qty-unit',
      'aria-label': 'Unità',
      value: String(sel),
      onChange: () => {
        const g = grams();
        sel = Number(unitSel.value);
        if (Number.isFinite(g)) amount.value = toInput(sel >= 0 ? g / servings[sel].qty : g);
        update();
      },
    },
      h('option', { value: '-1' }, o.unit),
      ...servings.map((s, i) => h('option', { value: String(i) }, `${s.label} (${fmtG(s.qty)} ${o.unit})`)),
    );

    function grams(): number {
      const v = parseDecimal(amount.value);
      if (!Number.isFinite(v)) return NaN;
      return sel >= 0 ? v * servings[sel].qty : v;
    }

    function update(): void {
      error.textContent = '';
      const g = grams();
      if (!(g > 0)) {
        preview.replaceChildren(h('span', { class: 'muted' }, 'Inserisci una quantità.'));
        return;
      }
      const n = scale(o.per100, g);
      preview.replaceChildren(
        h('span', { class: 'qty-kcal' }, `${fmtInt(n.kcal)} kcal`),
        macroMini(n),
        ...(sel >= 0 ? [h('span', { class: 'muted' }, `${fmtG(g)} ${o.unit}`)] : []),
      );
    }

    function submit(e: Event): void {
      e.preventDefault();
      const g = grams();
      if (!(g > 0) || g > MAX_QTY) {
        error.textContent = g > MAX_QTY ? `La quantità massima è ${fmtInt(MAX_QTY)} ${o.unit}.` : 'Inserisci una quantità maggiore di zero.';
        amount.focus();
        return;
      }
      const s = sel >= 0 ? servings[sel] : undefined;
      close({ meal, qty: round(g, 1), serving: s ? { label: s.label, qty: s.qty, count: round(parseDecimal(amount.value), 2) } : undefined });
    }

    update();

    return h('form', { class: 'qty-form', novalidate: true, onSubmit: submit },
      h('div', { class: 'sheet-head' },
        h('h2', { class: 'sheet-title' }, o.title),
        o.brand ? h('p', { class: 'muted' }, o.brand) : null,
      ),
      h('div', { class: 'qty-row' }, amount, unitSel),
      preview,
      error,
      segmented('Pasto', MEALS.map((m) => ({ value: m.id, label: m.label })), meal, (v) => { meal = v; }, true),
      h('div', { class: 'sheet-actions' },
        o.allowDelete ? h('button', { type: 'button', class: 'btn btn-danger-text', onClick: () => close('delete') }, 'Elimina') : null,
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, o.confirmLabel),
      ),
    );
  });
}
