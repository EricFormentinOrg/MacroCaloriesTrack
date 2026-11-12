// Lettura della tabella nutrizionale da testo (Testo live di iOS, Google Lens, OCR): modulo puro.
// Cerca le voci della dichiarazione UE (Reg. 1169/2011) in italiano, inglese, tedesco e francese,
// prende il primo valore di ogni riga (nelle etichette UE la prima colonna è "per 100 g/ml")
// e segnala come dubbio tutto ciò che non è certo. L'utente controlla sempre prima di salvare.
import type { NutrientKey, Nutrients, Unit } from './model.js';
import { checkFood } from './nutrition.js';

export interface LabelValue {
  value: number;
  /** Riga di testo da cui viene il valore. */
  line: string;
  /** Motivo per cui il valore va controllato. */
  doubt?: string;
}

export interface LabelResult {
  unit: Unit;
  values: Partial<Record<NutrientKey, LabelValue>>;
  per100: Partial<Nutrients>;
  missing: NutrientKey[];
  /** Note sulla lettura (niente trovato, valori mancanti). */
  notes: string[];
  /** Controlli di coerenza dell'editor sui valori letti (kcal contro macro, "di cui" oltre il totale). */
  warnings: string[];
}

const KJ_PER_KCAL = 4.184;

/** Minuscole, senza accenti, spazi compattati. */
const fold = (s: string): string => s.toLocaleLowerCase('it').replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

// Ordine importante: le voci "di cui" prima delle principali che contengono la stessa parola.
const TERMS: ReadonlyArray<{ key: NutrientKey | 'energy'; re: RegExp }> = [
  { key: 'energy', re: /\b(energia|valore energetico|energy|energie|brennwert|valeur energetique|kcal|kj)\b/ },
  { key: 'satFat', re: /\b(saturi|saturates|saturated|saturated fat|gesattigte|gesaettigte|satures|sature)\b/ },
  { key: 'fat', re: /\b(grassi|lipidi|fat|fett|matieres grasses|graisses|lipides)\b/ },
  { key: 'sugars', re: /\b(zuccheri|sugars|zucker|sucres)\b/ },
  { key: 'carbs', re: /\b(carboidrati|carbohydrate|carbohydrates|kohlenhydrate|glucides)\b/ },
  { key: 'fiber', re: /\b(fibre|fibra|fibre alimentari|fiber|fibres|ballaststoffe|fibres alimentaires)\b/ },
  { key: 'protein', re: /\b(proteine|protein|proteins|eiweiss|eiweis|proteines)\b/ },
  { key: 'salt', re: /\b(sale|salt|salz|sel)\b/ },
];
// Voci da non confondere: insaturi contiene "saturi", polioli e amido sono sotto i carboidrati.
const IGNORE = /\b(monoinsaturi|polinsaturi|insaturi|mono-unsaturates|polyunsaturates|unsaturated|einfach|mehrfach|mono-insatures|polyinsatures|polioli|polyols|amido|starch|starke|amidon)\b/;

/** Numeri con virgola o punto decimale; corregge le confusioni tipiche dell'OCR (O→0, l→1). */
function numbers(line: string): Array<{ value: number; unit?: string; lessThan: boolean }> {
  const out: Array<{ value: number; unit?: string; lessThan: boolean }> = [];
  // "per 100 g" non è un valore.
  const cleaned = line.replace(/\b(per|pro|pour|for)\s*100\s*(g|ml)\b/gi, ' ');
  const fixed = cleaned
    .replace(/(?<=\d)[oO](?=\d|\b)|(?<=\b)[oO](?=[.,]\d)/g, '0')
    .replace(/(?<=\d)[lI](?=\d|\s*(?:g|mg)\b)/g, '1');
  // L'unità deve essere una parola a sé: "359 Grassi" non è "359 g".
  const re = /(<\s*)?(\d{1,4}(?:[.,]\d{1,3})?)(?:\s*(kj|kcal|mg|g|%)(?![a-z]))?/gi;
  for (const m of fixed.matchAll(re)) {
    const value = Number(m[2].replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit: m[3]?.toLowerCase(), lessThan: !!m[1] });
  }
  return out;
}

function detectUnit(text: string): Unit {
  const t = fold(text);
  if (/100\s*ml\b/.test(t)) return /100\s*g\b/.test(t) && t.indexOf('100 g') < t.indexOf('100 ml') ? 'g' : 'ml';
  return 'g';
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** kcal da una riga: unità esplicite, oppure "kJ/kcal 1521/359" con il primo numero circa 4,184 volte il secondo. */
function readEnergy(nums: ReturnType<typeof numbers>): { kcal: number; fromKcal: boolean } | undefined {
  const kcal = nums.find((n) => n.unit === 'kcal');
  if (kcal && kcal.value <= 950) return { kcal: Math.round(kcal.value), fromKcal: true };
  const bare = nums.filter((n) => !n.unit);
  if (bare.length >= 2 && Math.abs(bare[0].value / KJ_PER_KCAL - bare[1].value) <= bare[1].value * 0.08 + 2 && bare[1].value <= 950) {
    return { kcal: Math.round(bare[1].value), fromKcal: true };
  }
  const kj = nums.find((n) => n.unit === 'kj');
  if (kj && kj.value <= 4000) return { kcal: Math.round(kj.value / KJ_PER_KCAL), fromKcal: false };
  return undefined;
}

export function parseLabel(text: string): LabelResult {
  const values: Partial<Record<NutrientKey, LabelValue>> = {};
  const notes: string[] = [];
  const lessThan = new Set<NutrientKey>();
  const unit = detectUnit(text);
  // Righe; "kJ/kcal" su righe separate vengono ricongiunte con la riga dell'energia.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  let energyDone = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].slice(0, 300);
    const f = fold(raw);
    if (IGNORE.test(f)) continue;
    const term = TERMS.find((t) => t.re.test(f));
    if (!term) continue;

    if (term.key === 'energy') {
      if (energyDone) continue;
      // Una riga di soli valori ("1521 kJ/359 kcal") dopo voci senza numeri è testo per colonne: lo gestisce il fallback.
      if (/^[<\d]/.test(raw) && !Object.keys(values).length) continue;
      const energy = readEnergy(numbers(raw));
      // L'energia può stare su due righe: "Energia 1521 kJ" e "359 kcal" (la seconda senza altre voci).
      const next = lines[i + 1] ?? '';
      const nextTerm = TERMS.find((t) => t.re.test(fold(next)));
      const joined = !energy?.fromKcal && /^[<\d]/.test(next) && (!nextTerm || nextTerm.key === 'energy')
        ? readEnergy(numbers(`${raw} ${next}`))
        : undefined;
      const best = joined?.fromKcal ? joined : energy ?? joined;
      if (best) {
        values.kcal = { value: best.kcal, line: raw, ...(best.fromKcal ? {} : { doubt: 'calcolata dai kJ: controlla le kcal sull’etichetta' }) };
        energyDone = true;
      }
      continue;
    }

    const key = term.key;
    if (values[key]) continue; // prima occorrenza: la colonna per 100 g
    const nums = numbers(raw).filter((n) => n.unit !== '%' && n.unit !== 'kj' && n.unit !== 'kcal');
    const first = nums[0];
    if (!first) continue;
    let value = first.unit === 'mg' ? first.value / 1000 : first.value;
    let doubt: string | undefined;
    if (first.lessThan) {
      doubt = `indicato come “< ${String(first.value).replace('.', ',')}”: inserito 0`;
      value = 0;
      lessThan.add(key);
    }
    if (value > 100) continue;
    if (nums.length > 1 && !doubt && nums[1].value > first.value * 3 && first.value > 0) {
      doubt = 'controlla che sia il valore per 100 g e non per porzione';
    }
    values[key] = { value: key === 'salt' ? Math.round(value * 100) / 100 : round1(value), line: raw, ...(doubt ? { doubt } : {}) };
  }

  // Nessuna voce con il suo valore sulla stessa riga: testo copiato per colonne.
  if (!Object.keys(values).some((k) => k !== 'kcal')) columnFallback(lines, values);

  // "Grassi < 0,5 g" con "di cui saturi 0,3 g": il totale non può essere minore della sua parte.
  for (const [total, part] of [['fat', 'satFat'], ['carbs', 'sugars']] as const) {
    const t = values[total];
    const p = values[part];
    if (t && p && lessThan.has(total) && p.value > t.value) {
      values[total] = { ...t, value: p.value, doubt: `${t.doubt?.replace(/: inserito 0$/, '') ?? 'indicato come minore di un valore'}: inserito ${String(p.value).replace('.', ',')}, come la voce “di cui”` };
    }
  }

  const per100: Partial<Nutrients> = {};
  for (const [k, v] of Object.entries(values) as Array<[NutrientKey, LabelValue]>) per100[k] = v.value;
  const required: NutrientKey[] = ['kcal', 'fat', 'carbs', 'protein'];
  const missing = required.filter((k) => per100[k] === undefined);
  if (!Object.keys(values).length) notes.push('Nessun valore riconosciuto: incolla il testo della tabella nutrizionale.');
  else if (missing.length) notes.push('Alcuni valori obbligatori non sono stati trovati: completali a mano.');
  const warnings = missing.length ? [] : checkFood(per100 as Nutrients, unit);
  return { unit, values, per100, missing, notes, warnings };
}

/**
 * Testo copiato per colonne (prima tutte le voci, poi tutti i valori): abbina per posizione.
 * Ogni valore così trovato è dubbio.
 */
function columnFallback(lines: string[], values: Partial<Record<NutrientKey, LabelValue>>): void {
  const keys: Array<NutrientKey | 'energy' | 'skip'> = [];
  const vals: Array<{ line: string; nums: ReturnType<typeof numbers> }> = [];
  for (const raw of lines) {
    const f = fold(raw);
    const nums = numbers(raw).filter((n) => n.unit !== '%');
    if (IGNORE.test(f)) {
      // Una voce ignorata (es. insaturi) occupa comunque una posizione nella colonna dei valori.
      if (!nums.length) keys.push('skip');
      continue;
    }
    const term = TERMS.find((t) => t.re.test(f));
    if (nums.length && /^[<\d]/.test(raw)) vals.push({ line: raw, nums });
    else if (term && !nums.length) keys.push(term.key);
  }
  const doubt = 'abbinato per posizione: controlla';
  keys.forEach((k, i) => {
    const v = vals[i];
    if (!v || k === 'skip') return;
    if (k === 'energy') {
      const kcal = v.nums.find((n) => n.unit === 'kcal');
      const kj = v.nums.find((n) => n.unit === 'kj');
      if (values.kcal) return;
      if (kcal) values.kcal = { value: Math.round(kcal.value), line: v.line, doubt };
      else if (kj) values.kcal = { value: Math.round(kj.value / KJ_PER_KCAL), line: v.line, doubt };
      return;
    }
    const first = v.nums[0];
    const value = first.lessThan ? 0 : first.unit === 'mg' ? first.value / 1000 : first.value;
    if (value <= 100 && !values[k]) values[k] = { value: k === 'salt' ? Math.round(value * 100) / 100 : round1(value), line: v.line, doubt };
  });
}
