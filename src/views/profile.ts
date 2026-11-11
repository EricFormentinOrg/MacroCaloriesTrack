import { ageOn, isISODate, plainDate, todayISO } from '../dates.js';
import { fmt1, fmtInt, parseDecimal, toInput } from '../format.js';
import { ACTIVITY_LEVELS, RATES } from '../model.js';
import type { Goal, Profile, Sex, Targets } from '../model.js';
import { computePlan } from '../nutrition.js';
import * as repo from '../repo.js';
import { decimalInput, field, h, segmented, toast } from '../ui.js';

const DEFAULT_PROTEIN_PER_KG = 1.8;
const DEFAULT_FAT_PCT = 25;

type Draft = Omit<Profile, 'id' | 'updatedAt' | 'deleted'>;

export async function profileView(): Promise<HTMLElement> {
  const today = todayISO();
  const [p, w] = await Promise.all([repo.getProfile(), repo.weightOn(today)]);

  let sex: Sex | undefined = p?.sex;
  let goal: Goal = p?.goal ?? 'maintain';

  const birth = h('input', { type: 'date', value: p?.birthDate ?? '', max: today, onChange: update });
  const height = decimalInput({ value: p ? toInput(p.heightCm) : '', onInput: update });
  const weight = decimalInput({ value: w ? toInput(w.kg) : '', onInput: update });
  const activity = h('select', { value: String(p?.activity ?? 1.375), onChange: update },
    ...ACTIVITY_LEVELS.map((a) => h('option', { value: String(a.value) }, a.label)),
  );
  const rate = h('select', { value: String(p?.rateKgWeek ?? 0.5), onChange: update },
    ...RATES.map((r) => h('option', { value: String(r) }, `${fmt1(r)} kg`)),
  );
  const targetKg = decimalInput({ value: p?.targetKg !== undefined ? toInput(p.targetKg) : '', onInput: update });
  const proteinPerKg = decimalInput({ value: toInput(p?.proteinPerKg ?? DEFAULT_PROTEIN_PER_KG), onInput: update });
  const fatPct = decimalInput({ value: toInput(p?.fatPct ?? DEFAULT_FAT_PCT), onInput: update });

  const manual = h('input', { type: 'checkbox', checked: p?.manual ?? false, onChange: onManualToggle });
  const mt = {
    kcal: decimalInput({ value: p?.manualTargets ? toInput(p.manualTargets.kcal) : '', onInput: update }),
    protein: decimalInput({ value: p?.manualTargets ? toInput(p.manualTargets.protein) : '', onInput: update }),
    carbs: decimalInput({ value: p?.manualTargets ? toInput(p.manualTargets.carbs) : '', onInput: update }),
    fat: decimalInput({ value: p?.manualTargets ? toInput(p.manualTargets.fat) : '', onInput: update }),
  };

  const rateField = field('Ritmo settimanale', rate);
  const targetField = field('Peso obiettivo (kg)', targetKg, 'Facoltativo');
  const autoBox = h('div', { class: 'form-grid' }, field('Proteine per kg di peso', proteinPerKg, 'g/kg'), field('Grassi', fatPct, '% delle calorie'));
  const manualBox = h('div', { class: 'form-grid' },
    field('Calorie', mt.kcal, 'kcal'),
    field('Proteine', mt.protein, 'g'),
    field('Carboidrati', mt.carbs, 'g'),
    field('Grassi', mt.fat, 'g'),
  );
  const planBox = h('div', { class: 'plan', 'aria-live': 'polite' });
  const errorBox = h('div', { class: 'errors', role: 'alert' });

  function num(inp: HTMLInputElement): number {
    return parseDecimal(inp.value);
  }

  function read(): { draft?: Draft; kg?: number; errors: string[] } {
    const errors: string[] = [];
    if (!sex) errors.push('Indica il sesso: cambia la formula del metabolismo.');
    if (!isISODate(birth.value)) errors.push('Inserisci la data di nascita.');
    else {
      const age = ageOn(birth.value, today);
      if (age < 10 || age > 110) errors.push('Controlla la data di nascita.');
    }
    const cm = num(height);
    if (!(cm >= 100 && cm <= 250)) errors.push('Altezza tra 100 e 250 cm.');
    const kg = num(weight);
    if (!(kg >= 30 && kg <= 300)) errors.push('Peso tra 30 e 300 kg.');
    const tkgRaw = targetKg.value.trim();
    const tkg = tkgRaw ? num(targetKg) : undefined;
    if (tkg !== undefined && !(tkg >= 30 && tkg <= 300)) errors.push('Peso obiettivo tra 30 e 300 kg.');
    const ppk = num(proteinPerKg);
    if (!(ppk >= 0.5 && ppk <= 4)) errors.push('Proteine tra 0,5 e 4 g per kg.');
    const fp = num(fatPct);
    if (!(fp >= 10 && fp <= 70)) errors.push('Grassi tra 10% e 70% delle calorie.');

    let manualTargets: Targets | undefined;
    if (manual.checked) {
      const t = { kcal: num(mt.kcal), protein: num(mt.protein), carbs: num(mt.carbs), fat: num(mt.fat) };
      if (!(t.kcal >= 500 && t.kcal <= 10000)) errors.push('Calorie manuali tra 500 e 10.000.');
      if (![t.protein, t.carbs, t.fat].every((g) => g >= 0 && g <= 1500)) errors.push('Macro manuali tra 0 e 1.500 g.');
      manualTargets = t;
    }
    if (errors.length || !sex) return { errors };
    return {
      errors,
      kg,
      draft: {
        sex,
        birthDate: birth.value,
        heightCm: cm,
        activity: Number(activity.value),
        goal,
        rateKgWeek: goal === 'maintain' ? 0 : Number(rate.value),
        targetKg: tkg,
        proteinPerKg: ppk,
        fatPct: fp,
        manual: manual.checked,
        manualTargets,
      },
    };
  }

  function onManualToggle(): void {
    // Prima attivazione: parti dai valori calcolati invece che da campi vuoti.
    if (manual.checked && !mt.kcal.value) {
      const { draft, kg } = read();
      if (draft && kg) {
        const c = computePlan({ ...draft, manual: false, id: 'profile', updatedAt: 0 }, kg, today).computed;
        mt.kcal.value = toInput(c.kcal);
        mt.protein.value = toInput(c.protein);
        mt.carbs.value = toInput(Math.max(0, c.carbs));
        mt.fat.value = toInput(c.fat);
      }
    }
    update();
  }

  function update(): void {
    rateField.hidden = goal === 'maintain';
    targetField.hidden = goal === 'maintain';
    autoBox.hidden = manual.checked;
    manualBox.hidden = !manual.checked;
    errorBox.replaceChildren();
    const { draft, kg } = read();
    if (!draft || !kg) {
      planBox.replaceChildren(h('p', { class: 'muted' }, 'Compila i dati per vedere il calcolo.'));
      return;
    }
    const plan = computePlan({ ...draft, id: 'profile', updatedAt: 0 }, kg, today);
    const t = plan.targets;
    planBox.replaceChildren(
      h('p', { class: 'plan-target' }, h('span', { class: 'num' }, fmtInt(t.kcal)), ' kcal al giorno'),
      h('p', { class: 'plan-macros' }, `Proteine ${fmtInt(t.protein)} g, carboidrati ${fmtInt(t.carbs)} g, grassi ${fmtInt(t.fat)} g`),
      h('dl', null,
        h('dt', null, 'Metabolismo basale'), h('dd', null, `${fmtInt(plan.bmr)} kcal`),
        h('dt', null, 'Fabbisogno stimato'), h('dd', null, `${fmtInt(plan.tdee)} kcal`),
        plan.weeksToTarget !== undefined ? [h('dt', null, 'Peso obiettivo'), h('dd', null, `circa ${plan.weeksToTarget} settimane`)] : null,
      ),
      ...plan.warnings.map((m) => h('p', { class: 'warn' }, m)),
      h('p', { class: 'plan-note' }, 'Stima con la formula di Mifflin-St Jeor. Il fabbisogno reale si verifica sull’andamento del peso nelle settimane successive.'),
    );
  }

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    const { draft, kg, errors } = read();
    if (!draft || !kg) {
      errorBox.replaceChildren(...errors.map((m) => h('p', null, m)));
      errorBox.scrollIntoView({ block: 'center' });
      return;
    }
    await repo.saveProfile(draft);
    if (!w || w.kg !== kg) await repo.setWeight(today, kg);
    toast('Profilo salvato');
  }

  const view = h('div', { class: 'view profile' },
    h('header', { class: 'view-head' },
      h('h1', null, 'Profilo'),
      w ? h('p', { class: 'muted' }, `Ultimo peso: ${fmt1(w.kg)} kg, ${plainDate(w.date)}`) : null,
    ),
    h('form', { class: 'form', novalidate: true, onSubmit: save },
      segmented('Sesso', [{ value: 'm', label: 'Uomo' }, { value: 'f', label: 'Donna' }], sex, (v) => { sex = v; update(); }),
      h('div', { class: 'form-grid' },
        field('Data di nascita', birth),
        field('Altezza (cm)', height),
      ),
      field('Peso di oggi (kg)', weight, 'Se cambia, viene registrato come pesata di oggi.'),
      field('Attività', activity),
      segmented('Obiettivo', [
        { value: 'lose', label: 'Perdere' },
        { value: 'maintain', label: 'Mantenere' },
        { value: 'gain', label: 'Aumentare' },
      ], goal, (v) => { goal = v; update(); }),
      h('div', { class: 'form-grid' }, rateField, targetField),
      h('section', { class: 'form-section' },
        h('h2', null, 'Obiettivo giornaliero'),
        planBox,
        h('label', { class: 'check' }, manual, h('span', null, 'Imposta gli obiettivi a mano')),
        autoBox,
        manualBox,
      ),
      errorBox,
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Salva profilo')),
    ),
  );
  update();
  return view;
}
