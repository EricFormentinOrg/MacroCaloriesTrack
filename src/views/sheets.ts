// Fogli condivisi da Diario e Andamento: pesata e copia di voci.
import { addDays, dayTitle, isISODate, plainDate, todayISO } from '../dates.js';
import { fmt1, parseDecimal, toInput } from '../format.js';
import { MEALS, mealLabel } from '../model.js';
import type { Entry, Meal } from '../model.js';
import { refresh } from '../nav.js';
import * as repo from '../repo.js';
import { decimalInput, field, h, openSheet, segmented, toast } from '../ui.js';

const whenLabel = (date: string): string => {
  const t = dayTitle(date);
  return t === 'Oggi' || t === 'Ieri' || t === 'Domani' ? t.toLowerCase() : `il ${plainDate(date)}`;
};

/** Registra, corregge o elimina la pesata di un giorno. Restituisce true se qualcosa è cambiato. */
export async function openWeightSheet(date: string): Promise<boolean> {
  const current = await repo.getWeight(date);
  const res = await openSheet<{ kg: number } | 'delete'>('Peso', (close) => {
    const input = decimalInput({ class: 'qty-input', 'aria-label': 'Peso in kg', value: current ? toInput(current.kg) : '', autofocus: true });
    const error = h('p', { class: 'form-error', role: 'alert' });
    return h('form', {
      class: 'qty-form',
      novalidate: true,
      onSubmit: (e: Event) => {
        e.preventDefault();
        const kg = parseDecimal(input.value);
        if (!(kg >= 20 && kg <= 400)) {
          error.textContent = 'Inserisci un peso tra 20 e 400 kg, per esempio 82,4.';
          input.focus();
          return;
        }
        close({ kg: Math.round(kg * 10) / 10 });
      },
    },
      h('div', { class: 'sheet-head' },
        h('h2', { class: 'sheet-title' }, 'Peso'),
        h('p', { class: 'muted' }, `Pesata di ${whenLabel(date)}. Per un andamento affidabile pesati alla stessa ora, meglio al mattino.`),
      ),
      h('div', { class: 'qty-row' }, input, h('span', { class: 'unit-big' }, 'kg')),
      error,
      h('div', { class: 'sheet-actions' },
        current ? h('button', { type: 'button', class: 'btn btn-danger-text', onClick: () => close('delete') }, 'Elimina') : null,
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Salva'),
      ),
    );
  });
  if (!res) return false;
  if (res === 'delete') {
    await repo.deleteWeight(date);
    toast('Pesata eliminata', current ? { label: 'Annulla', run: async () => { await repo.setWeight(date, current.kg); refresh(); } } : undefined);
  } else {
    await repo.setWeight(date, res.kg);
    toast(`Peso salvato: ${fmt1(res.kg)} kg`);
  }
  return true;
}

/**
 * Copia un pasto o un giorno intero su un'altra data. Con `meal` si può scegliere il pasto di arrivo;
 * senza, ogni voce resta nel suo pasto. Il toast permette di annullare.
 */
export async function openCopySheet(o: { entries: ReadonlyArray<Entry>; from: string; meal?: Meal }): Promise<void> {
  if (!o.entries.length) return;
  const today = todayISO();
  const what = o.meal ? mealLabel(o.meal) : 'il giorno';
  const res = await openSheet<{ date: string; meal?: Meal }>(`Copia ${what}`, (close) => {
    // Da un giorno passato si copia di solito su oggi; da oggi, su domani.
    let target = o.from === today ? addDays(today, 1) : today;
    let meal: Meal | undefined = o.meal;
    const dateInput = h('input', { type: 'date', value: target, 'aria-label': 'Giorno di arrivo' });
    const quick = (label: string, d: string) =>
      h('button', {
        type: 'button',
        class: 'chip',
        onClick: () => {
          dateInput.value = d;
          target = d;
        },
      }, label);
    const error = h('p', { class: 'form-error', role: 'alert' });
    return h('form', {
      class: 'qty-form',
      novalidate: true,
      onSubmit: (e: Event) => {
        e.preventDefault();
        target = dateInput.value;
        if (!isISODate(target)) {
          error.textContent = 'Scegli il giorno su cui copiare.';
          return;
        }
        if (target === o.from && (!o.meal || meal === o.meal)) {
          error.textContent = o.meal ? 'Scegli un altro giorno o un altro pasto.' : 'Scegli un altro giorno.';
          return;
        }
        close({ date: target, meal });
      },
    },
      h('div', { class: 'sheet-head' },
        h('h2', { class: 'sheet-title' }, o.meal ? `Copia ${mealLabel(o.meal).toLowerCase()}` : 'Copia il giorno'),
        h('p', { class: 'muted' }, `${o.entries.length === 1 ? '1 voce' : `${o.entries.length} voci`} di ${whenLabel(o.from)}, con le stesse quantità.`),
      ),
      field('Su quale giorno', dateInput),
      h('div', { class: 'chips' }, quick('Oggi', today), quick('Domani', addDays(today, 1)), quick('Ieri', addDays(today, -1))),
      o.meal ? segmented('Pasto', MEALS.map((m) => ({ value: m.id, label: m.label })), o.meal, (v) => { meal = v; }) : null,
      error,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Copia'),
      ),
    );
  });
  if (!res) return;
  const copies = await repo.copyEntries(o.entries, res.date, res.meal);
  refresh();
  const where = res.meal ? `${mealLabel(res.meal).toLowerCase()} di ${whenLabel(res.date)}` : whenLabel(res.date);
  toast(`Copiato su ${where}`, {
    label: 'Annulla',
    run: async () => {
      await repo.deleteEntries(copies);
      refresh();
    },
  });
}
