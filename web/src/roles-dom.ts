/**
 * Small native form builders shared by the Roles view and its type dialog,
 * and the skill priority order the dialog keeps.
 *
 * @file
 */
import { element } from './worker-ui.js';

/**
 * Build a labelled form field.
 *
 * @param label - Visible label.
 * @param control - Input, select or textarea.
 * @param hint - Optional help text.
 * @returns Label wrapping the control.
 */
export function labelled(label: string, control: HTMLElement, hint = ''): HTMLLabelElement {
  const node = element('label', 'role-field');
  node.append(element('span', 'role-field-label', label), control);
  if (hint !== '') {
    node.append(element('span', 'role-hint', hint));
  }
  return node;
}

/**
 * Build a checkbox with its label.
 *
 * @param label - Visible label.
 * @param isChecked - Initial state.
 * @param value - Value carried by the checkbox.
 * @returns Label and its checkbox.
 */
export function checkbox(
  label: string,
  isChecked: boolean,
  value = '',
): { node: HTMLLabelElement; input: HTMLInputElement } {
  const input = element('input');
  input.type = 'checkbox';
  input.checked = isChecked;
  input.value = value;
  const node = element('label', 'role-check');
  node.append(input, element('span', '', label));
  return { node, input };
}

/**
 * Replace a select's options.
 *
 * @param select - Select element.
 * @param options - Value and label pairs.
 * @param value - Selected value.
 */
export function fillSelect(
  select: HTMLSelectElement,
  options: readonly (readonly [string, string])[],
  value: string,
): void {
  const node = select;
  node.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  node.value = options.some(([optionValue]) => optionValue === value) ? value : (options[0]?.[0] ?? '');
}

/**
 * Keep the saved priority of the skills that stay selected, then add newly
 * selected ones in catalog order; unchecking and checking a skill again moves
 * it to the end.
 *
 * @param order - Skills in their saved priority.
 * @param selected - Skills checked, in catalog order.
 * @returns Selected skills in priority order.
 */
export function prioritized(order: readonly string[], selected: readonly string[]): string[] {
  return [...order.filter((skill) => selected.includes(skill)), ...selected.filter((skill) => !order.includes(skill))];
}
