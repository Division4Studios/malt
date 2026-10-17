/**
 * Small DOM helpers shared by the workflow views: labelled native controls,
 * text-only badges, a native `<dialog>` choice and focus preservation across
 * re-renders. Every value is assigned as text or a property; nothing is
 * parsed as HTML.
 *
 * @file
 */
import { element } from './worker-ui.js';

/** Attribute that names a control so focus can be restored after a re-render. */
const FOCUS_ATTRIBUTE = 'data-focus';

/**
 * Selector for the control with a focus key.
 *
 * @param key - Identifier given to the control by {@link keyed} or {@link button}.
 * @returns Attribute selector with the key escaped.
 */
export function focusSelector(key: string): string {
  return `[data-focus="${CSS.escape(key)}"]`;
}

/**
 * Build a native button.
 *
 * @param label - Visible text.
 * @param onClick - Activation handler.
 * @param options - Optional class, accessible name and focus key.
 * @returns Button element.
 */
export function button(
  label: string,
  onClick: () => void,
  options: { readonly variant?: string; readonly ariaLabel?: string; readonly focusKey?: string } = {},
): HTMLButtonElement {
  const node = element('button', `button ${options.variant ?? 'secondary'}`, label);
  node.type = 'button';
  if (options.ariaLabel !== undefined) {
    node.setAttribute('aria-label', options.ariaLabel);
  }
  if (options.focusKey !== undefined) {
    node.setAttribute(FOCUS_ATTRIBUTE, options.focusKey);
  }
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Give a control a focus key and a stable id.
 *
 * @param control - Native control.
 * @param key - Unique key within the view.
 * @returns The same control.
 */
export function keyed<T extends HTMLElement>(control: T, key: string): T {
  control.setAttribute(FOCUS_ATTRIBUTE, key);
  control.setAttribute('id', `wf-${key.replaceAll(/[^\w\-]/gv, '-')}`);
  return control;
}

/**
 * Wrap a control with a visible label and an optional hint tied by `aria-describedby`.
 *
 * @param label - Visible label text.
 * @param control - Keyed native control.
 * @param hint - Optional help text.
 * @returns Field wrapper.
 */
export function field(label: string, control: HTMLElement, hint = ''): HTMLElement {
  const wrapper = element('div', 'wf-field');
  const caption = element('label', 'wf-label', label);
  caption.htmlFor = control.id;
  wrapper.append(caption, control);
  if (hint !== '') {
    const help = element('p', 'wf-hint', hint);
    help.id = `${control.id}-hint`;
    control.setAttribute('aria-describedby', help.id);
    wrapper.append(help);
  }
  return wrapper;
}

/**
 * A checkbox with its own label.
 *
 * @param label - Visible label text, or a prepared label body.
 * @param isChecked - Initial state.
 * @param key - Identifier used to find the control again after a re-render.
 * @param onToggle - Change handler.
 * @returns Label containing the checkbox.
 */
export function checkbox(
  label: string | HTMLElement,
  isChecked: boolean,
  key: string,
  onToggle: (isOn: boolean) => void,
): HTMLLabelElement {
  const input = keyed(element('input'), key);
  input.type = 'checkbox';
  input.checked = isChecked;
  input.addEventListener('change', () => {
    onToggle(input.checked);
  });
  const wrapper = element('label', 'wf-check');
  wrapper.append(input, typeof label === 'string' ? element('span', '', label) : label);
  return wrapper;
}

/**
 * A select with fixed options.
 *
 * @param options - Value and label pairs.
 * @param value - Selected value.
 * @param key - Identifier used to find the control again after a re-render.
 * @param onSelect - Change handler.
 * @returns Select element.
 */
export function select(
  options: readonly (readonly [string, string])[],
  value: string,
  key: string,
  onSelect: (selected: string) => void,
): HTMLSelectElement {
  const node = keyed(element('select', 'wf-select'), key);
  node.append(...options.map(([optionValue, label]) => new Option(label, optionValue, false, optionValue === value)));
  node.value = value;
  node.addEventListener('change', () => {
    onSelect(node.value);
  });
  return node;
}

/**
 * A text-only badge; meaning is in the words, colour only reinforces it.
 *
 * @param label - Badge text.
 * @param tone - Style variant.
 * @returns Badge element.
 */
export function badge(label: string, tone = ''): HTMLElement {
  return element('span', `wf-badge ${tone}`.trim(), label);
}

/** A remembered focus position. */
interface FocusMark {
  /** Focus key of the control. */
  readonly key: string;
  /** Text selection start, for text fields. */
  readonly start: number | null;
  /** Text selection end, for text fields. */
  readonly end: number | null;
}

/**
 * Remember which keyed control inside a container has focus.
 *
 * @param container - Region about to be re-rendered.
 * @returns The mark, or null when focus is elsewhere.
 */
export function rememberFocus(container: HTMLElement): FocusMark | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) {
    return null;
  }
  const key = active.getAttribute(FOCUS_ATTRIBUTE);
  if (key === null) {
    return null;
  }
  const isText = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  return {
    key,
    start: isText ? active.selectionStart : null,
    end: isText ? active.selectionEnd : null,
  };
}

/**
 * Return focus to the control with the remembered key, without scrolling.
 *
 * @param container - Re-rendered region.
 * @param mark - Mark from {@link rememberFocus}.
 */
export function restoreFocus(container: HTMLElement, mark: FocusMark | null): void {
  if (mark === null) {
    return;
  }
  focusKey(container, mark.key);
  const target = container.querySelector(focusSelector(mark.key));
  if ((target instanceof HTMLInputElement && target.type === 'text') || target instanceof HTMLTextAreaElement) {
    try {
      target.setSelectionRange(mark.start, mark.end);
    } catch {
      // Some input types have no selection; focus alone is enough.
    }
  }
}

/**
 * Focus a keyed control if it exists.
 *
 * @param container - Region to search.
 * @param key - Identifier used to find the control again after a re-render.
 * @param shouldScroll - Bring the control into view (for newly shown controls); restores never scroll.
 */
export function focusKey(container: HTMLElement, key: string, shouldScroll = false): void {
  const target = container.querySelector(focusSelector(key));
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: !shouldScroll });
  }
}

/** Text of a two-way choice. */
export interface ChoiceText {
  /** Dialog heading. */
  readonly title: string;
  /** Explanation. */
  readonly message: string;
  /** Label of the confirming action. */
  readonly confirm: string;
  /** Label of the cancelling action. */
  readonly cancel: string;
}

/**
 * Ask a two-way question in a native modal `<dialog>`; Escape cancels.
 *
 * @param host - Element that owns the dialog while it is open.
 * @param choice - Dialog text.
 * @returns True when the operator confirms.
 */
export async function isConfirmed(host: HTMLElement, choice: ChoiceText): Promise<boolean> {
  const dialog = element('dialog', 'wf-dialog');
  const heading = element('h2', '', choice.title);
  heading.id = 'wf-dialog-title';
  const message = element('p', '', choice.message);
  message.id = 'wf-dialog-message';
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.setAttribute('aria-describedby', message.id);
  const returnTo = document.activeElement;
  return await new Promise<boolean>((resolve) => {
    const cancel = button(choice.cancel, () => {
      dialog.close('cancel');
    });
    const confirm = button(
      choice.confirm,
      () => {
        dialog.close('confirm');
      },
      { variant: 'primary' },
    );
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, confirm);
    dialog.append(heading, message, actions);
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus();
      }
      resolve(dialog.returnValue === 'confirm');
    });
    host.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
