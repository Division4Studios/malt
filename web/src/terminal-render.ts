/** @file Safe, frame-bounded terminal DOM rendering with no HTML interpretation. */
import type { TerminalCell, TerminalGrid } from './terminal-grid.ts';
import type { TerminalScreen } from './terminal-screen.ts';
import type { TerminalStyle } from './terminal-style.ts';

/** A bounded batch prevents a full-screen redraw monopolizing one frame. */
const ROW_BUDGET = 8;
/** A hostile color-changing stream cannot grow the CSSOM indefinitely. */
const COLOR_LIMIT = 256;
/** Numeric component ceiling. */
const CHANNEL_MAX = 255;
/** Accessible updates contain no transcript and remain bounded. */
const SUMMARY_LENGTH = 200;
/** One project-derived run; targets remain untrusted until link validation. */
export interface TerminalRun {
  /** Literal display text. */
  text: string;
  /** Immutable rendition from the pure model. */
  readonly style: TerminalStyle;
  /** Untrusted OSC target. */
  readonly link: string | null;
  /** Cursor decoration, separate from private text. */
  readonly isCursor: boolean;
  /** Wide glyph run, never combined with normal-width text. */
  readonly isWide: boolean;
}
/** Native DOM and pure test surfaces share this small rendering boundary. */
export interface TerminalSurface {
  /** Replace only one dirty row with plain-text runs. */
  row: (index: number, runs: readonly TerminalRun[]) => void;
  /** Retire rows after resize or screen replacement. */
  trim: (rows: number, shouldReset: boolean) => void;
  /** Accessible non-content summary. */
  announce: (message: string) => void;
}

/**
 * Validate an absolute clickable target; controls and other schemes stay text.
 *
 * @param target - Untrusted OSC 8 target.
 * @returns Safe absolute HTTP(S) URL, or null.
 */
export function terminalLink(target: string | null): string | null {
  if (target === null || /\p{Control}/v.test(target)) {
    return null;
  }
  try {
    const url = new URL(target);
    return isHttpTarget(url) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Exclude userinfo and every non-HTTP protocol after native URL parsing.
 *
 * @param url - Parsed absolute target.
 * @returns Whether human navigation may use it.
 */
function isHttpTarget(url: URL): boolean {
  return ['https:', 'http:'].includes(url.protocol) && url.username === '' && url.password === '';
}

/**
 * Group adjacent normal-width cells without merging cursor/wide boundaries.
 *
 * @param cells - One bounded visible row.
 * @param cursor - Cursor column, or -1 when hidden/on another row.
 * @returns Safe immutable-style runs containing literal untrusted text.
 */
export function terminalRuns(cells: readonly TerminalCell[], cursor: number): TerminalRun[] {
  const runs: TerminalRun[] = [];
  for (const [index, cell] of cells.entries()) {
    if (cell.width === 0) {
      continue;
    }
    const isCursor = cursor === index || (cell.width === 2 && cursor === index + 1);
    const isWide = cell.width === 2;
    const prior = runs.at(-1);
    if (
      !isWide &&
      !isCursor &&
      prior !== undefined &&
      !prior.isCursor &&
      !prior.isWide &&
      prior.style === cell.style &&
      prior.link === cell.link
    ) {
      prior.text += cell.text;
    } else {
      runs.push({ text: cell.text, style: cell.style, link: cell.link, isCursor, isWide });
    }
  }
  return runs;
}

/** Dirty-row scheduling is pure and independently testable without a browser library. */
export class TerminalRenderer {
  /** Explicit native rendering boundary. */
  private readonly surface: TerminalSurface;
  /** Grid identity detects alternate display/reset. */
  private grid: TerminalGrid | null = null;

  /**
   * Bind to one owned view without starting a process or network stream.
   *
   * @param surface - Native text-only rendering operations.
   */
  public constructor(surface: TerminalSurface) {
    this.surface = surface;
  }

  /**
   * Paint at most eight dirty rows; callers schedule another animation frame if needed.
   *
   * @param screen - Current bounded screen state.
   * @returns Whether another frame has pending rows.
   */
  public render(screen: TerminalScreen): boolean {
    const { grid } = screen;
    const hasChanged = this.grid !== grid;
    this.surface.trim(grid.rows, hasChanged);
    this.grid = grid;
    if (hasChanged) {
      grid.invalidate();
    }
    let count = 0;
    for (const index of grid.dirty) {
      if (count >= ROW_BUDGET) {
        return true;
      }
      const cells = grid.lines[index];
      if (cells !== undefined) {
        const cursor = screen.isCursorVisible && grid.cursor.y === index ? grid.cursor.x : -1;
        this.surface.row(index, terminalRuns(cells, cursor));
      }
      grid.dirty.delete(index);
      count += 1;
    }
    this.surface.announce(
      `Terminal updated. Cursor row ${String(grid.cursor.y + 1)}, column ${String(grid.cursor.x + 1)}.`,
    );
    return false;
  }
}

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
        const next = nodes.get(index + 1);
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
