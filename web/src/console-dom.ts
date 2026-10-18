/**
 * Small DOM builders shared by the Inbox, Board and delivery views: keyed
 * focus preservation across re-renders, relative-time stamps, state badges,
 * step strips and safe external links. Untrusted text is always set through
 * `textContent`; nothing here parses HTML.
 *
 * @file
 */
import { STATE_LABELS, relativeAge, stepStrip } from './console-model.js';
import { formatDateTime, t } from './i18n.js';
import { element } from './worker-ui.js';

import type { Step, StepState } from './console-model.js';

/** A mounted console view. */
export interface ConsoleViewHandle {
  /** Stable root element; mount it once. */
  readonly element: HTMLElement;
  /** Apply the latest snapshot; call it on every server push. */
  readonly update: (snapshot: unknown) => void;
}

/** Protocols an external link may use. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:']);

/**
 * Read the focus key of the focused control inside a view.
 *
 * @param root - View root.
 * @returns Key of the focused keyed control, or `null`.
 */
export function focusedKey(root: HTMLElement): string | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && root.contains(active) ? (active.dataset['focusKey'] ?? null) : null;
}

/**
 * Focus the control carrying a key, or a fallback when it no longer exists.
 *
 * @param root - View root.
 * @param key - Focus key, or `null` to leave focus alone.
 * @param fallback - Element focused when no control carries the key.
 */
export function restoreFocus(root: HTMLElement, key: string | null, fallback: HTMLElement | null = null): void {
  if (key === null) {
    return;
  }
  const target = [...root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
    (node) => node.dataset['focusKey'] === key,
  );
  (target ?? fallback)?.focus({ preventScroll: true });
}

/**
 * Build a plain button whose focus survives re-renders.
 *
 * @param label - Visible text.
 * @param options - Classes, focus key and click handler.
 * @param options.cssClass - Classes.
 * @param options.key - Focus key stable across renders of the same logical control.
 * @param options.action - Click handler.
 * @returns Button of type `button`.
 */
export function button(
  label: string,
  options: { readonly cssClass: string; readonly key: string; readonly action: () => void },
): HTMLButtonElement {
  const node = element('button', options.cssClass, label);
  node.type = 'button';
  node.dataset['focusKey'] = options.key;
  node.addEventListener('click', options.action);
  return node;
}

/**
 * Build a relative-time stamp that `refreshAges` keeps current.
 *
 * @param since - Epoch milliseconds.
 * @param now - Current epoch milliseconds.
 * @returns `<time>` element with the absolute time as its tooltip.
 */
export function ageStamp(since: number, now: number): HTMLTimeElement {
  const date = new Date(since);
  // Untrusted snapshots can carry finite numbers outside the Date range; those show as unknown.
  const isValid = since > 0 && !Number.isNaN(date.getTime());
  const node = element('time', 'console-age', relativeAge(isValid ? since : 0, now));
  if (isValid) {
    node.dateTime = date.toISOString();
    node.title = formatDateTime(date);
    node.dataset['since'] = String(since);
  }
  return node;
}

/**
 * Update every relative-time stamp in a view without re-rendering it.
 *
 * @param root - View root.
 * @param now - Current epoch milliseconds.
 */
export function refreshAges(root: HTMLElement, now: number): void {
  for (const node of root.querySelectorAll<HTMLElement>('time[data-since]')) {
    const since = Number(node.dataset['since']);
    const value = relativeAge(since, now);
    if (node.textContent !== value) {
      node.textContent = value;
    }
  }
}

/**
 * Build a state badge that pairs color with a glyph and text.
 *
 * @param state - Step state.
 * @returns Badge element.
 */
export function stateBadge(state: StepState): HTMLElement {
  const node = element('span', 'state-badge');
  node.dataset['state'] = state;
  const glyph = element('span', 'state-glyph', STATE_LABELS[state].glyph);
  glyph.setAttribute('aria-hidden', 'true');
  node.append(glyph, element('span', '', STATE_LABELS[state].label));
  return node;
}

/**
 * Build a small neutral badge.
 *
 * @param label - Visible text.
 * @param cssClass - Extra classes.
 * @returns Badge element.
 */
export function tag(label: string, cssClass = ''): HTMLElement {
  return element('span', `console-tag ${cssClass}`.trim(), label);
}

/**
 * Build a compact step-progress strip with a caption.
 *
 * @param steps - Steps in workflow order.
 * @returns Strip whose segments are described for assistive technology.
 */
export function stepStripNode(steps: readonly Step[]): HTMLElement {
  const { segments, caption } = stepStrip(steps);
  const wrapper = element('div', 'step-strip');
  const list = element('ol', 'step-strip-segments');
  list.setAttribute('aria-label', t('Step progress'));
  for (const segment of segments) {
    const item = element('li', 'step-segment');
    item.dataset['state'] = segment.state;
    item.title = segment.label;
    item.append(element('span', 'sr-only', segment.label));
    list.append(item);
  }
  wrapper.append(list, element('p', 'step-strip-caption', caption));
  return wrapper;
}

/**
 * Build a link to an external page, refusing anything but http(s).
 *
 * @param url - Untrusted address.
 * @param label - Visible text.
 * @returns Link opening in a new tab, or plain text when the address is unsafe.
 */
export function externalLink(url: string, label: string): HTMLElement {
  const parsed = URL.parse(url);
  if (parsed === null || !SAFE_PROTOCOLS.has(parsed.protocol)) {
    return element('span', 'subtle', t('{label} (link unavailable)', { label }));
  }
  const link = element('a', 'console-link', label);
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.append(element('span', 'sr-only', t(' (opens in a new tab)')));
  return link;
}

/**
 * Build an empty-state block.
 *
 * @param title - Heading text.
 * @param detail - Explanation.
 * @returns Empty-state element.
 */
export function emptyState(title: string, detail: string): HTMLElement {
  const node = element('div', 'console-empty');
  node.append(element('p', 'console-empty-title', title), element('p', 'subtle', detail));
  return node;
}
