/** @file Pure bounded VT keyboard/paste encoding; no browser or process authority. */
/** Native control character constants. */
const KEY = {
  escape: '\u{1B}',
  enter: '\r',
  backspace: '\u{7F}',
  controlBase: 64,
  controlLast: 95,
  space: 32,
  del: 127,
  c1Last: 159,
  shift: 1,
  alt: 2,
  control: 4,
} as const;
/** Transport payload bound, including paste framing. */
const MAX_BYTES = 16_384;
/** Native UTF-8 byte accounting. */
const encoder = new TextEncoder();
/** Navigation final bytes; app cursor mode uses SS3 when unmodified. */
const CURSORS = new Map([
  ['ArrowUp', 'A'],
  ['ArrowDown', 'B'],
  ['ArrowRight', 'C'],
  ['ArrowLeft', 'D'],
  ['Home', 'H'],
  ['End', 'F'],
]);
/** Tilde-form extended keys. */
const EXTENDED = new Map([
  ['Insert', '2'],
  ['Delete', '3'],
  ['PageUp', '5'],
  ['PageDown', '6'],
  ['F5', '15'],
  ['F6', '17'],
  ['F7', '18'],
  ['F8', '19'],
  ['F9', '20'],
  ['F10', '21'],
  ['F11', '23'],
  ['F12', '24'],
]);
/** First four function keys use SS3 without modifiers. */
const FUNCTIONS = new Map([
  ['F1', 'P'],
  ['F2', 'Q'],
  ['F3', 'R'],
  ['F4', 'S'],
]);
/** Fixed single-byte keys bypass printable control-chord conversion. */
const SIMPLE = new Map([
  ['Enter', KEY.enter],
  ['Backspace', KEY.backspace],
]);
/** Preserve browser navigation and native clipboard shortcuts. */
const BROWSER_KEYS: ReadonlySet<string> = new Set(['l', 't', 'w', 'n', 'r', 'v']);
/** Minimal native event observation; pure tests do not import DOM types. */
export interface TerminalKey {
  /** Actual key, not a key code or shell command. */
  readonly key: string;
  /** Native modifier states. */
  readonly ctrlKey: boolean;
  /** Native modifier states. */
  readonly altKey: boolean;
  /** Native modifier states. */
  readonly shiftKey: boolean;
  /** OS shortcuts retain browser authority. */
  readonly metaKey: boolean;
  /** Compositions are handled by the native editable input. */
  readonly isComposing: boolean;
}

/**
 * Encode explicit native keys; the pane intercepts Tab for browser focus escape.
 *
 * @param event - Observed focus-scoped key.
 * @param isAppCursor - Actual negotiated screen mode.
 * @returns VT bytes as Unicode text, or null for browser/IME handling.
 */
export function terminalKey(event: TerminalKey, isAppCursor: boolean): string | null {
  const { key, ctrlKey, isComposing, metaKey } = event;
  const isBrowserKey = isComposing || metaKey || key === 'Escape' || (ctrlKey && BROWSER_KEYS.has(key.toLowerCase()));
  if (isBrowserKey) {
    return null;
  }
  if (key === 'Tab') {
    return event.shiftKey ? `${KEY.escape}[Z` : '\t';
  }
  return navigationKey(event, isAppCursor) ?? printableKey(event);
}

/**
 * Encode bounded navigation/function sequences independently of printable input.
 *
 * @param event - Captured native modifiers and key.
 * @param isAppCursor - Negotiated cursor mode.
 * @returns Navigation bytes, or null for a printable/nonterminal key.
 */
function navigationKey(event: TerminalKey, isAppCursor: boolean): string | null {
  const { key, ctrlKey, altKey, shiftKey } = event;
  const modifier = 1 + (shiftKey ? KEY.shift : 0) + (altKey ? KEY.alt : 0) + (ctrlKey ? KEY.control : 0);
  const cursor = CURSORS.get(key) ?? FUNCTIONS.get(key);
  if (cursor !== undefined) {
    if (modifier !== 1) {
      return `${KEY.escape}[1;${String(modifier)}${cursor}`;
    }
    const prefix = isAppCursor || FUNCTIONS.has(key) ? 'O' : '[';
    return `${KEY.escape}${prefix}${cursor}`;
  }
  const extended = EXTENDED.get(key);
  if (extended !== undefined) {
    const suffix = modifier === 1 ? '' : `;${String(modifier)}`;
    return `${KEY.escape}[${extended}${suffix}~`;
  }
  return null;
}

/**
 * Preserve literal Unicode and encode explicit native control chords.
 *
 * @param event - Captured character/control observation.
 * @returns Bounded literal/control text, or null for non-character keys.
 */
function printableKey(event: TerminalKey): string | null {
  const { key, ctrlKey, altKey } = event;
  const textKey = SIMPLE.get(key) ?? key;
  if (textKey !== key) {
    return altKey ? `${KEY.escape}${textKey}` : textKey;
  }
  const firstPoint = textKey.codePointAt(0);
  if (firstPoint === undefined || String.fromCodePoint(firstPoint) !== textKey) {
    return null;
  }
  let text = textKey;
  if (ctrlKey && !altKey) {
    const upper = key.toUpperCase();
    if (upper.length !== 1) {
      return null;
    }
    const point = upper.codePointAt(0) ?? 0;
    if (point === KEY.space) {
      text = '\0';
    } else if (point >= KEY.controlBase && point <= KEY.controlLast) {
      text = String.fromCodePoint(point - KEY.controlBase);
    } else {
      return null;
    }
  }
  return altKey && !ctrlKey ? `${KEY.escape}${text}` : text;
}

/**
 * Remove pasted terminal control injection and bound the actual UTF-8 frame.
 *
 * @param value - Explicit native clipboard text.
 * @param isBracketed - Actual negotiated CLI paste mode.
 * @returns Sanitized text with optional bracket framing.
 * @throws {RangeError} When a paste exceeds the native payload ceiling.
 */
export function terminalPaste(value: string, isBracketed: boolean): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  let safe = '';
  for (const character of normalized) {
    const point = character.codePointAt(0) ?? 0;
    if (!(
      character === '\t' ||
      character === '\n' ||
      (point >= KEY.space && (point < KEY.del || point > KEY.c1Last))
    )) {
      continue;
    }

    safe += character;
    if (safe.length > MAX_BYTES) {
      throw new RangeError('Paste exceeds 16 KiB. Split it into smaller explicit pastes.');
    }
  }
  const framed = isBracketed && safe !== '' ? `${KEY.escape}[200~${safe}${KEY.escape}[201~` : safe;
  if (encoder.encode(framed).byteLength > MAX_BYTES) {
    throw new RangeError('Paste exceeds 16 KiB of UTF-8, including its terminal framing.');
  }
  return framed;
}
