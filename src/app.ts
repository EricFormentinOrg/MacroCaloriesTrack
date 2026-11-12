import { openDb } from './db.js';
import { ensureMeta } from './repo.js';
import { startRouter } from './router.js';
import { startAutoSync } from './syncService.js';
import { h, toast } from './ui.js';

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Nuova versione installata', { label: 'Ricarica', run: () => location.reload() });
  });
  navigator.serviceWorker.register('./sw.js').catch((err: unknown) => console.warn('Service worker non registrato', err));
}

async function main(): Promise<void> {
  const root = document.getElementById('main');
  if (!root) return;
  try {
    await openDb();
    await ensureMeta();
  } catch (e) {
    root.replaceChildren(h('div', { class: 'view' }, h('p', { class: 'form-error' },
      `Il database locale non si apre: ${e instanceof Error ? e.message : String(e)}. In navigazione privata alcuni browser lo disattivano.`)));
    return;
  }
  startRouter(root);
  registerServiceWorker();
  startAutoSync();
  // Senza persistenza il browser può svuotare IndexedDB sotto pressione di spazio.
  navigator.storage?.persist?.().catch(() => {});
}

void main();
