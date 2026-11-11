import { buildBackup, countAlive, diaryCSV, parseBackup } from '../backup.js';
import type { BackupData } from '../backup.js';
import { todayISO } from '../dates.js';
import { fmtInt } from '../format.js';
import { refresh } from '../nav.js';
import * as repo from '../repo.js';
import { clearOffCache, loadCatalog } from '../sources.js';
import { confirmSheet, h, openSheet, toast } from '../ui.js';
import { VERSION } from '../version.js';

const isAppleMobile = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

/** Su iPhone il foglio di condivisione permette di salvare in File o Dropbox; altrove, download classico. */
async function saveFile(name: string, mime: string, content: string): Promise<void> {
  const file = new File([content], name, { type: mime });
  if (isAppleMobile() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const plural = (n: number, one: string, many: string): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

function describe(data: BackupData): string {
  const c = countAlive(data);
  const parts = [plural(c.foods, 'alimento', 'alimenti'), plural(c.entries, 'voce di diario', 'voci di diario'), plural(c.weights, 'pesata', 'pesate')];
  if (c.profile) parts.push('il profilo');
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

async function storageStatus(): Promise<string> {
  const s = navigator.storage;
  if (!s?.persisted) return 'Questo browser non indica se i dati sono protetti dalla pulizia automatica.';
  const persisted = await s.persisted();
  const est = s.estimate ? await s.estimate() : undefined;
  const used = est?.usage !== undefined ? ` Spazio usato: ${fmtInt(est.usage / 1024)} kB.` : '';
  return (persisted
    ? 'Archiviazione persistente attiva: il browser non cancella i dati per liberare spazio.'
    : 'Archiviazione non persistente: il browser può cancellare i dati se lo spazio scarseggia o dopo lunga inattività.') + used;
}

const extLink = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

async function sourcesSection(): Promise<HTMLElement> {
  const cat = await loadCatalog().catch(() => undefined);
  const released = cat ? new Date(`${cat.released}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return h('section', { class: 'section' },
    h('h2', null, 'Fonti dei dati'),
    h('p', null,
      'Alimenti generici: ',
      extLink('https://naehrwertdaten.ch', 'Banca dati svizzera dei valori nutritivi'),
      cat ? `, versione ${cat.version} del ${released}, ${fmtInt(cat.items.length)} alimenti. ` : '. ',
      'Fonte: Ufficio federale della sicurezza alimentare e di veterinaria (USAV).',
    ),
    h('p', null,
      'Prodotti confezionati: ',
      extLink('https://world.openfoodfacts.org', 'Open Food Facts'),
      ', banca dati aperta sotto licenza ',
      extLink('https://opendatacommons.org/licenses/odbl/1-0/', 'ODbL'),
      '. I valori sono inseriti da volontari: controllali con l’etichetta. Le ricerche inviano il testo cercato a Open Food Facts.',
    ),
    h('p', { class: 'muted' }, 'Al primo uso ogni alimento viene copiato tra i tuoi: le voci del diario non cambiano se la fonte si aggiorna.'),
    h('button', {
      type: 'button',
      class: 'btn btn-quiet',
      onClick: async () => {
        await clearOffCache();
        toast('Cache di Open Food Facts svuotata');
      },
    }, 'Svuota la cache di Open Food Facts'),
  );
}

export async function settingsView(): Promise<HTMLElement> {
  const [statusText, sources] = await Promise.all([storageStatus(), sourcesSection()]);
  const status = h('p', { class: 'muted' }, statusText);

  async function exportJSON(): Promise<void> {
    const data = await repo.exportAll();
    await saveFile(`macro-backup-${todayISO()}.json`, 'application/json', JSON.stringify(buildBackup(data)));
  }

  async function exportCSV(): Promise<void> {
    const data = await repo.exportAll();
    await saveFile(`macro-diario-${todayISO()}.csv`, 'text/csv', diaryCSV(data.entries));
  }

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
    onChange: async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      if (f.size > 50 * 1024 * 1024) {
        toast('File troppo grande per essere un backup.');
        return;
      }
      await importFlow(await f.text());
    },
  });

  async function importFlow(text: string): Promise<void> {
    const r = parseBackup(text);
    if (!r.ok) {
      await openSheet('Import non riuscito', (close) =>
        h('div', null,
          h('h2', { class: 'sheet-title' }, 'Import non riuscito'),
          h('p', null, r.error),
          h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onClick: () => close() }, 'Chiudi')),
        ),
      );
      return;
    }
    const when = r.exportedAt ? new Date(r.exportedAt) : undefined;
    const mode = await openSheet<'merge' | 'replace'>('Importa backup', (close) =>
      h('div', null,
        h('h2', { class: 'sheet-title' }, 'Importa backup'),
        h('p', null, `Il file contiene ${describe(r.data)}.`),
        when && !Number.isNaN(when.getTime())
          ? h('p', { class: 'muted' }, `Esportato il ${when.toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' })}.`)
          : null,
        h('p', { class: 'muted' }, 'Unisci tiene la versione più recente di ogni record. Sostituisci cancella i dati attuali di questo dispositivo.'),
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn btn-danger-text', onClick: () => close('replace') }, 'Sostituisci'),
          h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close() }, 'Annulla'),
          h('button', { type: 'button', class: 'btn btn-primary', onClick: () => close('merge') }, 'Unisci'),
        ),
      ),
    );
    if (!mode) return;
    if (mode === 'replace') {
      const ok = await confirmSheet({
        title: 'Sostituire tutti i dati?',
        message: 'Alimenti, diario, pesate e profilo di questo dispositivo vengono sostituiti dal contenuto del file.',
        confirm: 'Sostituisci',
        danger: true,
      });
      if (!ok) return;
    }
    const n = await repo.importData(r.data, mode);
    toast(n === 0 ? 'Nessuna modifica: i dati erano già aggiornati.' : `Importati ${fmtInt(n)} record.`);
    refresh();
  }

  async function askPersist(): Promise<void> {
    const granted = (await navigator.storage?.persist?.()) ?? false;
    status.textContent = await storageStatus();
    if (!granted) toast('Il browser non ha concesso l’archiviazione persistente.');
  }

  async function wipe(): Promise<void> {
    const ok = await confirmSheet({
      title: 'Cancellare tutti i dati?',
      message: 'Alimenti, diario, pesate, profilo e cache di Open Food Facts vengono eliminati da questo dispositivo. Esporta prima un backup se ti servono.',
      confirm: 'Cancella tutto',
      danger: true,
    });
    if (!ok) return;
    await repo.wipeAll();
    toast('Dati cancellati');
    location.hash = '#/';
  }

  return h('div', { class: 'view settings' },
    h('header', { class: 'view-head' }, h('h1', null, 'Impostazioni')),

    h('section', { class: 'section' },
      h('h2', null, 'Backup'),
      h('p', null, 'Il backup JSON contiene tutti i dati in chiaro e serve per passare a un altro dispositivo. Conservalo in un posto sicuro.'),
      h('div', { class: 'stack' },
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: exportJSON }, 'Esporta backup'),
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => fileInput.click() }, 'Importa backup'),
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: exportCSV }, 'Esporta il diario in CSV'),
        fileInput,
      ),
    ),

    h('section', { class: 'section' },
      h('h2', null, 'Archiviazione'),
      status,
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: askPersist }, 'Richiedi archiviazione persistente'),
    ),

    sources,

    h('section', { class: 'section' },
      h('h2', null, 'Dati su questo dispositivo'),
      h('button', { type: 'button', class: 'btn btn-danger-outline', onClick: wipe }, 'Cancella tutti i dati'),
    ),

    h('p', { class: 'version' }, `Versione ${VERSION}`),
  );
}
