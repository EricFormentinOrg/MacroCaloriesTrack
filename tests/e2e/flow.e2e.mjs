// Test end-to-end del flusso completo, in Chromium headless con viewport da iPhone.
// Requisiti (una tantum): npm i -D playwright && npx playwright install chromium
// Uso: npm run build && npm run e2e
// Fallisce su qualunque errore JavaScript o violazione CSP. Le schermate vanno in tests/e2e/screens/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    await page.click(`.results [data-src="mine"] .row:has-text("${food}")`);
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
  assert.equal(await page.locator('.results [data-src="mine"] .row').count(), 1);
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

  // ---- Fase 2: banca dati svizzera, Open Food Facts (simulato), preferiti.
  // Contesto nuovo senza service worker: page.route intercetta in modo affidabile e la CI non chiama mai OFF.
  const off = { calls: [] };
  const spaghetti = {
    code: '8000000000017', product_name_it: 'Spaghetti integrali', brands: 'Pastificio Esempio', product_quantity_unit: 'g', serving_quantity: 80,
    nutriments: { 'energy-kcal_100g': 350, fat_100g: 2.5, 'saturated-fat_100g': 0.5, carbohydrates_100g: 64, sugars_100g: 3, fiber_100g: 8, proteins_100g: 14, salt_100g: 0.01 },
  };
  const biscotti = { code: '8000000000031', product_name: 'Biscotti al cacao', brands: 'Forno Esempio', nutriments: { 'energy-kcal_100g': 480, fat_100g: 20 } };
  const passata = {
    code: '8000000000062', product_name_it: 'Passata di pomodoro', brands: 'Conserve Esempio', quantity: '700 g',
    nutriments: { 'energy-kcal_100g': 36, fat_100g: 0.2, carbohydrates_100g: 6, sugars_100g: 5, proteins_100g: 1.4, salt_100g: 0.4 },
  };
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await ctx2.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error('CSP-VIOLATION', e.violatedDirective, e.blockedURI)),
  );
  await ctx2.route('https://world.openfoodfacts.org/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-User-Agent' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    off.calls.push({ path: u.pathname, q: u.searchParams.get('search_terms'), ua: req.headers()['x-user-agent'] });
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: cors, body: JSON.stringify(body) });
    if (u.pathname === '/cgi/search.pl' && u.searchParams.get('search_terms') === 'spaghetti integrali') {
      return json({ count: 2, page: 1, page_size: 24, products: [spaghetti, biscotti] });
    }
    if (u.pathname === '/cgi/search.pl' && u.searchParams.get('search_terms') === 'nutella') {
      // Come il servizio reale: pagina HTML senza header CORS, che il browser blocca.
      return route.fulfill({ status: 503, contentType: 'text/html', body: '<!DOCTYPE html><title>Page temporarily unavailable</title>' });
    }
    if (u.pathname === '/api/v2/product/8000000000062.json') return json({ code: '8000000000062', status: 1, product: passata });
    problems.push(`richiesta OFF inattesa: ${req.url()}`);
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
  const p2 = await ctx2.newPage();
  p2.on('console', (m) => { if (m.type() === 'error' && !/status of 503|blocked by CORS policy|net::ERR_FAILED/.test(m.text())) problems.push(`(fase 2) ${m.text()}`); });
  p2.on('pageerror', (e) => problems.push(`pageerror(fase 2): ${e.message}`));
  const qty = async (value) => {
    await p2.waitForSelector('dialog.sheet[open]');
    await p2.fill('dialog .qty-input', value);
    await p2.click('dialog button:has-text("Aggiungi")');
    await p2.waitForSelector('dialog.sheet', { state: 'detached' });
  };

  // Banca dati: primo uso = copia tra gli alimenti personali
  await p2.goto(`${BASE}#/aggiungi/${today}/snack`);
  await p2.waitForSelector('.add');
  await p2.fill('.search', 'mela cruda');
  await p2.click('[data-src="ch"] .row:has-text("Mela, cruda")');
  await qty('150');
  await p2.waitForSelector('[data-src="mine"] .row:has-text("Mela, cruda")');
  assert.equal(await p2.locator('[data-src="ch"] .row:has-text("Mela, cruda")').count(), 0, 'la copia sostituisce la voce della banca dati');
  await p2.screenshot({ path: `${SHOTS}/09-banca-dati.png`, fullPage: true });

  // Preferito dalla banca dati
  await p2.fill('.search', 'kiwi');
  await p2.click('[data-src="ch"] li:has-text("Kiwi, crudo") .fav-toggle');
  await p2.waitForSelector('[data-src="mine"] li:has-text("Kiwi, crudo") .fav-toggle[aria-pressed="true"]');
  await p2.fill('.search', '');
  await p2.waitForSelector('[data-src="fav"] .row:has-text("Kiwi, crudo")');

  // Open Food Facts: ricerca testuale, prodotto completo e prodotto da controllare
  await p2.fill('.search', 'spaghetti integrali');
  await p2.click('.off-cta');
  await p2.waitForSelector('[data-src="off"] .row:has-text("Spaghetti integrali")');
  assert.match(await p2.textContent('[data-src="off"] li:has-text("Biscotti al cacao") .row-sub'), /da controllare/);
  assert.match(off.calls[0].ua ?? '', /^MacroCaloriesTrack\/[0-9a-f]{10} \(\+http:\/\/localhost:8181\/\)$/, 'X-User-Agent');
  await p2.screenshot({ path: `${SHOTS}/10-open-food-facts.png`, fullPage: true });
  await p2.click('[data-src="off"] .row:has-text("Spaghetti integrali")');
  await p2.waitForSelector('dialog .qty-unit option:has-text("porzione (80 g)")', { state: 'attached' });
  await qty('80');
  await p2.click('[data-src="off"] .row:has-text("Biscotti al cacao")');
  await p2.waitForSelector('.food-edit .review');
  assert.equal(await p2.inputValue('.food-edit .field input >> nth=0'), 'Biscotti al cacao');
  assert.equal(await p2.inputValue('.food-edit .field input >> nth=1'), 'Forno Esempio');
  await p2.screenshot({ path: `${SHOTS}/11-da-controllare.png`, fullPage: true });
  const r2 = p2.locator('.nrow input');
  await r2.nth(4).fill('65');
  await r2.nth(7).fill('7');
  await p2.click('button:has-text("Crea alimento")');
  await qty('30');

  // Codice a barre, poi la stessa richiesta servita dalla cache
  await p2.fill('.search', '8000000000062');
  assert.match(await p2.textContent('.off-cta'), /codice a barre/);
  await p2.click('.off-cta');
  await p2.waitForSelector('[data-src="off"] .row:has-text("Passata di pomodoro")');
  const callsBefore = off.calls.length;
  await p2.reload();
  await p2.waitForSelector('.add');
  await p2.fill('.search', '8000000000062');
  await p2.click('.off-cta');
  await p2.waitForSelector('[data-src="off"] .row:has-text("Passata di pomodoro")');
  assert.equal(off.calls.length, callsBefore, 'seconda richiesta servita dalla cache');

  // Servizio non disponibile (503): messaggio, nessun errore
  await p2.fill('.search', 'nutella');
  await p2.click('.off-cta');
  await p2.waitForSelector('[data-src="off"] .form-error');
  assert.match(await p2.textContent('[data-src="off"] .form-error'), /non accetta ricerche/);

  // Alimenti: preferiti e provenienza
  await p2.click('a[data-tab="alimenti"]');
  await p2.waitForSelector('.foods [data-src="fav"] .row:has-text("Kiwi, crudo")');
  await p2.click('.foods [data-src="fav"] li:has-text("Kiwi, crudo") .fav-toggle');
  await p2.waitForFunction(() => !document.querySelector('.foods [data-src="fav"]'));
  await p2.click('.foods .row:has-text("Mela, cruda")');
  await p2.waitForSelector('.food-edit .source-note');
  assert.match(await p2.textContent('.source-note'), /Banca dati svizzera.*ID 378/);

  // Diario: tre voci nello spuntino, valori copiati.
  // Mela 150 g (78 kcal) + spaghetti 80 g (280) + biscotti 30 g (144) = 502 kcal
  await p2.goto(BASE + '#/');
  await p2.waitForSelector('.diary');
  assert.equal(await p2.locator('.meal:has(h2:text("Spuntino")) .row').count(), 3);
  assert.match(await p2.textContent('.meal:has(h2:text("Spuntino")) .meal-kcal'), /^502\s*kcal$/);
  await ctx2.close();

  // ---- Fase 3, primo passo: collegamento a Dropbox con l'App key dell'utente (Dropbox simulato).
  const dbx = { calls: [], files: new Map(), challenge: '', revoked: false };
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await ctx3.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error('CSP-VIOLATION', e.violatedDirective, e.blockedURI)),
  );
  const dcors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Dropbox-API-Arg',
    'Access-Control-Expose-Headers': 'Dropbox-API-Result',
  };
  await ctx3.route(/^https:\/\/(dropbox\.com|api\.dropboxapi\.com|content\.dropboxapi\.com)\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: dcors });
    dbx.calls.push(`${u.host}${u.pathname}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: dcors, body: JSON.stringify(body) });
    if (u.host === 'dropbox.com' && u.pathname === '/oauth2/authorize') {
      dbx.challenge = u.searchParams.get('code_challenge');
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Codice: CODICE-DI-PROVA-123</p>' });
    }
    if (u.pathname === '/oauth2/token') {
      const p = new URLSearchParams(req.postData() ?? '');
      if (p.get('grant_type') !== 'authorization_code' || p.get('code') !== 'CODICE-DI-PROVA-123' || p.get('client_id') !== 'abc123def456ghi') {
        return json({ error: 'invalid_grant' }, 400);
      }
      const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== dbx.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
      return json({ access_token: 'sl.prova', token_type: 'bearer', expires_in: 14400, refresh_token: 'rt.prova', account_id: 'dbid:prova',
        scope: 'account_info.read files.content.read files.content.write files.metadata.read' });
    }
    if (req.headers()['authorization'] !== 'Bearer sl.prova') return json({ error_summary: 'invalid_access_token/' }, 401);
    const arg = JSON.parse(req.headers()['dropbox-api-arg'] ?? 'null');
    const meta = (path, size) => ({ name: path.slice(1), path_lower: path, rev: '0123456789abc', size, server_modified: '2026-11-12T08:00:00Z' });
    switch (u.pathname) {
      case '/2/files/list_folder':
        return json({ entries: [], cursor: 'c1', has_more: false });
      case '/2/files/upload': {
        const body = req.postDataBuffer() ?? Buffer.alloc(0);
        dbx.files.set(arg.path, body);
        return json(meta(arg.path, body.length));
      }
      case '/2/files/download': {
        const body = dbx.files.get(arg.path);
        if (!body) return json({ error_summary: 'path/not_found/.' }, 409);
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { ...dcors, 'Dropbox-API-Result': JSON.stringify(meta(arg.path, body.length)) }, body });
      }
      case '/2/files/delete_v2':
        dbx.files.delete(JSON.parse(req.postData()).path);
        return json({ metadata: {} });
      case '/2/auth/token/revoke':
        dbx.revoked = true;
        return route.fulfill({ status: 200, headers: dcors, body: '' });
    }
    problems.push(`richiesta Dropbox inattesa: ${req.url()}`);
    return json({ error_summary: 'other/' }, 400);
  });
  const p3 = await ctx3.newPage();
  p3.on('console', (m) => { if (m.type() === 'error') problems.push(`(dropbox) ${m.text()}`); });
  p3.on('pageerror', (e) => problems.push(`pageerror(dropbox): ${e.message}`));
  await p3.goto(BASE + '#/impostazioni');
  await p3.waitForSelector('.dropbox');
  await p3.fill('.dropbox input', 'ABC 123');
  await p3.click('.dropbox button:has-text("Continua")');
  assert.match(await p3.textContent('.dropbox .form-error'), /App key non sembra valida/);
  await p3.fill('.dropbox input', 'abc123def456ghi');
  await p3.click('.dropbox button:has-text("Continua")');
  const link = p3.locator('.dropbox a:has-text("Apri Dropbox")');
  await link.waitFor();
  const href = await link.getAttribute('href');
  const au = new URL(href);
  assert.equal(au.searchParams.get('client_id'), 'abc123def456ghi');
  assert.equal(au.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(au.searchParams.get('token_access_type'), 'offline');
  const [popup] = await Promise.all([ctx3.waitForEvent('page'), link.click()]);
  await popup.waitForLoadState();
  assert.match(await popup.textContent('body'), /CODICE-DI-PROVA-123/);
  await popup.close();
  // iOS può ricaricare la PWA mentre si è su Dropbox: il challenge deve restare lo stesso.
  await p3.reload();
  await p3.waitForSelector('.dropbox a:has-text("Apri Dropbox")');
  assert.equal(await p3.getAttribute('.dropbox a:has-text("Apri Dropbox")', 'href'), href);
  await p3.screenshot({ path: `${SHOTS}/12-dropbox-codice.png`, fullPage: true });
  await p3.fill('.dropbox .dbx-code input', '  CODICE-DI-PROVA-123 ');
  await p3.click('.dropbox button:has-text("Collega")');
  await p3.waitForSelector('.dropbox :text("Collegato")');
  await p3.click('.dropbox button:has-text("Prova la connessione")');
  await p3.waitForSelector('.dropbox [role=status]:has-text("Connessione riuscita")');
  assert.equal(dbx.files.size, 0, 'il file di prova viene cancellato');
  await p3.screenshot({ path: `${SHOTS}/13-dropbox-collegato.png`, fullPage: true });
  await p3.click('.dropbox button:has-text("Scollega Dropbox")');
  await p3.click('dialog button:has-text("Scollega")');
  await p3.waitForSelector('.dropbox button:has-text("Continua")');
  assert.equal(dbx.revoked, true, 'token revocato');
  assert.deepEqual(
    [...new Set(dbx.calls)].sort(),
    ['api.dropboxapi.com/2/auth/token/revoke', 'api.dropboxapi.com/2/files/delete_v2', 'api.dropboxapi.com/2/files/list_folder',
      'api.dropboxapi.com/oauth2/token', 'content.dropboxapi.com/2/files/download', 'content.dropboxapi.com/2/files/upload', 'dropbox.com/oauth2/authorize'],
  );
  await ctx3.close();

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
