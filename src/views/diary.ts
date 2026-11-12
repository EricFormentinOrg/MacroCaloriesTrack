import { macroMini } from '../components.js';
import { addDays, dayTitle, isISODate, longDate, plainDate, todayISO } from '../dates.js';
import { fmt1, fmtG, fmtInt, fmtQty } from '../format.js';
import { MEALS } from '../model.js';
import type { Entry, Meal, Nutrients, Profile, Targets, Weight } from '../model.js';
import { refresh } from '../nav.js';
import { computePlan, entryNutrients, sum } from '../nutrition.js';
import type { Plan } from '../nutrition.js';
import * as repo from '../repo.js';
import { dailyTotals, dayState, sortedWeights, weekDates, weightAt } from '../stats.js';
import { ICONS, h, icon, toast } from '../ui.js';
import { openQtySheet } from './qtySheet.js';
import { openCopySheet, openWeightSheet } from './sheets.js';

interface MealBlock {
  id: Meal;
  label: string;
  list: Entry[];
  kcal: number;
}

export async function diaryView(date: string): Promise<HTMLElement> {
  const week = weekDates(date);
  const [entries, profile, weights, weekEntries] = await Promise.all([
    repo.entriesFor(date),
    repo.getProfile(),
    repo.listWeights(),
    repo.entriesBetween(week[0], week[6]),
  ]);
  const sorted = sortedWeights(weights);
  const weight = weightAt(sorted, date);
  // Obiettivo calcolato col peso valido in quel giorno: i giorni passati non cambiano quando dimagrisci.
  const plan = profile && weight ? computePlan(profile, weight.kg, date) : null;
  const totals = sum(entries.map(entryNutrients));
  const meals: MealBlock[] = MEALS.map((m) => {
    const list = entries.filter((e) => e.meal === m.id).sort((a, b) => a.createdAt - b.createdAt);
    return { ...m, list, kcal: sum(list.map(entryNutrients)).kcal };
  });

  return h('div', { class: 'view diary' },
    dateNav(date),
    weekStrip(date, week, dailyTotals(weekEntries), profile, sorted),
    hero(totals, plan, meals, !!profile),
    weightRow(date, sorted),
    entries.length ? null : h('p', { class: 'day-hint' }, date > todayISO()
      ? 'Puoi già pianificare questo giorno: tocca Aggiungi su un pasto, oppure copia un giorno passato.'
      : 'Tocca Aggiungi su un pasto per registrare cosa hai mangiato.'),
    ...meals.map((m) => mealSection(date, m)),
    entries.length ? extra(totals) : null,
    entries.length
      ? h('button', { type: 'button', class: 'btn btn-quiet btn-inline copy-day', onClick: () => void openCopySheet({ entries, from: date }) }, icon(ICONS.copy), 'Copia il giorno')
      : null,
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

const WEEKDAY = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const STATE_LABEL = { empty: 'niente registrato', under: 'sotto l’obiettivo', ok: 'in linea con l’obiettivo', over: 'oltre l’obiettivo' } as const;

/** La settimana del giorno aperto: un tocco per spostarsi, una barretta per lo stato rispetto all'obiettivo. */
function weekStrip(date: string, week: string[], totals: Map<string, Nutrients>, profile: Profile | undefined, sorted: Weight[]): HTMLElement {
  const today = todayISO();
  return h('nav', { class: 'week-strip', 'aria-label': 'Giorni della settimana' },
    ...week.map((d, i) => {
      const kcal = totals.get(d)?.kcal;
      const w = weightAt(sorted, d);
      const target = profile && w ? computePlan(profile, w.kg, d).targets.kcal : undefined;
      const state = dayState(kcal, target);
      const fill = kcal && target ? Math.min(1, kcal / target) : kcal ? 1 : 0;
      return h('a', {
        class: `wk-day wk-${state}${d === date ? ' wk-sel' : ''}${d === today ? ' wk-today' : ''}`,
        href: `#/diario/${d}`,
        'aria-current': d === date ? 'date' : undefined,
        'aria-label': `${longDate(d)}: ${kcal ? `${fmtInt(kcal)} kcal, ` : ''}${STATE_LABEL[state]}`,
      },
        h('span', { class: 'wk-letter', 'aria-hidden': 'true' }, WEEKDAY[i]),
        h('span', { class: 'wk-num', 'aria-hidden': 'true' }, String(Number(d.slice(8)))),
        h('span', { class: 'wk-bar', 'aria-hidden': 'true' }, h('span', { class: 'wk-fill', style: { width: `${Math.round(fill * 100)}%` } })),
      );
    }),
  );
}

function hero(totals: Nutrients, plan: Plan | null, meals: MealBlock[], hasProfile: boolean): HTMLElement {
  const consumed = totals.kcal;
  if (!plan) {
    return h('section', { class: 'hero' },
      h('p', { class: 'hero-line' }, h('span', { class: 'num' }, fmtInt(consumed)), ' kcal'),
      hasProfile
        ? h('p', { class: 'hero-sub' }, 'Registra il peso qui sotto per calcolare l’obiettivo di questo giorno.')
        : h('p', { class: 'hero-sub' }, h('a', { href: '#/profilo' }, 'Imposta il profilo'), ' per avere un obiettivo giornaliero.'),
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

/** Peso del giorno: registrato, oppure l'ultimo noto con un invito a pesarsi. */
function weightRow(date: string, sorted: Weight[]): HTMLElement {
  const own = sorted.find((w) => w.date === date);
  const last = weightAt(sorted, date);
  const open = async () => {
    if (await openWeightSheet(date)) refresh();
  };
  return h('div', { class: 'weight-row' },
    icon(ICONS.scale),
    h('span', { class: 'weight-main' },
      h('span', { class: 'weight-label' }, 'Peso'),
      own
        ? h('span', { class: 'weight-val' }, `${fmt1(own.kg)} kg`)
        : h('span', { class: 'weight-none' }, last ? `ultimo ${fmt1(last.kg)} kg, ${dayTitle(last.date) === 'Ieri' ? 'ieri' : `il ${plainDate(last.date)}`}` : 'non registrato'),
    ),
    h('button', { type: 'button', class: 'btn btn-small', onClick: () => void open() }, own ? 'Modifica' : 'Registra'),
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
      m.list.length
        ? h('button', {
          type: 'button',
          class: 'icon-btn meal-copy',
          'aria-label': `Copia ${m.label.toLowerCase()}`,
          title: `Copia ${m.label.toLowerCase()}`,
          onClick: () => void openCopySheet({ entries: m.list, from: date, meal: m.id }),
        }, icon(ICONS.copy))
        : null,
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
