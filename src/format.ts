import type { Entry } from './model.js';

const intFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

export const fmtInt = (n: number): string => intFmt.format(Math.round(n));
export const fmt1 = (n: number): string => oneFmt.format(n);

/** Grammi: un decimale sotto 10, interi sopra. */
export const fmtG = (n: number): string => (Math.abs(n) < 10 ? oneFmt.format(n) : intFmt.format(Math.round(n)));

export const round = (n: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Valore da mostrare in un campo di input: virgola decimale, niente separatore delle migliaia. */
export const toInput = (n: number): string => String(round(n, 2)).replace('.', ',');

/**
 * Accetta "12,5", "12.5", "1.240,5". Restituisce NaN se vuoto o non numerico.
 * Con la virgola presente, i punti sono separatori delle migliaia.
 */
export function parseDecimal(input: string): number {
  let s = input.trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

export function fmtQty(e: Pick<Entry, 'qty' | 'unit' | 'serving'>): string {
  if (e.serving) return `${fmt1(e.serving.count)} × ${e.serving.label} (${fmtG(e.qty)} ${e.unit})`;
  return `${fmtG(e.qty)} ${e.unit}`;
}
