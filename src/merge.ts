import type { SyncRecord } from './model.js';

/** JSON con chiavi ordinate: confronto deterministico indipendente dall'ordine delle proprietà. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * Last-write-wins su updatedAt. A parità, vince il contenuto maggiore in
 * ordine lessicografico: due dispositivi arrivano allo stesso risultato.
 */
export function pickNewer<T extends SyncRecord>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

/** Restituisce i record in arrivo che devono sovrascrivere o aggiungersi a quelli locali. */
export function mergeById<T extends SyncRecord>(local: ReadonlyArray<T>, incoming: ReadonlyArray<T>): T[] {
  const byId = new Map(local.map((r) => [r.id, r]));
  const toWrite: T[] = [];
  for (const r of incoming) {
    const cur = byId.get(r.id);
    if (!cur || pickNewer(cur, r) === r) {
      toWrite.push(r);
      byId.set(r.id, r);
    }
  }
  return toWrite;
}
