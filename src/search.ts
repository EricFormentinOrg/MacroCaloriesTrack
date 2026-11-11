// Ricerca testuale senza accenti, condivisa da alimenti personali, banca dati e risultati remoti.

/** Minuscole e senza accenti: "caffè" trova "caffe" e viceversa. */
export function norm(s: string): string {
  return s.toLocaleLowerCase('it').normalize('NFD').replace(/\p{M}/gu, '');
}

export function tokens(query: string): string[] {
  return norm(query).split(/[\s,;]+/).filter(Boolean);
}

/** Tutti i token devono comparire nel testo (già normalizzato). */
export function matchesAll(hay: string, toks: ReadonlyArray<string>): boolean {
  return toks.every((t) => hay.includes(t));
}

/**
 * Punteggio per ordinare i risultati: prima il nome che inizia con la ricerca,
 * poi la parola iniziale, poi i nomi più corti (più generici).
 */
export function rank(name: string, toks: ReadonlyArray<string>): number {
  const n = norm(name);
  const first = toks[0] ?? '';
  let score = 0;
  if (n.startsWith(toks.join(' '))) score += 1000;
  else if (n.startsWith(first)) score += 500;
  else if (new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) score += 200;
  return score - Math.min(n.length, 199);
}
