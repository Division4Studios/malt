/** @file Bounded native terminal grid, scrollback and clipped resize. */
import { DEFAULT_TERMINAL_STYLE } from './terminal-style.ts';

import type { TerminalStyle } from './terminal-style.ts';

/** One immutable display cell. */
export interface TerminalCell {
  /** Display columns: zero marks the trailing half of a wide glyph. */
  readonly width: 0 | 1 | 2;
  /** Unicode glyph or blank. */
  readonly text: string;
  /** Immutable numeric/palette styling. */
  readonly style: TerminalStyle;
  /** Untrusted OSC 8 target, never an executable action. */
  readonly link: string | null;
}
/** Cursor coordinates are zero-based. */
export interface TerminalCursor {
  /** Column index. */
  x: number;
  /** Row index. */
  y: number;
}
/** Explicit hard memory ceilings. */
const LIMIT = { columns: 500, rows: 200, history: 500 } as const;
/** Shared immutable blank cell. */
export const BLANK_CELL: TerminalCell = Object.freeze({
  text: ' ',
  width: 1,
  style: DEFAULT_TERMINAL_STYLE,
  link: null,
});

/**
 * Remove split wide-cell halves after clipping or character insertion/deletion.
 *
 * @param row - Bounded cell row.
 * @returns Independent canonical row with no orphan wide halves.
 */
export function normalizeTerminalRow(row: readonly TerminalCell[]): TerminalCell[] {
  return row.map((cell, index) => {
    if (cell.width === 0 && row[index - 1]?.width !== 2) {
      return BLANK_CELL;
    }
    return cell.width === 2 && row[index + 1]?.width !== 0 ? BLANK_CELL : cell;
  });
}

/**
 * Clamp untrusted dimensions before allocating cells.
 *
 * @param value - Requested integer size.
 * @param maximum - Native grid ceiling.
 * @returns A finite positive integer.
 */
function dimension(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : 1;
}

/** Memory-bounded primary or alternate cell grid. */
export class TerminalGrid {
  /** Current clamped columns. */
  public columns: number;
  /** Current clamped rows. */
  public rows: number;
  /** Visible cell rows, changed only by the screen model. */
  public lines: TerminalCell[][];
  /** Bounded completed primary rows; alternate grids disable retention. */
  public readonly history: TerminalCell[][] = [];
  /** Dirty visible rows consumed by the renderer. */
  public readonly dirty = new Set<number>();
  /** Current clamped cursor. */
  public readonly cursor: TerminalCursor = { x: 0, y: 0 };
  /** Whether primary scrollback is allowed. */
  private readonly hasHistory: boolean;

  /**
   * Allocate only within hard grid bounds.
   *
   * @param columns - Requested column count.
   * @param rows - Requested row count.
   * @param hasHistory - Primary screen retention flag.
   */
  public constructor(columns: number, rows: number, hasHistory = true) {
    this.columns = dimension(columns, LIMIT.columns);
    this.rows = dimension(rows, LIMIT.rows);
    this.hasHistory = hasHistory;
    this.lines = Array.from({ length: this.rows }, () => this.blank());
    this.invalidate();
  }

  /**
   * Create one independent row of immutable blank cells.
   *
   * @returns Exactly the current number of columns.
   */
  public blank(): TerminalCell[] {
    return Array.from({ length: this.columns }, () => BLANK_CELL);
  }

  /** Mark every visible row for repaint after a structural change. */
  public invalidate(): void {
    for (let index = 0; index < this.rows; index += 1) {
      this.dirty.add(index);
    }
  }

  /**
   * Clamp cursor and mark its old/new rows for visible focus feedback.
   *
   * @param x - Requested zero-based column.
   * @param y - Requested zero-based row.
   */
  public move(x: number, y: number): void {
    this.dirty.add(this.cursor.y);
    this.cursor.x = Math.max(0, Math.min(this.columns - 1, x));
    this.cursor.y = Math.max(0, Math.min(this.rows - 1, y));
    this.dirty.add(this.cursor.y);
  }

  /**
   * Scroll a validated inclusive region, optionally retaining primary history.
   *
   * @param top - First affected row.
   * @param bottom - Last affected row.
   * @param count - Positive scroll-up or negative scroll-down count.
   * @param shouldRetain - Explicit line deletion must not enter scrollback.
   */
  public scroll(top: number, bottom: number, count: number, shouldRetain = true): void {
    const amount = Math.min(Math.abs(count), bottom - top + 1);
    for (let index = 0; index < amount; index += 1) {
      if (count > 0) {
        const removed = this.lines.splice(top, 1)[0];
        if (removed !== undefined && top === 0 && shouldRetain && this.hasHistory && bottom === this.rows - 1) {
          this.history.push(removed);
          if (this.history.length > LIMIT.history) {
            this.history.splice(0, this.history.length - LIMIT.history);
          }
        }
        this.lines.splice(bottom, 0, this.blank());
      } else {
        this.lines.splice(bottom, 1);
        this.lines.splice(top, 0, this.blank());
      }
    }
    for (let index = top; index <= bottom; index += 1) {
      this.dirty.add(index);
    }
  }

  /**
   * Clip or pad both grids and retained rows without unbounded reflow work.
   *
   * @param columns - Requested columns.
   * @param rows - Requested rows.
   */
  public resize(columns: number, rows: number): void {
    this.columns = dimension(columns, LIMIT.columns);
    this.rows = dimension(rows, LIMIT.rows);
    const resizeRow = (row: TerminalCell[]): TerminalCell[] => {
      const clipped = [...row.slice(0, this.columns), ...this.blank()].slice(0, this.columns);
      return normalizeTerminalRow(clipped);
    };
    this.lines = this.lines.slice(0, this.rows).map((row) => resizeRow(row));
    while (this.lines.length < this.rows) {
      this.lines.push(this.blank());
    }
    for (let index = 0; index < this.history.length; index += 1) {
      const row = this.history[index];
      if (row !== undefined) {
        this.history[index] = resizeRow(row);
      }
    }
    this.dirty.clear();
    this.move(this.cursor.x, this.cursor.y);
    this.invalidate();
  }
}
