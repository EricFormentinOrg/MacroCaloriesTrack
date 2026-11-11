// Ridisegna la vista corrente dopo una modifica, senza dipendenze circolari col router.
let refresher: () => void = () => {};

export function setRefresher(fn: () => void): void {
  refresher = fn;
}

export function refresh(): void {
  refresher();
}
