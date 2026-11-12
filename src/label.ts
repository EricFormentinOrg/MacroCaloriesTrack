// Lettura della tabella nutrizionale da testo (Testo live di iOS, Google Lens, OCR): modulo puro.
//
// 1. Cerca le voci della dichiarazione UE (Reg. 1169/2011) in italiano, inglese, tedesco e francese.
// 2. Per ogni riga prende il valore della colonna "per 100 g/ml" (di solito la prima; la seconda se
//    l'intestazione mette prima la porzione).
// 3. Per ogni numero considera anche le letture alternative tipiche degli errori di riconoscimento:
//    virgola persa ("32" per 3,2), "g" letta come 9 ("1,59" per 1,5 g), zero iniziale ("08" per 0,8).
// 4. Sceglie la combinazione più coerente con le kcal dichiarate e con le voci "di cui".
// Ogni valore corretto o incerto è segnalato: l'utente controlla sempre prima di salvare.
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

type TermKey = NutrientKey | 'energy' | 'sodium';

// Ordine importante: le voci "di cui" prima delle principali che contengono la stessa parola.
const TERMS: ReadonlyArray<{ key: TermKey; re: RegExp }> = [
  { key: 'energy', re: /\b(energia|valore energetico|energy|energie|brennwert|valeur energetique|kcal|kj)\b/ },
  { key: 'satFat', re: /\b(saturi|saturates|saturated|saturated fat|gesattigte|gesaettigte|satures|sature)\b/ },
  { key: 'fat', re: /\b(grassi|lipidi|fat|fett|matieres grasses|graisses|lipides)\b/ },
  { key: 'sugars', re: /\b(zuccheri|sugars|zucker|sucres)\b/ },
  { key: 'carbs', re: /\b(carboidrati|carbohydrate|carbohydrates|kohlenhydrate|glucides)\b/ },
  { key: 'fiber', re: /\b(fibre|fibra|fibre alimentari|fiber|fibres|ballaststoffe|fibres alimentaires)\b/ },
  { key: 'protein', re: /\b(proteine|protein|proteins|eiweiss|eiweis|proteines)\b/ },
  { key: 'salt', re: /\b(sale|salt|salz|sel)\b/ },
  { key: 'sodium', re: /\b(sodio|sodium|natrium)\b/ },
];
// Voci da non confondere: insaturi contiene "saturi", polioli e amido sono sotto i carboidrati.
const IGNORE = /\b(monoinsaturi|polinsaturi|insaturi|mono-unsaturates|polyunsaturates|unsaturated|einfach|mehrfach|mono-insatures|polyinsatures|polioli|polyols|amido|starch|starke|amidon)\b/;
const PORTION = /\b(porzione|portion|serving|pro portion|par portion|biscotto|fetta|vasetto)\b/;

// ---- Numeri e letture alternative

interface Alt {
  value: number;
  why: string;
  /** Quanto è improbabile questa lettura rispetto a quella letterale. */
  cost: number;
}

interface Num {
  value: number;
  unit?: string;
  lessThan: boolean;
  /** Letture alternative per gli errori tipici; la prima può sostituire quella letterale. */
  alts: Alt[];
  /** La lettura letterale è essa stessa una correzione (es. "08" letto come 0,8). */
  why?: string;
}

const MISSING_COMMA = 'virgola probabilmente persa';
const G_AS_9 = '“g” probabilmente letta come 9';

function alternatives(raw: string, unit: string | undefined): { primary?: { value: number; why: string }; alts: Alt[] } {
  const alts: Alt[] = [];
  const intOnly = /^\d+$/.test(raw);
  const noUnit = !unit;
  if (intOnly && raw.length >= 2 && raw[0] === '0') {
    // Le etichette non scrivono zeri iniziali: "08" è 0,8, "0139" è 0,13 g con la "g" letta come 9.
    const primary = { value: Number(`0.${raw.slice(1)}`), why: MISSING_COMMA };
    if (noUnit && raw.length >= 3 && raw.endsWith('9')) alts.push({ value: Number(`0.${raw.slice(1, -1)}`), why: `${MISSING_COMMA}; ${G_AS_9}`, cost: 1 });
    return { primary, alts };
  }
  if (intOnly && raw.length >= 2 && (!unit || unit === 'g')) {
    alts.push({ value: Number(`${raw.slice(0, -1)}.${raw.slice(-1)}`), why: MISSING_COMMA, cost: 3 });
    if (noUnit && raw.length >= 3 && raw.endsWith('9')) {
      const head = raw.slice(0, -1);
      alts.push({ value: Number(head), why: G_AS_9, cost: 2 });
      alts.push({ value: Number(`${head.slice(0, -1)}.${head.slice(-1)}`), why: `${MISSING_COMMA}; ${G_AS_9}`, cost: 2 });
    }
  }
  const dec = raw.match(/^(\d+)[.,](\d{2,3})$/);
  if (dec && noUnit && dec[2].endsWith('9')) {
    // "4,99" per "4,9 g": due decimali che finiscono con 9 sono quasi sempre una "g".
    alts.push({ value: Number(`${dec[1]}.${dec[2].slice(0, -1)}`), why: G_AS_9, cost: 1 });
  }
  return { alts };
}

/** Numeri di una riga, con correzioni dei caratteri confusi (O→0, l→1) e unità messe prima del numero. */
function numbers(line: string): Num[] {
  const cleaned = line
    .replace(/\b(per|pro|pour|for)\s*100\s*(g|ml)\b/gi, ' ') // "per 100 g" non è un valore
    .replace(/\bk[ce][ao][l1iI]\b/gi, 'kcal') // keal, kcai, kca1
    // "kJ 1596 - kcal 376" → "1596 kJ - 376 kcal" (non "kJ/kcal 1521/359")
    .replace(/(?<![/\w])(?<!\d\s*)(kj|kcal)(?![/\w])\s*[:-]?\s*(\d{1,4}(?:[.,]\d{1,3})?)(?![\d.,])(?!\s*(?:kj|kcal|\/))/gi, '$2 $1');
  const fixed = cleaned
    .replace(/(?<=\d)[oO](?=\d|\b)|\b[oO](?=[.,]\d)|\b[oO](?=\s*g\b)/g, '0')
    .replace(/(?<=\d)[lI](?=\d|\s*(?:g|mg)\b)/g, '1');
  const out: Num[] = [];
  // L'unità deve essere una parola a sé: "359 Grassi" non è "359 g".
  const re = /(<\s*)?(\d{1,4}(?:[.,]\d{1,3})?)(?:\s*(kj|kcal|mg|g|%)(?![a-z]))?/gi;
  for (const m of fixed.matchAll(re)) {
    const raw = m[2];
    const unit = m[3]?.toLowerCase();
    let value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    // "1.596 kJ": punto delle migliaia.
    if ((unit === 'kj' || unit === 'kcal') && /^\d\.\d{3}$/.test(raw)) value = Number(raw.replace('.', ''));
    if (unit === 'kj' || unit === 'kcal' || unit === '%') {
      out.push({ value, unit, lessThan: !!m[1], alts: [] });
      continue;
    }
    const a = alternatives(raw, unit);
    out.push(a.primary
      ? { value: a.primary.value, why: a.primary.why, unit, lessThan: !!m[1], alts: a.alts }
      : { value, unit, lessThan: !!m[1], alts: a.alts });
  }
  return out;
}

/** kcal da una riga: unità esplicite, oppure "kJ/kcal 1521/359" con il primo numero circa 4,184 volte il secondo. */
function readEnergy(nums: Num[], col = 0): { kcal: number; fromKcal: boolean } | undefined {
  const pickCol = (list: Num[]) => list[col] ?? list[0];
  const kcal = pickCol(nums.filter((n) => n.unit === 'kcal'));
  if (kcal && kcal.value <= 950) return { kcal: Math.round(kcal.value), fromKcal: true };
  const bare = nums.filter((n) => !n.unit).slice(col * 2);
  if (bare.length >= 2 && Math.abs(bare[0].value / KJ_PER_KCAL - bare[1].value) <= bare[1].value * 0.08 + 2 && bare[1].value <= 950) {
    return { kcal: Math.round(bare[1].value), fromKcal: true };
  }
  const kj = pickCol(nums.filter((n) => n.unit === 'kj'));
  if (kj && kj.value <= 4000) return { kcal: Math.round(kj.value / KJ_PER_KCAL), fromKcal: false };
  return undefined;
}

function detectUnit(text: string): Unit {
  const t = fold(text);
  if (/100\s*ml\b/.test(t)) return /100\s*g\b/.test(t) && t.indexOf('100 g') < t.indexOf('100 ml') ? 'g' : 'ml';
  return 'g';
}

/** Colonna dei valori per 100 g: la seconda se l'intestazione mette prima la porzione. */
function valueColumn(lines: string[]): number {
  for (const l of lines.slice(0, 15)) {
    const f = fold(l);
    const i100 = f.search(/100\s*(g|ml)\b/);
    const iPortion = f.search(PORTION);
    if (i100 >= 0 && iPortion >= 0) return iPortion < i100 ? 1 : 0;
  }
  return 0;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- Candidati e scelta

interface Candidate {
  value: number;
  cost: number;
  why?: string;
}

interface Raw {
  line: string;
  candidates: Candidate[];
  lessThan: boolean;
  doubt?: string;
}

/** Penalità per una precisione che sulle etichette UE è insolita (es. due decimali sui grassi). */
function precisionPenalty(key: NutrientKey, v: number): number {
  const decimals = (String(v).split('.')[1] ?? '').length;
  if (key === 'salt') return decimals > 2 ? 2 : 0;
  if (decimals >= 2) return 2;
  return 0;
}

function candidatesOf(key: NutrientKey, n: Num): Candidate[] {
  const factor = n.unit === 'mg' ? 0.001 : 1;
  const list: Candidate[] = [];
  const push = (value: number, cost: number, why?: string) => {
    const v = value * factor;
    if (v < 0 || v > 100 || list.some((c) => Math.abs(c.value - v) < 1e-9)) return;
    list.push({ value: v, cost: cost + precisionPenalty(key, v), ...(why ? { why } : {}) });
  };
  push(n.value, n.why ? 1 : 0, n.why);
  for (const a of n.alts) push(a.value, a.cost, a.why);
  return list;
}

const atwater = (fat: number, carbs: number, protein: number, fiber = 0): number => 9 * fat + 4 * carbs + 4 * protein + 2 * fiber;

/**
 * Sceglie un candidato per voce. Con le kcal e i tre macronutrienti, prova le combinazioni e preferisce
 * quella coerente con l'energia (stessa tolleranza dei controlli dell'editor); a parità, la lettura letterale.
 */
function choose(raws: Partial<Record<NutrientKey, Raw>>, kcal: number | undefined): Partial<Record<NutrientKey, Candidate>> {
  const pick: Partial<Record<NutrientKey, Candidate>> = {};
  const cheapest = (k: NutrientKey, ok: (c: Candidate) => boolean = () => true): Candidate | undefined =>
    [...(raws[k]?.candidates ?? [])].filter(ok).sort((a, b) => a.cost - b.cost)[0];

  const f = raws.fat?.candidates ?? [];
  const c = raws.carbs?.candidates ?? [];
  const p = raws.protein?.candidates ?? [];
  const fib = raws.fiber?.candidates.length ? raws.fiber.candidates : [undefined];
  if (kcal !== undefined && f.length && c.length && p.length) {
    let best: { score: number; combo: Array<Candidate | undefined> } | undefined;
    for (const cf of f) for (const cc of c) for (const cp of p) for (const cx of fib) {
      const atw = atwater(cf.value, cc.value, cp.value, cx?.value ?? 0);
      const err = Math.abs(kcal - atw);
      const tol = Math.max(20, 0.15 * Math.max(kcal, atw));
      // Solo combinazioni coerenti con l'energia: se nessuna lo è, restano le letture letterali
      // e l'editor mostra l'incoerenza invece di nasconderla con correzioni inventate.
      if (err > tol) continue;
      const score = cf.cost + cc.cost + cp.cost + (cx?.cost ?? 0) + err / 50;
      if (!best || score < best.score) best = { score, combo: [cf, cc, cp, cx] };
    }
    if (best) {
      const [cf, cc, cp, cx] = best.combo;
      pick.fat = cf;
      pick.carbs = cc;
      pick.protein = cp;
      if (cx) pick.fiber = cx;
    }
  }
  for (const k of ['fat', 'carbs', 'protein', 'fiber'] as const) if (!pick[k]) {
    const ch = cheapest(k);
    if (ch) pick[k] = ch;
  }
  // Le voci "di cui" non superano il totale.
  const satOk = (x: Candidate) => pick.fat === undefined || x.value <= pick.fat.value + 0.05;
  const sugOk = (x: Candidate) => pick.carbs === undefined || x.value <= pick.carbs.value + 0.05;
  const sat = cheapest('satFat', satOk) ?? cheapest('satFat');
  const sug = cheapest('sugars', sugOk) ?? cheapest('sugars');
  if (sat) pick.satFat = sat;
  if (sug) pick.sugars = sug;
  const salt = cheapest('salt');
  if (salt) pick.salt = salt;
  return pick;
}

export function parseLabel(text: string): LabelResult {
  const notes: string[] = [];
  const unit = detectUnit(text);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200).map((l) => l.slice(0, 300));
  const col = valueColumn(lines);
  const raws: Partial<Record<NutrientKey, Raw>> = {};
  let energy: { kcal: number; fromKcal: boolean; line: string } | undefined;
  let sodium: { value: number; line: string } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = fold(raw);
    if (IGNORE.test(f)) continue;
    const term = TERMS.find((t) => t.re.test(f));
    if (!term) continue;

    if (term.key === 'energy') {
      if (energy) continue;
      // Una riga di soli valori ("1521 kJ/359 kcal") dopo voci senza numeri è testo per colonne: lo gestisce il fallback.
      if (/^[<\d]/.test(raw) && !Object.keys(raws).length) continue;
      const e = readEnergy(numbers(raw), col);
      // L'energia può stare su due righe: "Energia 1521 kJ" e "359 kcal" (la seconda senza altre voci).
      const next = lines[i + 1] ?? '';
      const nextTerm = TERMS.find((t) => t.re.test(fold(next)));
      const joined = !e?.fromKcal && /^[<\d]/.test(next) && (!nextTerm || nextTerm.key === 'energy')
        ? readEnergy(numbers(`${raw} ${next}`), col)
        : undefined;
      const best = joined?.fromKcal ? joined : e ?? joined;
      if (best) energy = { ...best, line: raw };
      continue;
    }

    const nums = numbers(raw).filter((n) => n.unit !== '%' && n.unit !== 'kj' && n.unit !== 'kcal');
    const n = nums[col] ?? nums[0];
    if (!n) continue;
    const doubt = col === 1 && nums[col] ? 'preso dalla seconda colonna, quella per 100 g: controlla' : undefined;

    if (term.key === 'sodium') {
      if (!sodium) sodium = { value: n.unit === 'mg' ? n.value / 1000 : n.value, line: raw };
      continue;
    }
    const key = term.key;
    if (raws[key]) continue; // prima occorrenza: la tabella, non gli ingredienti
    if (n.lessThan) {
      raws[key] = { line: raw, lessThan: true, candidates: [{ value: 0, cost: 0 }], doubt: `indicato come “< ${String(n.value).replace('.', ',')}”: inserito 0` };
      continue;
    }
    const candidates = candidatesOf(key, n);
    if (!candidates.length) continue;
    raws[key] = { line: raw, lessThan: false, candidates, ...(doubt ? { doubt } : {}) };
  }

  const values: Partial<Record<NutrientKey, LabelValue>> = {};
  if (energy) {
    values.kcal = { value: energy.kcal, line: energy.line, ...(energy.fromKcal ? {} : { doubt: 'calcolata dai kJ: controlla le kcal sull’etichetta' }) };
  }
  const pick = choose(raws, energy?.kcal);
  for (const [k, c] of Object.entries(pick) as Array<[NutrientKey, Candidate]>) {
    const r = raws[k];
    if (!r) continue;
    const doubt = [r.doubt, c.why ? `${c.why}: controlla` : undefined].filter(Boolean).join('; ');
    values[k] = { value: k === 'salt' ? round2(c.value) : round1(c.value), line: r.line, ...(doubt ? { doubt } : {}) };
  }
  if (!values.salt && sodium && sodium.value <= 40) {
    values.salt = { value: round2(sodium.value * 2.5), line: sodium.line, doubt: 'calcolato dal sodio (× 2,5)' };
  }

  // Nessuna voce con il suo valore sulla stessa riga: testo copiato per colonne.
  if (!Object.keys(values).some((k) => k !== 'kcal')) columnFallback(lines, values);

  // "Grassi < 0,5 g" con "di cui saturi 0,3 g": il totale non può essere minore della sua parte.
  for (const [total, part] of [['fat', 'satFat'], ['carbs', 'sugars']] as const) {
    const t = values[total];
    const p = values[part];
    if (t && p && raws[total]?.lessThan && p.value > t.value) {
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
  const keys: Array<TermKey | 'skip'> = [];
  const vals: Array<{ line: string; nums: Num[] }> = [];
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
    if (!v || k === 'skip' || k === 'sodium') return;
    if (k === 'energy') {
      if (values.kcal) return;
      const e = readEnergy(v.nums);
      if (e) values.kcal = { value: e.kcal, line: v.line, doubt };
      return;
    }
    const first = v.nums[0];
    const value = first.lessThan ? 0 : first.unit === 'mg' ? first.value / 1000 : first.value;
    if (value <= 100 && !values[k]) values[k] = { value: k === 'salt' ? round2(value) : round1(value), line: v.line, doubt };
  });
}
