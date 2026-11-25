// Foto del piatto: Gemini stima alimenti e quantità, l'utente controlla e conferma. Niente salvataggio automatico.
import { catalogFood } from '../catalog.js';
import type { Catalog } from '../catalog.js';
import { macroMini } from '../components.js';
import { GeminiError, matchCatalog, totalKcal } from '../dishAi.js';
import type { Dish, DishItem, Match } from '../dishAi.js';
import { fmtInt, parseDecimal, toInput } from '../format.js';
import { analyzeDish, getGemini, prepareImage } from '../gemini.js';
import type { PreparedImage } from '../gemini.js';
import { mealLabel } from '../model.js';
import type { Entry, Meal, Nutrients } from '../model.js';
import { scale, sum } from '../nutrition.js';
import * as repo from '../repo.js';
import { loadCatalog } from '../sources.js';
import { decimalInput, h, openSheet, toast } from '../ui.js';

interface Row {
  item: DishItem;
  match?: Match;
  useDb: boolean;
  qty: number;
  removed: boolean;
}

const perOf = (r: Row): Nutrients => (r.useDb && r.match ? r.match.item.per100 : r.item.per100);

/** Avvia il flusso dal file scelto o scattato. Restituisce le voci aggiunte (per l'annullamento). */
export async function openDishPhoto(file: File, date: string, meal: Meal): Promise<Entry[] | undefined> {
  if (!(await getGemini())) {
    await openSheet('Foto del piatto', (close) => h('div', null,
      h('h2', { class: 'sheet-title' }, 'Foto del piatto'),
      h('p', null, 'Per stimare un piatto da foto serve una tua chiave Gemini. Inseriscila in Impostazioni, sezione “Foto del piatto”.'),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        h('a', { class: 'btn btn-primary', href: '#/impostazioni', onClick: () => close() }, 'Vai alle impostazioni'),
      ),
    ));
    return undefined;
  }
  let img: PreparedImage;
  try {
    img = await prepareImage(file);
  } catch (e) {
    toast(e instanceof GeminiError ? e.message : 'Non riesco ad aprire questa foto.');
    return undefined;
  }
  const preview = URL.createObjectURL(img.blob);
  const catalogP: Promise<Catalog | undefined> = loadCatalog().catch(() => undefined);
  try {
    return await openSheet<Entry[]>('Foto del piatto', (close) => build(close, img, preview, catalogP, date, meal));
  } finally {
    URL.revokeObjectURL(preview);
  }
}

function build(close: (v?: Entry[]) => void, img: PreparedImage, preview: string, catalogP: Promise<Catalog | undefined>, date: string, meal: Meal): HTMLElement {
  const body = h('div', { class: 'dish-body', 'aria-live': 'polite' });
  const hint = h('textarea', {
    class: 'label-text dish-hint',
    rows: 2,
    maxlength: 300,
    placeholder: 'Facoltativo: es. pasta al pomodoro con parmigiano, porzione abbondante',
    'aria-label': 'Descrizione del piatto',
  });

  function ready(message?: string): void {
    body.replaceChildren(
      hint,
      ...(message ? [h('p', { class: 'form-error', role: 'alert' }, message)] : []),
      h('p', { class: 'muted' }, 'La foto viene inviata a Google Gemini con la tua chiave. Prima la riduco e tolgo i metadati, compresa la posizione.'),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => void run() }, message ? 'Riprova' : 'Analizza'),
      ),
    );
  }

  async function run(): Promise<void> {
    body.replaceChildren(h('p', { class: 'dish-wait', role: 'status' }, 'Analisi del piatto in corso…'));
    let dish: Dish;
    try {
      dish = await analyzeDish(img, hint.value);
    } catch (e) {
      if (!(e instanceof GeminiError)) console.warn(e);
      ready(e instanceof GeminiError ? e.message : 'Analisi non riuscita: riprova.');
      return;
    }
    const catalog = await catalogP;
    const rows: Row[] = dish.items.map((item) => {
      const match = catalog ? matchCatalog(item.search, catalog.items) : undefined;
      return { item, match, useDb: !!match, qty: item.qty, removed: false };
    });
    review(rows, dish);
  }

  function review(rows: Row[], dish: Dish): void {
    const list = h('ul', { class: 'list dish-items' });
    const total = h('div', { class: 'dish-total' });
    const add: HTMLButtonElement = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => void confirm() }, `Aggiungi a ${mealLabel(meal)}`);

    function paintTotal(): void {
      const kept = rows.filter((r) => !r.removed && r.qty > 0);
      const t = sum(kept.map((r) => scale(perOf(r), r.qty)));
      total.replaceChildren(h('span', { class: 'qty-kcal' }, `Totale ${fmtInt(t.kcal)} kcal`), macroMini(t));
      add.disabled = !kept.length;
    }

    function rowEl(r: Row): HTMLElement {
      const kcal = h('span', { class: 'row-kcal' });
      const per = () => perOf(r);
      const paint = () => {
        kcal.textContent = `${fmtInt(totalKcal(per(), r.qty))} kcal`;
        paintTotal();
      };
      const qty = decimalInput({
        class: 'dish-qty',
        value: toInput(r.qty),
        'aria-label': `Quantità di ${r.item.name} in ${r.item.unit}`,
        onInput: () => {
          const v = parseDecimal(qty.value);
          r.qty = Number.isFinite(v) && v > 0 && v <= 3000 ? v : 0;
          paint();
        },
      });
      let source: HTMLElement;
      if (r.match) {
        const select: HTMLSelectElement = h('select', {
          class: 'dish-source',
          'aria-label': `Valori per ${r.item.name}`,
          value: r.useDb ? 'db' : 'ai',
          onChange: () => {
            r.useDb = select.value === 'db';
            paint();
          },
        },
          h('option', { value: 'db' }, `Banca dati: ${r.match.item.name}`),
          h('option', { value: 'ai' }, 'Stima Gemini'),
        );
        source = select;
      } else {
        source = h('span', { class: 'muted dish-src-label' }, 'Valori stimati da Gemini');
      }
      const li = h('li', { class: 'dish-row' },
        h('div', { class: 'dish-line' },
          h('span', { class: 'row-title' }, r.item.name),
          kcal,
          h('button', {
            type: 'button',
            class: 'icon-btn dish-remove',
            'aria-label': `Togli ${r.item.name}`,
            onClick: () => {
              r.removed = true;
              li.remove();
              paintTotal();
            },
          }, '×'),
        ),
        h('div', { class: 'dish-line' },
          h('span', { class: 'dish-qty-wrap' }, qty, h('span', { class: 'unit' }, r.item.unit)),
          source,
        ),
        h('p', { class: `dish-conf conf-${r.item.confidence}` },
          `Confidenza ${r.item.confidence}`,
          r.item.note ? `: ${r.item.note}` : ''),
        ...r.item.warnings.map((w) => h('p', { class: 'warn' }, w)),
      );
      paint();
      return li;
    }

    list.replaceChildren(...rows.map(rowEl));
    paintTotal();
    body.replaceChildren(
      rows.length
        ? h('p', { class: 'muted' }, 'Controlla alimenti e quantità: sono stime. Puoi correggere i grammi, togliere voci e scegliere i valori della banca dati quando c’è un alimento corrispondente.')
        : h('p', { class: 'form-error' }, 'Gemini non ha riconosciuto alimenti in questa foto.'),
      ...(dish.notes ? [h('p', { class: 'muted' }, `Nota di Gemini: ${dish.notes}`)] : []),
      ...(dish.dropped ? [h('p', { class: 'warn' }, dish.dropped === 1 ? '1 voce scartata perché non valida.' : `${dish.dropped} voci scartate perché non valide.`)] : []),
      list,
      total,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        add,
      ),
    );

    async function confirm(): Promise<void> {
      add.disabled = true;
      const kept = rows.filter((r) => !r.removed && r.qty > 0);
      const entries: repo.NewEntry[] = [];
      for (const r of kept) {
        if (r.useDb && r.match) {
          // Primo uso di un alimento della banca dati: diventa personale, come nella ricerca.
          const f = await repo.adoptFood({ ...catalogFood(r.match.item), source: 'ch', sourceId: r.match.item.id });
          entries.push({ date, meal, foodId: f.id, name: f.name, unit: f.unit, qty: Math.round(r.qty), per100: f.per100, estimate: 'photo' });
        } else {
          entries.push({ date, meal, foodId: `foto:${crypto.randomUUID()}`, name: r.item.name, unit: r.item.unit, qty: Math.round(r.qty), per100: r.item.per100, estimate: 'photo' });
        }
      }
      close(await repo.addEntries(entries));
    }
  }

  ready();
  return h('div', { class: 'dish' },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, 'Foto del piatto'), h('p', { class: 'muted' }, `Per ${mealLabel(meal).toLowerCase()}`)),
    h('img', { class: 'dish-preview', src: preview, alt: 'Foto del piatto' }),
    body,
  );
}
