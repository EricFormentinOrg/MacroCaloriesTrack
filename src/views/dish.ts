// Stima del pasto con Gemini o OpenRouter, da foto del piatto o da descrizione scritta.
// L'utente controlla alimenti, quantità e valori per 100 g, poi conferma. Niente salvataggio automatico.
import { catalogFood } from '../catalog.js';
import type { Catalog } from '../catalog.js';
import { macroMini } from '../components.js';
import { GeminiError, TEXT_MAX, editedValues, matchCatalog, totalKcal } from '../dishAi.js';
import type { DishInput, DishItem, DishKind, Match } from '../dishAi.js';
import { analyzeDish, dishProviders } from '../dishService.js';
import type { DishProviders, DishResult } from '../dishService.js';
import { fmtInt, parseDecimal, toInput } from '../format.js';
import { prepareImage } from '../gemini.js';
import type { PreparedImage } from '../gemini.js';
import { NUTRIENTS, mealLabel } from '../model.js';
import type { Entry, Meal, NutrientKey, Nutrients } from '../model.js';
import { checkFood, scale, sum } from '../nutrition.js';
import * as repo from '../repo.js';
import { loadCatalog } from '../sources.js';
import { decimalInput, h, nextId, openSheet, toast } from '../ui.js';

/** Da dove vengono i valori per 100 g di una voce. */
type Values = 'db' | 'ai' | 'edit';

interface Row {
  item: DishItem;
  match?: Match;
  values: Values;
  /** Valori per 100 g/ml corretti dall'utente. */
  edited?: Nutrients;
  /** I valori corretti non sono validi: finché restano così non si può aggiungere. */
  invalid: boolean;
  qty: number;
  removed: boolean;
}

const perOf = (r: Row): Nutrients =>
  r.values === 'db' && r.match ? r.match.item.per100 : r.values === 'edit' && r.edited ? r.edited : r.item.per100;

interface Flow {
  kind: DishKind;
  title: string;
  /** Solo per la foto. */
  img?: PreparedImage;
  preview?: string;
}

const WORDS: Record<DishKind, { sent: string; option: string; empty: string; wait: string; back: string }> = {
  photo: {
    back: 'Modifica le indicazioni',
    sent: 'La foto viene inviata',
    option: 'Stima dalla foto',
    empty: 'Il modello non ha riconosciuto alimenti in questa foto.',
    wait: 'Analisi del piatto in corso…',
  },
  text: {
    back: 'Modifica la descrizione',
    sent: 'La descrizione viene inviata',
    option: 'Stima dalla descrizione',
    empty: 'Il modello non ha riconosciuto alimenti nella descrizione.',
    wait: 'Analisi della descrizione in corso…',
  },
};

/** Senza chiavi: spiega cosa serve e porta alle impostazioni. */
async function needKey(title: string): Promise<void> {
  await openSheet(title, (close) => h('div', null,
    h('h2', { class: 'sheet-title' }, title),
    h('p', null, 'Per stimare un pasto serve una tua chiave Gemini o OpenRouter. Inseriscila in Impostazioni, sezioni “Gemini” e “OpenRouter”.'),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
      h('a', { class: 'btn btn-primary', href: '#/impostazioni', onClick: () => close() }, 'Vai alle impostazioni'),
    ),
  ));
}

/** Avvia la stima dal file scelto o scattato. Restituisce le voci aggiunte (per l'annullamento). */
export async function openDishPhoto(file: File, date: string, meal: Meal): Promise<Entry[] | undefined> {
  const title = 'Foto del piatto';
  const providers = await dishProviders();
  if (!providers.gemini && !providers.openrouter) {
    await needKey(title);
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
    return await openSheet<Entry[]>(title, (close) => build(close, { kind: 'photo', title, img, preview }, catalogP, date, meal, providers));
  } finally {
    URL.revokeObjectURL(preview);
  }
}

/** Avvia la stima da una descrizione scritta. Restituisce le voci aggiunte (per l'annullamento). */
export async function openDishText(date: string, meal: Meal): Promise<Entry[] | undefined> {
  const title = 'Descrivi il pasto';
  const providers = await dishProviders();
  if (!providers.gemini && !providers.openrouter) {
    await needKey(title);
    return undefined;
  }
  const catalogP: Promise<Catalog | undefined> = loadCatalog().catch(() => undefined);
  return openSheet<Entry[]>(title, (close) => build(close, { kind: 'text', title }, catalogP, date, meal, providers));
}

/** Dove va la foto o la descrizione, secondo le chiavi inserite e il servizio scelto come primo. */
function destination(p: DishProviders): string {
  if (p.gemini && p.openrouter) {
    return p.first === 'openrouter'
      ? 'a OpenRouter e, se non risponde, a Google Gemini, con le tue chiavi'
      : 'a Google Gemini e, se non risponde, a OpenRouter, con le tue chiavi';
  }
  return p.gemini ? 'a Google Gemini con la tua chiave' : 'a OpenRouter con la tua chiave';
}

function build(close: (v?: Entry[]) => void, flow: Flow, catalogP: Promise<Catalog | undefined>, date: string, meal: Meal, providers: DishProviders): HTMLElement {
  const words = WORDS[flow.kind];
  const body = h('div', { class: 'dish-body', 'aria-live': 'polite' });
  const text: HTMLTextAreaElement = flow.kind === 'photo'
    ? h('textarea', {
      class: 'label-text dish-hint',
      rows: 2,
      maxlength: 300,
      placeholder: 'Facoltativo: es. pasta al pomodoro con parmigiano, porzione abbondante',
      'aria-label': 'Descrizione del piatto',
    })
    : h('textarea', {
      class: 'label-text dish-text',
      rows: 4,
      maxlength: TEXT_MAX,
      placeholder: 'Es. 2 fette di pizza margherita, una birra media e un caffè con un cucchiaino di zucchero',
      'aria-label': 'Cosa hai mangiato',
    });

  /** `retry`: dopo un errore del servizio il pulsante dice "Riprova"; dopo un campo vuoto resta "Analizza". */
  function ready(message?: string, retry = !!message): void {
    const privacy = flow.kind === 'photo'
      ? `${words.sent} ${destination(providers)}. Prima la riduco e tolgo i metadati, compresa la posizione.`
      : `${words.sent} ${destination(providers)}.`;
    body.replaceChildren(
      ...(flow.kind === 'text' ? [h('p', { class: 'muted' }, 'Scrivi cosa hai mangiato, con le quantità se le sai: grammi, pezzi, fette, cucchiai.')] : []),
      text,
      ...(message ? [h('p', { class: 'form-error', role: 'alert' }, message)] : []),
      h('p', { class: 'muted' }, privacy),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => void run() }, retry ? 'Riprova' : 'Analizza'),
      ),
    );
  }

  async function run(): Promise<void> {
    let input: DishInput;
    if (flow.kind === 'photo' && flow.img) {
      input = { kind: 'photo', base64: flow.img.base64, mimeType: flow.img.mimeType, hint: text.value };
    } else {
      if (!text.value.trim()) {
        ready('Scrivi cosa hai mangiato.', false);
        text.focus();
        return;
      }
      input = { kind: 'text', text: text.value };
    }
    const wait = h('p', { class: 'dish-wait', role: 'status' }, words.wait);
    body.replaceChildren(wait);
    let dish: DishResult;
    try {
      dish = await analyzeDish(input, (from, to) => {
        wait.textContent = `${from} non è disponibile ora: provo con ${to}…`;
      });
    } catch (e) {
      if (!(e instanceof GeminiError)) console.warn(e);
      ready(e instanceof GeminiError ? e.message : 'Analisi non riuscita: riprova.');
      return;
    }
    const catalog = await catalogP;
    const rows: Row[] = dish.items.map((item) => {
      const match = catalog ? matchCatalog(item.search, catalog.items) : undefined;
      return { item, match, values: match ? 'db' : 'ai', invalid: false, qty: item.qty, removed: false };
    });
    review(rows, dish);
  }

  function review(rows: Row[], dish: DishResult): void {
    const list = h('ul', { class: 'list dish-items' });
    const total = h('div', { class: 'dish-total' });
    const blocked = h('p', { class: 'form-error', role: 'alert', hidden: true }, 'Correggi i valori segnalati prima di aggiungere.');
    const add: HTMLButtonElement = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => void confirm() }, `Aggiungi a ${mealLabel(meal)}`);

    const kept = (): Row[] => rows.filter((r) => !r.removed && r.qty > 0);

    function paintTotal(): void {
      const k = kept();
      const t = sum(k.map((r) => scale(perOf(r), r.qty)));
      total.replaceChildren(h('span', { class: 'qty-kcal' }, `Totale ${fmtInt(t.kcal)} kcal`), macroMini(t));
      const invalid = k.some((r) => r.invalid);
      blocked.hidden = !invalid;
      add.disabled = !k.length || invalid;
    }

    function rowEl(r: Row): HTMLElement {
      const kcal = h('span', { class: 'row-kcal' });
      const warns = h('div', { class: 'dish-warns' });
      const valuesError = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const inputs = {} as Record<NutrientKey, HTMLInputElement>;

      const paint = () => {
        kcal.textContent = `${fmtInt(totalKcal(perOf(r), r.qty))} kcal`;
        // Avvisi di coerenza solo su valori stimati o corretti: quelli della banca dati sono la fonte
        // (e per le bevande alcoliche l'avviso kcal/macro sarebbe un falso allarme).
        const w = r.values === 'db' ? [] : checkFood(perOf(r), r.item.unit);
        warns.replaceChildren(...w.map((x) => h('p', { class: 'warn' }, x)));
        paintTotal();
      };

      /** Mostra nei campi i valori in uso (banca dati, stima o correzione). */
      const fill = () => {
        const p = perOf(r);
        for (const n of NUTRIENTS) {
          const v = p[n.key];
          inputs[n.key].value = v !== undefined ? toInput(v) : '';
        }
        r.invalid = false;
        valuesError.hidden = true;
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

      const editOption = h('option', { value: 'edit' }, 'Valori corretti da te');
      const select: HTMLSelectElement = h('select', {
        class: 'dish-source',
        'aria-label': `Valori per ${r.item.name}`,
        onChange: () => {
          r.values = select.value as Values;
          fill();
          paint();
        },
      },
        r.match ? h('option', { value: 'db' }, `Banca dati: ${r.match.item.name}`) : null,
        h('option', { value: 'ai' }, words.option),
      );
      select.value = r.values;

      /** Un campo corretto: i valori diventano quelli scritti dall'utente. */
      const onEdit = () => {
        const raw: Partial<Record<NutrientKey, string>> = {};
        for (const n of NUTRIENTS) raw[n.key] = inputs[n.key].value;
        const res = editedValues(raw);
        if (!editOption.parentNode) select.append(editOption);
        select.value = 'edit';
        r.values = 'edit';
        if ('error' in res) {
          r.invalid = true;
          valuesError.textContent = res.error;
          valuesError.hidden = false;
        } else {
          r.invalid = false;
          r.edited = res.per100;
          valuesError.hidden = true;
        }
        paint();
      };

      const unitLabel = r.item.unit;
      const valueRows = NUTRIENTS.map((n) => {
        const inp = decimalInput({ id: nextId('dv'), onInput: onEdit });
        inputs[n.key] = inp;
        return h('div', { class: `nrow${n.sub ? ' sub' : ''}` },
          h('label', { for: inp.id }, n.label, n.required ? null : h('span', { class: 'opt' }, ' facoltativo')),
          inp,
          h('span', { class: 'unit' }, n.unit === 'kcal' ? 'kcal' : 'g'),
        );
      });
      fill();

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
          select,
        ),
        h('p', { class: `dish-conf conf-${r.item.confidence}` },
          `Confidenza ${r.item.confidence}`,
          r.item.note ? `: ${r.item.note}` : ''),
        h('details', { class: 'dish-values' },
          h('summary', null, `Valori per 100 ${unitLabel}`),
          h('div', { class: 'ngrid' }, ...valueRows),
          valuesError,
        ),
        warns,
      );
      paint();
      return li;
    }

    list.replaceChildren(...rows.map(rowEl));
    paintTotal();
    body.replaceChildren(
      rows.length
        ? h('p', { class: 'muted' }, 'Controlla alimenti, quantità e valori: sono stime. Puoi correggere i grammi e i valori per 100 g, togliere voci e scegliere i valori della banca dati quando c’è un alimento corrispondente.')
        : h('p', { class: 'form-error' }, words.empty),
      ...(dish.fallbackFrom
        ? [h('p', { class: 'muted dish-fallback' }, `Stima fatta con ${dish.source}: ${dish.fallbackFrom} non era disponibile.`)]
        : []),
      ...(dish.notes ? [h('p', { class: 'muted' }, `Nota del modello: ${dish.notes}`)] : []),
      ...(dish.dropped ? [h('p', { class: 'warn' }, dish.dropped === 1 ? '1 voce scartata perché non valida.' : `${dish.dropped} voci scartate perché non valide.`)] : []),
      // Torna al testo, che resta com'era, per correggerlo e rifare la stima.
      h('button', { type: 'button', class: 'btn btn-quiet dish-back', onClick: () => ready() }, `‹ ${words.back}`),
      list,
      total,
      blocked,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
        add,
      ),
    );

    async function confirm(): Promise<void> {
      const k = kept();
      if (!k.length || k.some((r) => r.invalid)) return;
      add.disabled = true;
      const estimate = flow.kind;
      const entries: repo.NewEntry[] = [];
      for (const r of k) {
        const qty = Math.round(r.qty);
        if (r.values === 'db' && r.match) {
          // Primo uso di un alimento della banca dati: diventa personale, come nella ricerca.
          const f = await repo.adoptFood({ ...catalogFood(r.match.item), source: 'ch', sourceId: r.match.item.id });
          entries.push({ date, meal, foodId: f.id, name: f.name, unit: f.unit, qty, per100: f.per100, estimate });
        } else {
          entries.push({ date, meal, foodId: `${estimate === 'photo' ? 'foto' : 'testo'}:${crypto.randomUUID()}`, name: r.item.name, unit: r.item.unit, qty, per100: { ...perOf(r) }, estimate });
        }
      }
      close(await repo.addEntries(entries));
    }
  }

  ready();
  return h('div', { class: 'dish' },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, flow.title), h('p', { class: 'muted' }, `Per ${mealLabel(meal).toLowerCase()}`)),
    flow.preview ? h('img', { class: 'dish-preview', src: flow.preview, alt: 'Foto del piatto' }) : null,
    body,
  );
}
