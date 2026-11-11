// Date locali in formato AAAA-MM-GG. Mai toISOString(): converte in UTC e
// sposta il giorno per chi registra dopo mezzanotte o prima delle 2.

const pad = (n: number): string => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isISODate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return toISODate(parseISODate(v)) === v;
}

export function addDays(s: string, n: number): string {
  const d = parseISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

const fmtLong = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtLongYear = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function longDate(s: string): string {
  const d = parseISODate(s);
  return cap((d.getFullYear() === new Date().getFullYear() ? fmtLong : fmtLongYear).format(d));
}

export function plainDate(s: string): string {
  return fmtDay.format(parseISODate(s));
}

export function dayTitle(s: string): string {
  const t = todayISO();
  if (s === t) return 'Oggi';
  if (s === addDays(t, -1)) return 'Ieri';
  if (s === addDays(t, 1)) return 'Domani';
  return longDate(s);
}

export function ageOn(birth: string, on: string): number {
  const b = parseISODate(birth);
  const o = parseISODate(on);
  let age = o.getFullYear() - b.getFullYear();
  if (o.getMonth() < b.getMonth() || (o.getMonth() === b.getMonth() && o.getDate() < b.getDate())) age--;
  return age;
}
