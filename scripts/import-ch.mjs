// Converte la Banca dati svizzera dei valori nutritivi (file Excel ufficiale, versione italiana)
// nel JSON compatto servito dall'app: public/data/alimenti-ch.json.
//
// Uso: node scripts/import-ch.mjs <Banca_dati_svizzera_dei_valori_nutritivi.xlsx>
// Download: https://naehrwertdaten.ch/it/downloads/
// Condizioni della fonte: uso consentito anche commerciale (es. "applicazione diario alimentare")
// con indicazione della fonte.
//
// Nessuna dipendenza: lo xlsx è uno zip di XML, letto con zlib.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const OUT = 'public/data/alimenti-ch.json';
const SHEET = 'Alimenti generici';

function fail(msg) {
  console.error(`import-ch: ${msg}`);
  process.exit(1);
}

// ---- Zip: legge la directory centrale ed estrae i file richiesti.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('il file non è uno zip/xlsx valido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('directory centrale dello zip corrotta');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) fail(`manca ${name} nello xlsx`);
    const l = f.local;
    if (buf.readUInt32LE(l) !== 0x04034b50) fail(`intestazione locale non valida per ${name}`);
    const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
    const raw = buf.subarray(start, start + f.size);
    if (f.method === 0) return raw.toString('utf8');
    if (f.method === 8) return inflateRawSync(raw).toString('utf8');
    return fail(`compressione ${f.method} non supportata`);
  };
}

// ---- XML minimo: solo ciò che serve per celle e stringhe condivise.
const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

function sheetRows(read) {
  const wb = read('xl/workbook.xml');
  const sheet = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`name="${SHEET}"`));
  if (!sheet) fail(`foglio "${SHEET}" non trovato`);
  const rid = sheet.match(/r:id="([^"]+)"/)?.[1];
  const rels = read('xl/_rels/workbook.xml.rels');
  const target = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1];
  if (!target) fail('relazione del foglio non trovata');
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const xml = read(`xl/${target.replace(/^\/?xl\//, '')}`);
  const col = (ref) => [...ref].reduce((c, ch) => c * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] ?? '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      if (v === undefined) continue;
      row[col(c[1])] = /t="s"/.test(c[2]) ? shared[Number(v)] : decode(v);
    }
    rows.push(row);
  }
  return rows;
}

// ---- Conversione
const COLUMNS = [
  ['kcal', 'Energia, kilocalorie (kcal)', 0],
  ['fat', 'Lipidi, totali (g)', 1],
  ['satFat', 'Acidi grassi, saturi (g)', 1],
  ['carbs', 'Glucidi, disponibili (g)', 1],
  ['sugars', 'Zuccheri (g)', 1],
  ['fiber', 'Fibra alimentare (g)', 1],
  ['protein', 'Proteine (g)', 1],
  ['salt', 'Sale (NaCl) (g)', 2],
];
const REQUIRED = new Set(['kcal', 'fat', 'carbs', 'protein']);

/** "tr." (tracce) e "<x" (sotto il limite di rilevazione) valgono 0; "nd" o vuoto = non disponibile. */
function value(raw, digits) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '' || s === 'nd') return null;
  if (s === 'tr.' || s.startsWith('<')) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 1000) fail(`valore non valido: "${s}"`);
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const file = process.argv[2];
if (!file) fail('indica il percorso dello xlsx scaricato da naehrwertdaten.ch');
const rows = sheetRows(unzip(readFileSync(file)));

const title = clean(rows[0]?.[0]);
const ver = title.match(/V\s*([\d.]+)\s*\((\d{2})\.(\d{2})\.(\d{4})\)/);
if (!ver) fail(`titolo inatteso: "${title}"`);
const headIdx = rows.findIndex((r) => r?.[0] === 'ID' && r.includes('Nome'));
if (headIdx < 0) fail('riga di intestazione non trovata');
const head = rows[headIdx];
const idx = (name) => {
  const i = head.indexOf(name);
  if (i < 0) fail(`colonna mancante: "${name}"`);
  return i;
};
const iId = idx('ID');
const iName = idx('Nome');
const iSyn = idx('Sinonimi');
const iCat = idx('Categoria');
const iRef = idx('Unità di riferimento');
const iCols = COLUMNS.map(([key, name, digits]) => ({ key, i: idx(name), digits }));

const foods = [];
const seen = new Set();
for (const r of rows.slice(headIdx + 1)) {
  if (!r || !r[iName]) continue;
  const id = clean(r[iId]);
  if (!/^\d{1,8}$/.test(id) || seen.has(id)) fail(`ID non valido o duplicato: "${id}"`);
  seen.add(id);
  if (clean(r[iRef]) !== 'per 100 g di parte edibile') fail(`unità di riferimento inattesa per ${id}: "${r[iRef]}"`);
  const vals = iCols.map(({ key, i, digits }) => {
    const v = value(r[i], digits);
    if (v === null && REQUIRED.has(key)) fail(`${key} mancante per ${id}`);
    return v;
  });
  foods.push([id, clean(r[iName]), clean(r[iSyn]), clean(r[iCat]).split('/')[0], vals]);
}
if (foods.length < 500) fail(`troppi pochi alimenti (${foods.length})`);
foods.sort((a, b) => a[1].localeCompare(b[1], 'it'));

const out = {
  format: 1,
  source: 'Banca dati svizzera dei valori nutritivi',
  publisher: 'Ufficio federale della sicurezza alimentare e di veterinaria (USAV)',
  version: ver[1],
  released: `${ver[4]}-${ver[3]}-${ver[2]}`,
  url: 'https://naehrwertdaten.ch',
  unit: 'g',
  nutrients: COLUMNS.map(([k]) => k),
  foods,
};
// Una riga per alimento: diff leggibili quando arriva una nuova versione.
const json = `{\n${Object.entries(out).filter(([k]) => k !== 'foods').map(([k, v]) => `"${k}":${JSON.stringify(v)},`).join('\n')}\n"foods":[\n${foods.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;
JSON.parse(json);
writeFileSync(OUT, json);
console.log(`${OUT}: ${foods.length} alimenti, versione ${out.version} del ${out.released}, ${json.length} byte.`);
