import { macroMini } from '../components.js';
import { addDays, dayTitle, isISODate, longDate, todayISO } from '../dates.js';
import { fmtG, fmtInt, fmtQty } from '../format.js';
import { MEALS } from '../model.js';
import type { Entry, Meal, Nutrients, Targets } from '../model.js';
import { refresh } from '../nav.js';
import { computePlan, entryNutrients, sum } from '../nutrition.js';
import type { Plan } from '../nutrition.js';
import * as repo from '../repo.js';
import { h, toast } from '../ui.js';
import { openQtySheet } from './qtySheet.js';

interface MealBlock {
  id: Meal;
  label: string;
  list: Entry[];
  kcal: number;
}

export async function diaryView(date: string): Promise<HTMLElement> {
  const [entries, profile, weight] = await Promise.all([repo.entriesFor(date), repo.getProfile(), repo.weightOn(date)]);
  // Obiettivo calcolato col peso valido in quel giorno: i giorni passati non cambiano quando dimagrisci.
  const plan = profile && weight ? computePlan(profile, weight.kg, date) : null;
  const totals = sum(entries.map(entryNutrients));
  const meals: MealBlock[] = MEALS.map((m) => {
    const list = entries.filter((e) => e.meal === m.id).sort((a, b) => a.createdAt - b.createdAt);
    return { ...m, list, kcal: sum(list.map(entryNutrients)).kcal };
  });

  return h('div', { class: 'view diary' },
    dateNav(date),
    hero(totals, plan, meals),
    ...meals.map((m) => mealSection(date, m)),
    entries.length ? extra(totals) : null,
  );
}

function dateNav(date: string): HTMLElement {
  const title = dayTitle(date);
  const picker = h('input', {
    type: 'date',
    class: 'date-picker',
    value: date,
    'aria-label': 'Scegli il giorno',
    onClick: () => {
      try {
        picker.showPicker();
      } catch {
        /* showPicker non disponibile: resta il comportamento nativo */
      }
    },
    onChange: () => {
      if (isISODate(picker.value)) location.hash = `#/diario/${picker.value}`;
    },
  });
  return h('header', { class: 'date-nav' },
    h('a', { class: 'icon-btn', href: `#/diario/${addDays(date, -1)}`, 'aria-label': 'Giorno precedente' }, '‹'),
    h('div', { class: 'date-title' },
      h('h1', null, title),
      title !== longDate(date) ? h('p', { class: 'date-sub' }, longDate(date)) : null,
      picker,
    ),
    h('a', { class: 'icon-btn', href: `#/diario/${addDays(date, 1)}`, 'aria-label': 'Giorno successivo' }, '›'),
    date !== todayISO() ? h('a', { class: 'jump-today', href: '#/' }, 'Torna a oggi') : null,
  );
}

function hero(totals: Nutrients, plan: Plan | null, meals: MealBlock[]): HTMLElement {
  const consumed = totals.kcal;
  if (!plan) {
    return h('section', { class: 'hero' },
      h('p', { class: 'hero-line' }, h('span', { class: 'num' }, fmtInt(consumed)), ' kcal'),
      h('p', { class: 'hero-sub' }, h('a', { href: '#/profilo' }, 'Imposta il profilo'), ' per avere un obiettivo giornaliero.'),
      macroRows(totals),
    );
  }
  const t = plan.targets;
  const rem = t.kcal - consumed;
  return h('section', { class: 'hero' },
    h('p', { class: 'hero-line' }, rem >= 0 ? 'Restano ' : 'Oltre di ', h('span', { class: 'num' }, fmtInt(Math.abs(rem))), ' kcal'),
    h('p', { class: 'hero-sub' }, `${fmtInt(consumed)} consumate su ${fmtInt(t.kcal)}`),
    dayBar(meals, t.kcal, consumed),
    macroRows(totals, t),
  );
}

/** Una barra = il budget del giorno, divisa per pasto. L'eccesso è tratteggiato. */
function dayBar(meals: MealBlock[], target: number, consumed: number): HTMLElement {
  const scaleMax = Math.max(target, consumed, 1);
  const over = consumed > target;
  return h('div', {
    class: `daybar${over ? ' over' : ''}`,
    role: 'img',
    'aria-label': meals.map((m) => `${m.label} ${fmtInt(m.kcal)} kcal`).join(', '),
  },
    ...meals.filter((m) => m.kcal > 0).map((m) => h('span', { class: `day-seg tone-${m.id}`, style: { width: `${(m.kcal / scaleMax) * 100}%` } })),
    over ? h('span', { class: 'over-zone', style: { left: `${(target / scaleMax) * 100}%` } }) : null,
  );
}

const MACROS = [
  { key: 'protein', label: 'Proteine' },
  { key: 'carbs', label: 'Carboidrati' },
  { key: 'fat', label: 'Grassi' },
] as const;

function macroRows(totals: Nutrients, t?: Targets): HTMLElement {
  return h('div', { class: 'macros' },
    ...MACROS.map((m) => {
      const v = totals[m.key];
      const goal = t?.[m.key];
      const over = goal !== undefined && goal > 0 && v > goal * 1.05;
      return h('div', { class: `macro macro-${m.key}${over ? ' over' : ''}` },
        h('span', { class: 'macro-label' }, m.label),
        h('span', { class: 'macro-val' }, goal !== undefined ? `${fmtG(v)} / ${fmtInt(goal)} g` : `${fmtG(v)} g`),
        goal !== undefined
          ? h('span', { class: 'macro-track' }, h('span', { class: 'macro-fill', style: { width: `${goal > 0 ? Math.min(100, (v / goal) * 100) : 0}%` } }))
          : null,
      );
    }),
  );
}

function mealSection(date: string, m: MealBlock): HTMLElement {
  return h('section', { class: 'meal' },
    h('div', { class: 'meal-head' },
      h('span', { class: `swatch tone-${m.id}`, 'aria-hidden': 'true' }),
      h('h2', null, m.label),
      m.kcal > 0 ? h('span', { class: 'meal-kcal' }, `${fmtInt(m.kcal)} kcal`) : null,
      h('a', { class: 'link-add', href: `#/aggiungi/${date}/${m.id}`, 'aria-label': `Aggiungi a ${m.label}` }, 'Aggiungi'),
    ),
    m.list.length ? h('ul', { class: 'list' }, ...m.list.map(entryRow)) : null,
  );
}

function entryRow(e: Entry): HTMLElement {
  const n = entryNutrients(e);
  return h('li', null,
    h('button', { type: 'button', class: 'row', onClick: () => editEntry(e) },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, e.name),
        h('span', { class: 'row-sub' }, [e.brand, fmtQty(e)].filter(Boolean).join(', ')),
      ),
      h('span', { class: 'row-side' },
        h('span', { class: 'row-kcal' }, `${fmtInt(n.kcal)} kcal`),
        macroMini(n),
      ),
    ),
  );
}

async function editEntry(e: Entry): Promise<void> {
  const food = await repo.getFood(e.foodId);
  const res = await openQtySheet({
    title: e.name,
    brand: e.brand,
    unit: e.unit,
    per100: e.per100,
    servings: food?.servings ?? [],
    meal: e.meal,
    initial: { qty: e.qty, serving: e.serving },
    confirmLabel: 'Salva',
    allowDelete: true,
  });
  if (!res) return;
  if (res === 'delete') {
    await repo.deleteEntry(e);
    refresh();
    toast('Voce eliminata', { label: 'Annulla', run: async () => { await repo.restoreEntry(e); refresh(); } });
    return;
  }
  await repo.updateEntry(e, res);
  refresh();
  toast('Voce salvata');
}

function extra(totals: Nutrients): HTMLElement {
  const rows: Array<[string, number | undefined]> = [
    ['Fibre', totals.fiber],
    ['Zuccheri', totals.sugars],
    ['Grassi saturi', totals.satFat],
    ['Sale', totals.salt],
  ];
  return h('details', { class: 'extra' },
    h('summary', null, 'Altri valori del giorno'),
    h('dl', null, ...rows.flatMap(([l, v]) => [h('dt', null, l), h('dd', null, v === undefined ? 'non indicato' : `${fmtG(v)} g`)])),
  );
}
