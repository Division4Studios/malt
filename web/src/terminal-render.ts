/** @file Native text-only terminal DOM adapter with bounded numeric CSS classes. */
import { nextTerminalRow, terminalLink } from './terminal-render-model.ts';

import type { TerminalRun, TerminalSurface } from './terminal-render-model.ts';
import type { TerminalStyle } from './terminal-style.ts';

export { TerminalRenderer } from './terminal-render-model.ts';

/** A hostile color-changing stream cannot grow the CSSOM indefinitely. */
const COLOR_LIMIT = 256;
/** Numeric component ceiling. */
const CHANNEL_MAX = 255;
/** Accessible updates contain no transcript and remain bounded. */
const SUMMARY_LENGTH = 200;
/** Fixed style classes; terminal values can never choose a class name. */
const FLAGS: ReadonlyMap<keyof TerminalStyle, string> = new Map([
  ['bold', 'term-bold'],
  ['dim', 'term-dim'],
  ['italic', 'term-italic'],
  ['underline', 'term-underline'],
  ['inverse', 'term-inverse'],
  ['concealed', 'term-concealed'],
  ['strike', 'term-strike'],
]);
/** Bounded generated color classes contain validated colors only, never terminal CSS. */
const colors = new Map<string, string>();
/** One stylesheet, created lazily in browsers which support native CSSOM adoption. */
const palette: { sheet: CSSStyleSheet | null } = { sheet: null };

/**
 * Validate model colors again before entering CSSOM.
 *
 * @param color - Model rendition value.
 * @returns Safe fixed hex/numeric RGB value, or null.
 */
function safeColor(color: string | null): string | null {
  if (color === null) {
    return null;
  }
  if (/^#[\da-f]{6}$/iv.test(color)) {
    return color;
  }
  const match = /^rgb\((?<red>\d{1,3}) (?<green>\d{1,3}) (?<blue>\d{1,3})\)$/v.exec(color);
  if (match?.groups === undefined) {
    return null;
  }
  const { red, green, blue } = match.groups;
  return [red, green, blue].every((part) => Number(part) <= CHANNEL_MAX) ? color : null;
}

/**
 * Register numeric CSS rules within the fixed stylesheet cap.
 *
 * @param color - Already validated color literal.
 * @returns Trusted class prefix, or theme fallback if native CSSOM is unavailable.
 */
function registerColor(color: string): string {
  if (colors.size >= COLOR_LIMIT) {
    return '';
  }
  const name = `term-color-${String(colors.size)}`;
  try {
    palette.sheet ??= new CSSStyleSheet();
    const { sheet } = palette;
    if (!document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    sheet.insertRule(`.${name}-fg { --term-fg: ${color}; }`);
    sheet.insertRule(`.${name}-bg { --term-bg: ${color}; }`);
  } catch {
    return '';
  }
  colors.set(color, name);
  return name;
}

/**
 * Assign bounded numeric/palette colors through classes rather than style attributes.
 *
 * @param value - Model color value.
 * @param isBackground - Foreground or background CSS variable.
 * @returns Generated trusted class name, or an empty theme-default fallback.
 */
function colorClass(value: string | null, isBackground: boolean): string {
  const color = safeColor(value);
  if (color === null) {
    return '';
  }
  const name = colors.get(color) ?? registerColor(color);
  const suffix = isBackground ? 'bg' : 'fg';
  return name === '' ? '' : `${name}-${suffix}`;
}

/**
 * Build one native text node or validated link without HTML parsing.
 *
 * @param run - Literal terminal text and validated model rendition.
 * @returns Safe DOM node.
 */
function runNode(run: TerminalRun): HTMLElement {
  const href = terminalLink(run.link);
  const node = document.createElement(href === null ? 'span' : 'a');
  if (href !== null && node instanceof HTMLAnchorElement) {
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    node.referrerPolicy = 'no-referrer';
  }
  node.textContent = run.text;
  node.classList.add('term-cell');
  if (run.isWide) {
    node.classList.add('term-wide');
  }
  if (run.isCursor) {
    node.classList.add('term-cursor');
  }
  for (const [key, css] of FLAGS) {
    if (run.style[key] === true) {
      node.classList.add(css);
    }
  }
  const cssNames = [colorClass(run.style.foreground, false), colorClass(run.style.background, true)].filter(
    (name) => name !== '',
  );
  node.classList.add(...cssNames);
  return node;
}

/**
 * Create one owned text-only DOM surface; no network or input handlers are attached.
 *
 * @param root - Owned visible grid container.
 * @param liveRegion - Separate accessible status summary.
 * @returns Small native rendering boundary.
 */
export function terminalSurface(root: HTMLElement, liveRegion: HTMLElement): TerminalSurface {
  const nodes = new Map<number, HTMLElement>();
  const status = liveRegion;
  root.classList.add('terminal-screen');
  root.setAttribute('aria-live', 'off');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.classList.add('sr-only');
  return {
    /**
     * Replace exactly one visible row.
     *
     * @param index - Zero-based row position.
     * @param runs - Literal text and trusted style flags.
     */
    row(index, runs) {
      let row = nodes.get(index);
      if (row === undefined) {
        row = document.createElement('div');
        row.classList.add('terminal-row');
        nodes.set(index, row);
        const nextIndex = nextTerminalRow(nodes.keys(), index);
        const next = nextIndex === null ? undefined : nodes.get(nextIndex);
        root.insertBefore(row, next ?? null);
      }
      row.replaceChildren(...runs.map((run) => runNode(run)));
    },

    /**
     * Retire stale nodes after display switch or resize.
     *
     * @param rows - Current grid row count.
     * @param shouldReset - Grid identity has changed.
     */
    trim(rows, shouldReset) {
      if (shouldReset) {
        root.replaceChildren();
        nodes.clear();
      }
      for (const [index, row] of nodes) {
        if (index < rows) {
          continue;
        }

        row.remove();
        nodes.delete(index);
      }
    },

    /**
     * Announce a bounded summary without reading transcript content.
     *
     * @param message - Fixed renderer status text.
     */
    announce(message) {
      if (status.textContent !== message) {
        status.textContent = message.slice(0, SUMMARY_LENGTH);
      }
    },
  };
}
