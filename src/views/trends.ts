// Andamento: peso e tendenza, calorie per giorno rispetto all'obiettivo, medie settimanali.
import { addDays, parseISODate, todayISO } from '../dates.js';
import { fmt1, fmtInt } from '../format.js';
import type { Nutrients, Profile, Weight } from '../model.js';
import { refresh } from '../nav.js';
import { computePlan } from '../nutrition.js';
import * as repo from '../repo.js';
import { dailyTotals, niceScale, rangeDates, sortedWeights, weeklySummary, weightAt, weightTrend } from '../stats.js';
import type { Point } from '../stats.js';
import { h, segmented, svg } from '../ui.js';
import { openWeightSheet } from './sheets.js';

type Range = '14' | '30' | '90';
let range: Range = '30';

const shortDate = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });
const fmtShort = (d: string): string => shortDate.format(parseISODate(d));
const signed = (n: number, digits = 1): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${digits ? fmt1(Math.abs(n)) : fmtInt(Math.abs(n))}`;

// Geometria comune dei grafici (unità del viewBox).
const W = 340;
const H = 170;
const PAD = { l: 38, r: 8, t: 10, b: 22 };

export async function trendsView(): Promise<HTMLElement> {
  const today = todayISO();
  const from = addDays(today, -(Number(range) - 1));
  const [weights, entries, profile] = await Promise.all([repo.listWeights(), repo.entriesBetween(from, today), repo.getProfile()]);
  const sorted = sortedWeights(weights);
  const totals = dailyTotals(entries);
  const days = rangeDates(from, today);
  const current = weightAt(sorted, today);
  const target = profile && current ? computePlan(profile, current.kg, today).targets.kcal : undefined;

  return h('div', { class: 'view trends' },
    h('header', { class: 'view-head' }, h('h1', null, 'Andamento')),
    segmented('Periodo', [{ value: '14', label: '2 settimane' }, { value: '30', label: '1 mese' }, { value: '90', label: '3 mesi' }], range, (v) => {
      range = v;
      refresh();
    }, true),
    weightSection(sorted, from, today, profile),
    caloriesSection(days, totals, target, profile, sorted),
    weeksSection(from, today, totals, sorted),
  );
}

// ---- Peso

function weightSection(sorted: Weight[], from: string, today: string, profile: Profile | undefined): HTMLElement {
  const own = sorted.find((w) => w.date === today);
  const log = h('button', {
    type: 'button',
    class: 'btn btn-secondary',
    onClick: async () => {
      if (await openWeightSheet(today)) refresh();
    },
  }, own ? 'Modifica il peso di oggi' : 'Registra il peso di oggi');

  if (!sorted.length) {
    return h('section', { class: 'section trend-block' },
      h('h2', null, 'Peso'),
      h('p', null, 'Nessuna pesata ancora. Registra il peso per seguire l’andamento e tenere aggiornato l’obiettivo.'),
      log,
    );
  }
  const inRange = sorted.filter((w) => w.date >= from && w.date <= today);
  const trend = weightTrend(sorted).filter((p) => p.date >= from && p.date <= today);
  const last = sorted[sorted.length - 1];
  const parts: Node[] = [];
  // Su meno di una settimana la variazione è soprattutto acqua e sale: niente numero, solo l'indicazione.
  const spanDays = trend.length >= 2 ? Math.round((parseISODate(trend[trend.length - 1].date).getTime() - parseISODate(trend[0].date).getTime()) / 86_400_000) : 0;
  if (spanDays >= 7) {
    const delta = trend[trend.length - 1].kg - trend[0].kg;
    parts.push(h('p', { class: 'trend-sub' }, `${signed(delta)} kg in ${days(trend[0].date, trend[trend.length - 1].date)} (media mobile a 7 giorni)`));
  } else if (trend.length >= 1) {
    parts.push(h('p', { class: 'trend-sub' }, 'Con pesate su almeno una settimana qui compare la variazione, calcolata sulla media mobile.'));
  }
  if (profile?.targetKg !== undefined) {
    const gap = last.kg - profile.targetKg;
    parts.push(h('p', { class: 'trend-sub' }, Math.abs(gap) < 0.05
      ? `Obiettivo di ${fmt1(profile.targetKg)} kg raggiunto.`
      : `Obiettivo ${fmt1(profile.targetKg)} kg: ${gap > 0 ? 'mancano' : 'sopra di'} ${fmt1(Math.abs(gap))} kg.`));
  }
  return h('section', { class: 'section trend-block' },
    h('h2', null, 'Peso'),
    h('p', { class: 'trend-big' }, h('span', { class: 'num' }, fmt1(last.kg)), ' kg', h('span', { class: 'trend-when' }, last.date === today ? ' oggi' : ` il ${fmtShort(last.date)}`)),
    ...parts,
    inRange.length >= 2
      ? weightChart(inRange.map((w) => ({ date: w.date, kg: w.kg })), trend, from, today, profile?.targetKg)
      : h('p', { class: 'muted' }, 'Servono almeno due pesate nel periodo per disegnare il grafico.'),
    log,
    recentWeights(sorted),
  );
}

const days = (a: string, b: string): string => {
  const n = Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86_400_000);
  return n === 1 ? '1 giorno' : `${n} giorni`;
};

function xOf(date: string, from: string, to: string): number {
  const span = Math.max(1, parseISODate(to).getTime() - parseISODate(from).getTime());
  return PAD.l + ((parseISODate(date).getTime() - parseISODate(from).getTime()) / span) * (W - PAD.l - PAD.r);
}

function axes(minY: number, maxY: number, step: number, fmt: (v: number) => string, from: string, to: string): SVGElement[] {
  const yOf = (v: number) => PAD.t + (1 - (v - minY) / (maxY - minY)) * (H - PAD.t - PAD.b);
  const out: SVGElement[] = [];
  for (let v = minY; v <= maxY + step / 2; v += step) {
    const y = yOf(v);
    out.push(svg('line', { class: 'ch-grid', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }));
    out.push(svg('text', { class: 'ch-label', x: PAD.l - 6, y: y + 4, 'text-anchor': 'end' }, fmt(v)));
  }
  out.push(svg('text', { class: 'ch-label', x: PAD.l, y: H - 4, 'text-anchor': 'start' }, fmtShort(from)));
  out.push(svg('text', { class: 'ch-label', x: W - PAD.r, y: H - 4, 'text-anchor': 'end' }, fmtShort(to)));
  return out;
}

function weightChart(points: Point[], trend: Point[], from: string, to: string, targetKg?: number): SVGSVGElement {
  const values = [...points.map((p) => p.kg), ...trend.map((p) => p.kg), ...(targetKg !== undefined ? [targetKg] : [])];
  const s = niceScale(Math.min(...values), Math.max(...values), 4);
  const yOf = (v: number) => PAD.t + (1 - (v - s.min) / (s.max - s.min)) * (H - PAD.t - PAD.b);
  const line = trend.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.date, from, to).toFixed(1)} ${yOf(p.kg).toFixed(1)}`).join(' ');
  return svg('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Peso da ${fmt1(points[0].kg)} a ${fmt1(points[points.length - 1].kg)} kg tra ${fmtShort(points[0].date)} e ${fmtShort(points[points.length - 1].date)}`,
  },
    ...axes(s.min, s.max, s.step, (v) => fmtInt(v), from, to),
    targetKg !== undefined ? svg('line', { class: 'ch-target', x1: PAD.l, x2: W - PAD.r, y1: yOf(targetKg), y2: yOf(targetKg) }) : null,
    trend.length >= 2 ? svg('path', { class: 'ch-trend', d: line }) : null,
    ...points.map((p) => svg('circle', { class: 'ch-point', cx: xOf(p.date, from, to).toFixed(1), cy: yOf(p.kg).toFixed(1), r: 2.6 })),
  );
}

function recentWeights(sorted: Weight[]): HTMLElement {
  const last = [...sorted].reverse().slice(0, 5);
  return h('details', { class: 'extra' },
    h('summary', null, 'Ultime pesate'),
    h('ul', { class: 'list' },
      ...last.map((w) => h('li', null,
        h('button', {
          type: 'button',
          class: 'row',
          onClick: async () => {
            if (await openWeightSheet(w.date)) refresh();
          },
        },
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, fmtShort(w.date))),
          h('span', { class: 'row-side' }, h('span', { class: 'row-kcal' }, `${fmt1(w.kg)} kg`)),
        ),
      )),
    ),
  );
}

// ---- Calorie

function caloriesSection(dayList: string[], totals: Map<string, Nutrients>, target: number | undefined, profile: Profile | undefined, sorted: Weight[]): HTMLElement {
  const logged = dayList.filter((d) => (totals.get(d)?.kcal ?? 0) > 0);
  if (!logged.length) {
    return h('section', { class: 'section trend-block' },
      h('h2', null, 'Calorie'),
      h('p', null, 'Nessun giorno registrato nel periodo.'),
    );
  }
  const avg = (k: keyof Nutrients) => logged.reduce((a, d) => a + (totals.get(d)?.[k] ?? 0), 0) / logged.length;
  const avgKcal = avg('kcal');
  return h('section', { class: 'section trend-block' },
    h('h2', null, 'Calorie'),
    h('p', { class: 'trend-big' }, h('span', { class: 'num' }, fmtInt(avgKcal)), ' kcal', h('span', { class: 'trend-when' }, ' al giorno in media')),
    h('p', { class: 'trend-sub' }, `${logged.length === 1 ? '1 giorno registrato' : `${logged.length} giorni registrati`} su ${dayList.length}${target ? `; obiettivo attuale ${fmtInt(target)} kcal (${signed(avgKcal - target, 0)})` : ''}.`),
    h('p', { class: 'trend-macros' },
      h('span', { class: 'mini-p' }, h('b', null, 'P'), ` ${fmtInt(avg('protein'))} g`),
      h('span', { class: 'mini-c' }, h('b', null, 'C'), ` ${fmtInt(avg('carbs'))} g`),
      h('span', { class: 'mini-f' }, h('b', null, 'G'), ` ${fmtInt(avg('fat'))} g`),
      h('span', { class: 'muted' }, ' medi al giorno'),
    ),
    kcalChart(dayList, totals, profile, sorted),
  );
}

/** Barre per giorno (fino a un mese) o per settimana (tre mesi), con l'obiettivo di ciascun giorno. */
function kcalChart(dayList: string[], totals: Map<string, Nutrients>, profile: Profile | undefined, sorted: Weight[]): SVGSVGElement {
  const from = dayList[0];
  const to = dayList[dayList.length - 1];
  const targetOf = (d: string) => {
    const w = weightAt(sorted, d);
    return profile && w ? computePlan(profile, w.kg, d).targets.kcal : undefined;
  };
  const weekly = dayList.length > 31;
  const groups: Array<{ start: string; dates: string[] }> = [];
  if (weekly) for (let i = 0; i < dayList.length; i += 7) groups.push({ start: dayList[i], dates: dayList.slice(i, i + 7) });
  else for (const d of dayList) groups.push({ start: d, dates: [d] });
  const bars = groups.map((g) => {
    const logged = g.dates.filter((d) => (totals.get(d)?.kcal ?? 0) > 0);
    const kcal = logged.length ? logged.reduce((a, d) => a + (totals.get(d)?.kcal ?? 0), 0) / logged.length : 0;
    const targets = g.dates.map(targetOf).filter((t): t is number => t !== undefined);
    const target = targets.length ? targets.reduce((a, t) => a + t, 0) / targets.length : undefined;
    return { start: g.start, kcal, target };
  });
  const maxV = Math.max(...bars.map((b) => Math.max(b.kcal, b.target ?? 0)), 1);
  const s = niceScale(0, maxV, 4);
  const yOf = (v: number) => PAD.t + (1 - v / s.max) * (H - PAD.t - PAD.b);
  const slot = (W - PAD.l - PAD.r) / bars.length;
  const bw = Math.max(1.5, slot * 0.68);
  const targetPath = bars
    .map((b, i) => (b.target === undefined ? '' : `${i && bars[i - 1].target !== undefined ? 'L' : 'M'}${(PAD.l + i * slot).toFixed(1)} ${yOf(b.target).toFixed(1)} L${(PAD.l + (i + 1) * slot).toFixed(1)} ${yOf(b.target).toFixed(1)}`))
    .join(' ');
  return svg('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Calorie ${weekly ? 'medie per settimana' : 'per giorno'} dal ${fmtShort(from)} al ${fmtShort(to)}`,
  },
    ...axes(0, s.max, s.step, (v) => fmtInt(v), from, to),
    ...bars.map((b, i) => (b.kcal > 0
      ? svg('rect', {
        class: `ch-bar${b.target !== undefined && b.kcal > b.target * 1.05 ? ' over' : ''}`,
        x: (PAD.l + i * slot + (slot - bw) / 2).toFixed(1),
        y: yOf(b.kcal).toFixed(1),
        width: bw.toFixed(1),
        height: Math.max(0.5, H - PAD.b - yOf(b.kcal)).toFixed(1),
        rx: Math.min(2, bw / 3).toFixed(1),
      })
      : null)),
    targetPath ? svg('path', { class: 'ch-target', d: targetPath }) : null,
  );
}

// ---- Settimane

function weeksSection(from: string, to: string, totals: Map<string, Nutrients>, sorted: Weight[]): HTMLElement {
  const weeks = weeklySummary(from, to, totals, sorted).filter((w) => w.logged || w.weightChange !== undefined);
  if (!weeks.length) return h('div');
  return h('section', { class: 'section trend-block' },
    h('h2', null, 'Settimane'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'weeks-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Dal'),
          h('th', { scope: 'col', class: 'n' }, 'Giorni'),
          h('th', { scope: 'col', class: 'n' }, 'kcal'),
          h('th', { scope: 'col', class: 'n mini-p' }, h('b', null, 'P')),
          h('th', { scope: 'col', class: 'n mini-c' }, h('b', null, 'C')),
          h('th', { scope: 'col', class: 'n mini-f' }, h('b', null, 'G')),
          h('th', { scope: 'col', class: 'n' }, 'Peso'),
        )),
        h('tbody', null, ...weeks.map((w) => h('tr', null,
          h('th', { scope: 'row' }, fmtShort(w.start)),
          h('td', { class: 'n' }, `${w.logged}/7`),
          h('td', { class: 'n' }, w.avg ? fmtInt(w.avg.kcal) : '–'),
          h('td', { class: 'n' }, w.avg ? fmtInt(w.avg.protein) : '–'),
          h('td', { class: 'n' }, w.avg ? fmtInt(w.avg.carbs) : '–'),
          h('td', { class: 'n' }, w.avg ? fmtInt(w.avg.fat) : '–'),
          h('td', { class: 'n' }, w.weightChange !== undefined ? `${signed(w.weightChange)}` : '–'),
        ))),
      ),
    ),
    h('p', { class: 'muted' }, 'Medie sui soli giorni registrati; macronutrienti in grammi; variazione del peso sulla media mobile.'),
  );
}
