/** @file Pure literal terminal run planning and bounded dirty-row scheduling. */
import type { TerminalCell, TerminalGrid } from './terminal-grid.ts';
import type { TerminalScreen } from './terminal-screen.ts';
import type { TerminalStyle } from './terminal-style.ts';

/** A bounded batch prevents a full-screen redraw monopolizing one frame. */
const ROW_BUDGET = 8;
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
