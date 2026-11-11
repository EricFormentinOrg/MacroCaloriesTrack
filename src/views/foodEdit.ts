import { parseDecimal, toInput } from '../format.js';
import { NUTRIENTS } from '../model.js';
import type { Meal, NutrientKey, Nutrients, Serving, Unit } from '../model.js';
import { checkFood } from '../nutrition.js';
import * as repo from '../repo.js';
import { confirmSheet, decimalInput, field, h, nextId, segmented, toast } from '../ui.js';

// Nome digitato nella ricerca, passato all'editor quando si sceglie "Crea un alimento".
let pendingName = '';
export function setPendingName(n: string): void {
  pendingName = n;
}

const KJ_PER_KCAL = 4.184;

export async function foodEditView(id: string, ctx?: { date: string; meal: Meal }): Promise<HTMLElement> {
  const isNew = id === 'nuovo';
  const food = isNew ? undefined : await repo.getFood(id);
  const backHref = ctx ? `#/aggiungi/${ctx.date}/${ctx.meal}` : '#/alimenti';
  if (!isNew && !food) {
    return h('div', { class: 'view' },
      h('p', { class: 'empty' }, 'Questo alimento non esiste più.'),
      h('a', { class: 'btn btn-secondary', href: backHref }, 'Torna indietro'),
    );
  }

  let unit: Unit = food?.unit ?? 'g';
  const unitTags: HTMLElement[] = [];
  const unitTag = () => {
    const el = h('span', { class: 'unit' }, unit);
    unitTags.push(el);
    return el;
  };

  const name = h('input', { type: 'text', value: food?.name ?? pendingName, maxlength: 200, autocomplete: 'off', enterkeyhint: 'next' });
  pendingName = '';
  const brand = h('input', { type: 'text', value: food?.brand ?? '', maxlength: 200, autocomplete: 'off', enterkeyhint: 'next' });

  const per100Title = h('h2', null, `Valori per 100 ${unit}`);
  const checks = h('div', { class: 'checks', 'aria-live': 'polite' });
  const errorBox = h('div', { class: 'errors', role: 'alert' });

  const inputs = {} as Record<NutrientKey, HTMLInputElement>;
  const kj = decimalInput({
    'aria-label': 'Energia in kJ',
    onInput: () => {
      const v = parseDecimal(kj.value);
      if (Number.isFinite(v) && v >= 0) inputs.kcal.value = toInput(Math.round(v / KJ_PER_KCAL));
      runChecks();
    },
  });

  const nutrientRows = NUTRIENTS.flatMap((n) => {
    const v = food?.per100[n.key];
    const inp = decimalInput({ id: nextId('n'), value: v !== undefined ? toInput(v) : '', onInput: runChecks });
    inputs[n.key] = inp;
    const row = h('div', { class: `nrow${n.sub ? ' sub' : ''}` },
      h('label', { for: inp.id }, n.label, n.required ? null : h('span', { class: 'opt' }, ' facoltativo')),
      inp,
      n.unit === 'kcal' ? h('span', { class: 'unit' }, 'kcal') : h('span', { class: 'unit' }, 'g'),
    );
    if (n.key !== 'kcal') return [row];
    kj.id = nextId('n');
    return [row, h('div', { class: 'nrow sub' }, h('label', { for: kj.id }, 'oppure in kJ'), kj, h('span', { class: 'unit' }, 'kJ'))];
  });

  function readNutrients(): { per100: Partial<Nutrients>; errors: string[] } {
    const per100: Partial<Nutrients> = {};
    const errors: string[] = [];
    for (const n of NUTRIENTS) {
      const raw = inputs[n.key].value.trim();
      if (!raw) {
        if (n.required) errors.push(`Manca il valore: ${n.label.toLowerCase()}.`);
        continue;
      }
      const v = parseDecimal(raw);
      if (!Number.isFinite(v) || v < 0 || v > 1000) {
        errors.push(`Valore non valido: ${n.label.toLowerCase()}.`);
        continue;
      }
      per100[n.key] = v;
    }
    return { per100, errors };
  }

  function runChecks(): void {
    const { per100, errors } = readNutrients();
    const complete = NUTRIENTS.every((n) => !n.required || per100[n.key] !== undefined);
    const warnings = complete && !errors.length ? checkFood(per100 as Nutrients, unit) : [];
    checks.replaceChildren(...warnings.map((w) => h('p', { class: 'warn' }, w)));
  }

  // ---- Porzioni
  interface ServingRow { label: HTMLInputElement; qty: HTMLInputElement; el: HTMLElement }
  const servingRows: ServingRow[] = [];
  const servingList = h('div', { class: 'servings' });
  function addServing(s?: Serving): void {
    const label = h('input', { type: 'text', placeholder: 'es. vasetto', value: s?.label ?? '', maxlength: 60, 'aria-label': 'Nome della porzione' });
    const qty = decimalInput({ value: s ? toInput(s.qty) : '', 'aria-label': 'Quantità della porzione' });
    const row: ServingRow = {
      label,
      qty,
      el: h('div', { class: 'serving' }, label, qty, unitTag(),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          'aria-label': 'Rimuovi porzione',
          onClick: () => {
            row.el.remove();
            servingRows.splice(servingRows.indexOf(row), 1);
          },
        }, '×'),
      ),
    };
    servingRows.push(row);
    servingList.append(row.el);
  }
  (food?.servings ?? []).forEach(addServing);

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    const errs: string[] = [];
    const nm = name.value.trim();
    if (!nm) errs.push('Inserisci il nome.');
    const { per100, errors } = readNutrients();
    errs.push(...errors);
    const servings: Serving[] = [];
    for (const r of servingRows) {
      const l = r.label.value.trim();
      const q = r.qty.value.trim();
      if (!l && !q) continue;
      const qv = parseDecimal(q);
      if (!l || !(qv > 0) || qv > 10000) {
        errs.push('Ogni porzione richiede un nome e una quantità maggiore di zero.');
        break;
      }
      servings.push({ label: l, qty: qv });
    }
    if (errs.length) {
      errorBox.replaceChildren(...errs.map((m) => h('p', null, m)));
      errorBox.scrollIntoView({ block: 'center' });
      return;
    }
    errorBox.replaceChildren();
    const saved = await repo.saveFood({
      id: food?.id,
      name: nm,
      brand: brand.value.trim() || undefined,
      barcode: food?.barcode,
      unit,
      per100: per100 as Nutrients,
      servings,
    });
    toast(isNew ? 'Alimento creato' : 'Alimento salvato');
    location.hash = ctx ? `#/aggiungi/${ctx.date}/${ctx.meal}/${saved.id}` : '#/alimenti';
  }

  async function remove(): Promise<void> {
    if (!food) return;
    const ok = await confirmSheet({
      title: 'Eliminare questo alimento?',
      message: 'Sparisce dalla ricerca. Le voci già registrate nel diario restano invariate.',
      confirm: 'Elimina',
      danger: true,
    });
    if (!ok) return;
    await repo.deleteFood(food.id);
    toast('Alimento eliminato');
    location.hash = '#/alimenti';
  }

  runChecks();

  return h('div', { class: 'view food-edit' },
    h('header', { class: 'view-head' },
      h('a', { class: 'back', href: backHref }, ctx ? '‹ Aggiungi' : '‹ Alimenti'),
      h('h1', null, isNew ? 'Nuovo alimento' : 'Modifica alimento'),
    ),
    h('form', { class: 'form', novalidate: true, onSubmit: save },
      field('Nome', name),
      field('Marca', brand, 'Facoltativa'),
      segmented('Si misura in', [{ value: 'g', label: 'Grammi' }, { value: 'ml', label: 'Millilitri' }], unit, (v) => {
        unit = v;
        per100Title.textContent = `Valori per 100 ${unit}`;
        for (const t of unitTags) t.textContent = unit;
        runChecks();
      }),
      h('section', { class: 'form-section' },
        per100Title,
        h('div', { class: 'ngrid' }, ...nutrientRows),
        checks,
      ),
      h('section', { class: 'form-section' },
        h('h2', null, 'Porzioni'),
        h('p', { class: 'muted' }, 'Facoltative. Per registrare “1 vasetto” invece dei grammi.'),
        servingList,
        h('button', { type: 'button', class: 'btn btn-quiet btn-inline', onClick: () => addServing() }, 'Aggiungi una porzione'),
      ),
      errorBox,
      h('div', { class: 'form-actions' },
        food ? h('button', { type: 'button', class: 'btn btn-danger-text', onClick: remove }, 'Elimina') : null,
        h('a', { class: 'btn btn-quiet', href: backHref }, 'Annulla'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Crea alimento' : 'Salva'),
      ),
    ),
  );
}
