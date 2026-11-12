// Costruzione del DOM solo con createElement/textContent: nessun innerHTML,
// quindi un nome alimento o un file importato non possono iniettare markup.

export type Child = Node | string | number | null | undefined | false | Child[];
export type Props = Record<string, unknown>;

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  let value: unknown;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        // CSSOM: consentito dalla CSP, a differenza dell'attributo style.
        for (const [p, sv] of Object.entries(v as Record<string, string>)) el.style.setProperty(p, sv);
      } else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  // Dopo i figli: per <select> il valore esiste solo quando ci sono le option.
  if (value !== undefined) (el as unknown as HTMLInputElement).value = String(value);
  return el;
}

// ---- SVG (grafici, icone): createElementNS, mai markup in stringa

const SVG_NS = 'http://www.w3.org/2000/svg';
type SvgChild = SVGElement | string | null | undefined | false;

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number | null | undefined | false> | null, ...children: SvgChild[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Icone a tratto 24×24, coerenti con quelle della barra delle schede. */
export function icon(paths: ReadonlyArray<string>, label?: string): SVGSVGElement {
  return svg('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': label ? undefined : 'true', role: label ? 'img' : undefined, 'aria-label': label, class: 'ico',
  }, ...paths.map((d) => svg('path', { d })));
}

export const ICONS = {
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  scale: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M8.5 9a5 5 0 0 1 7 0', 'M12 9l1.2-1.6'],
} as const;

// ---- Toast

let toastTimer: number | undefined;

export function toast(message: string, action?: { label: string; run: () => void }): void {
  const host = document.getElementById('toast');
  if (!host) return;
  host.replaceChildren(
    h('span', null, message),
    ...(action
      ? [h('button', { type: 'button', class: 'toast-action', onClick: () => { host.classList.remove('show'); action.run(); } }, action.label)]
      : []),
  );
  host.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => host.classList.remove('show'), action ? 7000 : 2600);
}

// ---- Fogli modali (dialog nativo)

/** Tiene il foglio sopra la tastiera su iOS, dove il layout viewport non si restringe. */
function followKeyboard(dlg: HTMLDialogElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const onResize = () => {
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    dlg.style.setProperty('margin-bottom', `${covered}px`);
  };
  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', onResize);
  return () => {
    vv.removeEventListener('resize', onResize);
    vv.removeEventListener('scroll', onResize);
  };
}

export function openSheet<T>(label: string, build: (close: (value?: T) => void) => Node): Promise<T | undefined> {
  return new Promise((resolve) => {
    let result: T | undefined;
    const dlg = h('dialog', { class: 'sheet', 'aria-label': label });
    const close = (v?: T) => {
      result = v;
      dlg.close();
    };
    dlg.append(h('div', { class: 'sheet-body' }, build(close)));
    // Il dialog non ha padding: un click con target = dialog cade sullo sfondo.
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    const stop = followKeyboard(dlg);
    dlg.addEventListener('close', () => {
      stop();
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmSheet(o: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return openSheet<boolean>(o.title, (close) =>
    h('div', null,
      h('h2', { class: 'sheet-title' }, o.title),
      h('p', { class: 'muted' }, o.message),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => close(false) }, 'Annulla'),
        h('button', { type: 'button', class: `btn ${o.danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => close(true) }, o.confirm),
      ),
    ),
  ).then((v) => v === true);
}

// ---- Controlli

let uid = 0;
export const nextId = (prefix: string): string => `${prefix}-${++uid}`;

/** type=text + inputmode=decimal: tastiera numerica con virgola su iOS, parsing gestito da parseDecimal. */
export function decimalInput(props: Props = {}): HTMLInputElement {
  return h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done', ...props });
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || nextId('f');
  control.id = id;
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

export function segmented<T extends string>(
  label: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  value: T | undefined,
  onChange: (v: T) => void,
  hideLabel = false,
): HTMLElement {
  const name = nextId('seg');
  const labelId = `${name}-label`;
  return h('div', { class: 'field' },
    h('span', { class: hideLabel ? 'sr-only' : 'field-label', id: labelId }, label),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': labelId },
      ...options.map((o) =>
        h('label', { class: 'seg-opt' },
          h('input', { type: 'radio', name, value: o.value, checked: o.value === value, onChange: () => onChange(o.value) }),
          h('span', null, o.label),
        ),
      ),
    ),
  );
}
