// Chiamata POST JSON ai servizi della stima del pasto (Gemini, OpenRouter): tempo massimo,
// nessun cookie né referrer, errori di rete tradotti in messaggi per l'utente.
import { GeminiError } from './dishAi.js';

/**
 * Attesa massima per tentativo. Con il servizio sovraccarico Google ha tenuto aperta la richiesta
 * per minuti senza rispondere (26/11/2026): meglio passare presto al tentativo successivo.
 */
export const AI_TIMEOUT_MS = 50_000;

/** `service` è il nome mostrato nei messaggi ("Gemini", "OpenRouter"). Le chiavi vanno solo negli header. */
export async function postAi(url: string, headers: Record<string, string>, body: unknown, service: string): Promise<Response> {
  if (!navigator.onLine) throw new GeminiError('Sei offline: la stima richiede la connessione.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: ctl.signal,
    });
  } catch {
    // Su iPhone anche una richiesta rimasta appesa a lungo finisce qui, come errore di rete.
    throw new GeminiError(
      ctl.signal.aborted ? `${service} non ha risposto in tempo: riprova tra qualche minuto.` : `Connessione a ${service} non riuscita: controlla la rete e riprova.`,
      { tryOtherModel: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Corpo JSON di una risposta riuscita, o un errore leggibile. */
export async function readJson(res: Response, service: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new GeminiError(`Risposta di ${service} non valida.`);
  }
}
