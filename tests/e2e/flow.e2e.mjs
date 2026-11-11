// Test end-to-end del flusso completo, in Chromium headless con viewport da iPhone.
// Requisiti (una tantum): npm i -D playwright && npx playwright install chromium
// Uso: npm run build && npm run e2e
// Fallisce su qualunque errore JavaScript o violazione CSP. Le schermate vanno in tests/e2e/screens/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 8181;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = 'tests/e2e/screens';
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const problems = [];
const browser = await chromium.launch();
let failed = false;

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  await ctx.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error('CSP-VIOLATION', e.violatedDirective, e.blockedURI)),
  );
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
  const toast = async () => { await page.waitForSelector('#toast.show'); return page.textContent('#toast'); };
  const today = await (async () => {
    await page.goto(BASE);
    return page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
  })();

  // Diario vuoto
  await page.waitForSelector('.diary');
  assert.match(await page.textContent('.hero-line'), /^0\s*kcal$/);
  await shot('01-diario-vuoto');

  // Profilo: uomo, nato il giorno dopo oggi di 36 anni fa → 35 anni
  const birth = `${Number(today.slice(0, 4)) - 36}${today.slice(4)}`;
  const birthNext = await page.evaluate((b) => {
    const [y, m, d] = b.split('-').map(Number);
    const x = new Date(y, m - 1, d + 1);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }, birth);
  await page.click('a[data-tab="profilo"]');
  await page.waitForSelector('.profile');
  await page.click('.seg-opt:has-text("Uomo")');
  await page.fill('input[type=date]', birthNext);
  const dec = page.locator('.profile input[inputmode=decimal]');
  await dec.nth(0).fill('180');
  await dec.nth(1).fill('82,4');
  await page.selectOption('.profile select >> nth=0', '1.55');
  await page.click('.seg-opt:has-text("Perdere")');
  await dec.nth(2).fill('76');
  // BMR 10×82,4 + 6,25×180 − 5×35 + 5 = 1779; ×1,55 − 550 = 2207
  assert.match(await page.textContent('.plan-target'), /2\.?207/);
  await shot('02-profilo');
  await page.click('text=Salva profilo');
  assert.equal(await toast(), 'Profilo salvato');

  // Alimenti
  const order = ['kcal', 'kj', 'fat', 'satFat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'];
  async function fillFood(name, brand, vals, servings = []) {
    await page.goto(BASE + '#/alimento/nuovo');
    await page.waitForSelector('.food-edit');
    await page.fill('.food-edit .field input >> nth=0', name);
    if (brand) await page.fill('.food-edit .field input >> nth=1', brand);
    const rows = page.locator('.nrow input');
    for (const [k, v] of Object.entries(vals)) await rows.nth(order.indexOf(k)).fill(v);
    for (const [l, q] of servings) {
      await page.click('text=Aggiungi una porzione');
      const s = page.locator('.serving').last();
      await s.locator('input').nth(0).fill(l);
      await s.locator('input').nth(1).fill(q);
    }
  }
  async function saveFood() {
    await page.click('button:has-text("Crea alimento")');
    await page.waitForSelector('.foods');
  }

  await fillFood('Yogurt greco 0%', 'Fage', { kcal: '54', fat: '0', carbs: '3', sugars: '3', protein: '10,3', salt: '0,1' }, [['vasetto', '170']]);
  await shot('03-nuovo-alimento');
  await saveFood();

  await fillFood('Spaghetti', 'Barilla', { kj: '1521', fat: '2', satFat: '0,5', carbs: '71,2', sugars: '3,5', fiber: '3', protein: '12,5', salt: '0,01' });
  assert.equal(await page.inputValue('.nrow input >> nth=0'), '364', 'conversione kJ → kcal');
  await saveFood();

  await fillFood('Olio extravergine', '', { kcal: '500', fat: '100', carbs: '0', protein: '0' });
  assert.match(await page.textContent('.checks'), /circa 900 kcal, non 500/);
  await page.fill('.nrow input >> nth=0', '899');
  assert.equal((await page.textContent('.checks')).trim(), '');
  await saveFood();
  await shot('04-alimenti');

  await page.goto(BASE + '#/alimento/nuovo');
  await page.waitForSelector('.food-edit');
  await page.click('button:has-text("Crea alimento")');
  assert.match(await page.textContent('.errors'), /Inserisci il nome/);

  // Aggiunte al diario
  async function add(meal, food, qty, servingIdx) {
    await page.goto(`${BASE}#/aggiungi/${today}/${meal}`);
    await page.waitForSelector('.add');
    await page.fill('.search', food.split(' ')[0].toLowerCase());
    await page.click(`.results .row:has-text("${food}")`);
    await page.waitForSelector('dialog.sheet[open]');
    if (servingIdx !== undefined) await page.selectOption('dialog .qty-unit', String(servingIdx));
    await page.fill('dialog .qty-input', qty);
    if (meal === 'breakfast') await shot('05-foglio-quantita');
    await page.click('dialog button:has-text("Aggiungi")');
    await page.waitForSelector('dialog.sheet', { state: 'detached' });
  }
  await add('breakfast', 'Yogurt greco 0%', '1', 0);
  await add('lunch', 'Spaghetti', '90');
  await add('lunch', 'Olio extravergine', '10');
  await add('dinner', 'Spaghetti', '80');
  await add('snack', 'Yogurt greco 0%', '0,5', 0);

  // Ricerca e "crea dalla ricerca"
  await page.goto(`${BASE}#/aggiungi/${today}/dinner`);
  await page.waitForSelector('.add');
  await page.fill('.search', 'olio extra');
  assert.equal(await page.locator('.results .row').count(), 1);
  await page.fill('.search', 'Bresaola');
  await page.click('text=Crea un alimento');
  await page.waitForSelector('.food-edit');
  assert.equal(await page.inputValue('.food-edit .field input >> nth=0'), 'Bresaola');
  const rows = page.locator('.nrow input');
  await rows.nth(0).fill('151');
  await rows.nth(2).fill('2,6');
  await rows.nth(4).fill('0');
  await rows.nth(7).fill('32');
  await page.click('button:has-text("Crea alimento")');
  await page.waitForSelector('dialog.sheet[open]');
  assert.equal(await page.inputValue('dialog .qty-input'), '100');
  await page.fill('dialog .qty-input', '60');
  await page.click('dialog button:has-text("Aggiungi")');
  await page.waitForSelector('dialog.sheet', { state: 'detached' });

  // Totale: 91,8 + 327,6 + 89,9 + 291,2 + 45,9 + 90,6 = 937,0 kcal
  await page.goto(BASE + '#/');
  await page.waitForSelector('.diary');
  assert.match(await page.textContent('.hero-sub'), /^937 consumate su 2\.?207$/);
  assert.equal(await page.locator('.day-seg').count(), 4);
  await shot('06-diario');

  // Modifica: cena a 600 g → 2829,8 kcal, oltre di 623
  await page.click('.meal:has(h2:text("Cena")) .row:has-text("Spaghetti")');
  await page.waitForSelector('dialog.sheet[open]');
  await page.fill('dialog .qty-input', '600');
  await page.click('dialog button:has-text("Salva")');
  await page.waitForSelector('dialog.sheet', { state: 'detached' });
  await page.waitForSelector('.over-zone');
  assert.match(await page.textContent('.hero-line'), /^Oltre di 623\s*kcal$/);
  await shot('07-oltre-obiettivo');

  // Elimina e annulla
  const snackRows = () => page.locator('.meal:has(h2:text("Spuntino")) .row').count();
  await page.click('.meal:has(h2:text("Spuntino")) .row');
  await page.click('dialog button:has-text("Elimina")');
  await page.waitForFunction(() => document.querySelectorAll('.meal .row').length === 5);
  assert.equal(await snackRows(), 0);
  await page.click('.toast-action');
  await page.waitForFunction(() => document.querySelectorAll('.meal .row').length === 6);
  assert.equal(await snackRows(), 1);

  // Navigazione giorni
  await page.click('a[aria-label="Giorno precedente"]');
  await page.waitForSelector('.jump-today');
  assert.equal(await page.textContent('.date-title h1'), 'Ieri');
  await page.click('.jump-today');
  await page.waitForSelector('.meal .row');

  // Export JSON e CSV, poi import senza modifiche
  await page.click('a[data-tab="impostazioni"]');
  await page.waitForSelector('.settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Esporta backup')]);
  const backupPath = `${SHOTS}/backup.json`;
  await dl.saveAs(backupPath);
  assert.match(dl.suggestedFilename(), /^macro-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('text=Esporta il diario in CSV')]);
  assert.match(dl2.suggestedFilename(), /\.csv$/);
  await page.setInputFiles('.settings input[type=file]', backupPath);
  await page.waitForSelector('dialog.sheet[open]');
  assert.match(await page.textContent('dialog p'), /4 alimenti, 6 voci di diario, 1 pesata e il profilo/);
  await page.click('dialog button:has-text("Unisci")');
  assert.match(await toast(), /Nessuna modifica/);

  // Cancella tutto e ripristina con "Sostituisci"
  await page.click('text=Cancella tutti i dati');
  await page.click('dialog button:has-text("Cancella tutto")');
  await page.waitForSelector('.diary');
  assert.match(await page.textContent('.hero-line'), /^0\s*kcal$/);
  await page.goto(BASE + '#/impostazioni');
  await page.waitForSelector('.settings');
  await page.setInputFiles('.settings input[type=file]', backupPath);
  await page.click('dialog button:has-text("Sostituisci")');
  await page.waitForSelector('dialog.sheet[open] >> text=Sostituire tutti i dati?');
  await page.click('dialog button:has-text("Sostituisci")');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.startsWith('Importati'));
  await page.goto(BASE + '#/');
  await page.waitForSelector('.meal .row');
  assert.match(await page.textContent('.hero-line'), /^Oltre di 623\s*kcal$/);

  // Offline
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('.diary');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.meal .row', { timeout: 5000 });
  await ctx.setOffline(false);

  // Tema scuro (contesto nuovo = database vuoto: reimporta il backup)
  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const dp = await dark.newPage();
  dp.on('pageerror', (e) => problems.push(`pageerror(dark): ${e.message}`));
  await dp.goto(BASE + '#/impostazioni');
  await dp.waitForSelector('.settings');
  await dp.setInputFiles('.settings input[type=file]', backupPath);
  await dp.click('dialog button:has-text("Unisci")');
  await dp.waitForSelector('#toast.show');
  await dp.goto(BASE + '#/');
  await dp.waitForSelector('.meal .row');
  await dp.screenshot({ path: `${SHOTS}/08-tema-scuro.png`, fullPage: true });

  assert.deepEqual(problems, [], 'errori JavaScript o violazioni CSP');
  console.log('e2e: tutti i controlli superati');
} catch (e) {
  failed = true;
  console.error(e);
  if (problems.length) console.error('Problemi raccolti:', problems);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
