/** @file Pure bounded VT screen; output never becomes DOM, CSS or terminal commands. */
import { BLANK_CELL, TerminalGrid, normalizeTerminalRow } from './terminal-grid.ts';
import { DEFAULT_TERMINAL_STYLE, terminalStyle } from './terminal-style.ts';
import { terminalWidth } from './terminal-width.ts';

import type { TerminalCell } from './terminal-grid.ts';
import type { TerminalAction } from './terminal-parser.ts';
import type { TerminalStyle } from './terminal-style.ts';

/** One complete cursor/rendition save point. */
interface SavedCursor {
  /** Saved column. */
  readonly x: number;
  /** Saved row. */
  readonly y: number;
  /** Saved immutable rendition. */
  readonly style: TerminalStyle;
}
/** CSI payload already bounded by the parser. */
type Control = Extract<TerminalAction, { type: 'csi' }>;
/** Wire constants and bounded combining storage. */
const VT = {
  backspace: 8,
  tab: 9,
  linefeed: 10,
  verticalTab: 11,
  formfeed: 12,
  carriageReturn: 13,
  tabWidth: 8,
  eraseAll: 2,
  eraseHistory: 3,
  wide: 2,
  glyphLength: 32,
  application: 1,
  wrap: 7,
  cursor: 25,
  alternate: 47,
  alternateSave: 1049,
  bracketed: 2004,
} as const;
/** C0 controls that index without changing the column. */
const LINE_FEEDS: ReadonlySet<number> = new Set([VT.linefeed, VT.verticalTab, VT.formfeed]);

/** A screen owns two bounded grids and no transcript or executable capabilities. */
export class TerminalScreen {
  /** Cursor visibility is presentation state, never input authority. */
  public isCursorVisible = true;
  /** Negotiated paste mode used by the separate keyboard encoder. */
  public isBracketedPaste = false;
  /** Negotiated app cursor mode. */
  public isApplicationCursor = false;
  /** Primary grid retains bounded history. */
  private primary: TerminalGrid;
  /** Alternate grid has no scrollback. */
  private alternate: TerminalGrid;
  /** Selected display grid. */
  private active: TerminalGrid;
  /** Immutable current cell rendition. */
  private style: TerminalStyle = DEFAULT_TERMINAL_STYLE;
  /** Untrusted bounded OSC 8 link target. */
  private link: string | null = null;
  /** Inclusive scrolling region. */
  private top = 0;
  /** Inclusive scrolling region end. */
  private bottom: number;
  /** Deferred wrap after the rightmost cell. */
  private isWrapPending = false;
  /** DEC autowrap mode. */
  private isAutoWrap = true;
  /** Explicit cursor/rendition save. */
  private readonly saved = new WeakMap<TerminalGrid, SavedCursor>();
  /** Independent primary save for 1049 transitions. */
  private primarySave: SavedCursor = { x: 0, y: 0, style: DEFAULT_TERMINAL_STYLE };

  /**
   * Allocate bounded primary and alternate screens.
   *
   * @param columns - Requested columns.
   * @param rows - Requested rows.
   */
  public constructor(columns: number, rows: number) {
    this.primary = new TerminalGrid(columns, rows);
    this.alternate = new TerminalGrid(columns, rows, false);
    this.active = this.primary;
    this.bottom = this.active.rows - 1;
  }

  /**
   * Expose the current bounded display model.
   *
   * @returns Active primary or alternate grid.
   */
  public get grid(): TerminalGrid {
    return this.active;
  }

  /**
   * Apply completed tokens; unsupported OSC/DCS never execute side effects.
   *
   * @param actions - Parser-bounded action batch.
   */
  public apply(actions: readonly TerminalAction[]): void {
    for (const action of actions) {
      this.action(action);
    }
  }

  /**
   * Clip both grids and reset scroll region after native resize.
   *
   * @param columns - Requested columns.
   * @param rows - Requested rows.
   */
  public resize(columns: number, rows: number): void {
    this.primary.resize(columns, rows);
    this.alternate.resize(columns, rows);
    this.top = 0;
    this.bottom = this.active.rows - 1;
    this.isWrapPending = false;
  }

  /**
   * Reset visible screen and parser-independent mode state after replay loss.
   */
  public reset(): void {
    const { columns, rows } = this.active;
    this.primary = new TerminalGrid(columns, rows);
    this.alternate = new TerminalGrid(columns, rows, false);
    this.active = this.primary;
    this.top = 0;
    this.bottom = rows - 1;
    this.style = DEFAULT_TERMINAL_STYLE;
    this.link = null;
    this.isWrapPending = false;
    this.primarySave = { x: 0, y: 0, style: DEFAULT_TERMINAL_STYLE };
    this.isAutoWrap = true;
    this.isCursorVisible = true;
    this.isBracketedPaste = false;
    this.isApplicationCursor = false;
  }

  /**
   * Dispatch one parsed action without side effects beyond screen state.
   *
   * @param action - A completed bounded token.
   */
  private action(action: TerminalAction): void {
    switch (action.type) {
      case 'print': {
        this.print(action.text);
        break;
      }
      case 'execute': {
        this.execute(action.code);
        break;
      }
      case 'csi': {
        this.control(action);
        break;
      }
      case 'esc': {
        if (action.intermediates === '') {
          this.escape(action.final);
        }
        break;
      }
      case 'osc': {
        this.osc(action.data, action.truncated);
        break;
      }
      case 'dcs': {
        break;
      }
    }
  }

  /**
   * Move and cancel pending wrap.
   *
   * @param x - Zero-based column.
   * @param y - Zero-based row.
   */
  private move(x: number, y: number): void {
    this.isWrapPending = false;
    this.active.move(x, y);
  }

  /**
   * Advance within the scroll region while preserving the column.
   *
   * @param direction - Positive index or negative reverse-index.
   */
  private index(direction: 1 | -1): void {
    const { x, y } = this.active.cursor;
    const edge = direction > 0 ? this.bottom : this.top;
    if (y === edge) {
      this.active.scroll(this.top, this.bottom, direction);
      this.move(x, y);
    } else {
      this.move(x, y + direction);
    }
  }

  /**
   * Apply C0 controls without interpreting their text as commands.
   *
   * @param code - Parsed control byte.
   */
  private execute(code: number): void {
    const { x, y } = this.active.cursor;
    if (LINE_FEEDS.has(code)) {
      this.index(1);
      return;
    }
    switch (code) {
      case VT.carriageReturn: {
        this.move(0, y);
        break;
      }
      case VT.backspace: {
        this.move(x - 1, y);
        break;
      }
      case VT.tab: {
        this.move((Math.floor(x / VT.tabWidth) + 1) * VT.tabWidth, y);
        break;
      }
      // No default
    }
  }

  /**
   * Print bounded Unicode glyphs with deferred wrapping.
   *
   * @param text - Decoded printable run.
   */
  private print(text: string): void {
    for (const glyph of text) {
      const width = terminalWidth(glyph);
      if (width === 0) {
        this.combine(glyph);
        continue;
      }
      this.put(glyph, width);
    }
  }

  /**
   * Write one visible scalar, clearing intersected wide cells.
   *
   * @param glyph - Printable Unicode scalar.
   * @param width - One or two display columns.
   */
  private put(glyph: string, width: 1 | 2): void {
    if (
      this.isAutoWrap &&
      (this.isWrapPending || (width === VT.wide && this.active.cursor.x === this.active.columns - 1))
    ) {
      this.move(0, this.active.cursor.y);
      this.index(1);
    }
    const { x, y } = this.active.cursor;
    const line = this.active.lines[y];
    if (line === undefined) {
      return;
    }
    if (line[x]?.width === 0 && x > 0) {
      line[x - 1] = BLANK_CELL;
    }
    if (line[x]?.width === VT.wide && x + 1 < this.active.columns) {
      line[x + 1] = BLANK_CELL;
    }
    const actualWidth = width === VT.wide && x + 1 < this.active.columns ? VT.wide : 1;
    line[x] = { text: glyph, width: actualWidth, style: this.style, link: this.link };
    if (actualWidth === VT.wide) {
      line[x + 1] = { text: '', width: 0, style: this.style, link: this.link };
    }
    this.active.lines[y] = normalizeTerminalRow(line);
    this.active.move(x + actualWidth, y);
    this.isWrapPending = x + actualWidth >= this.active.columns;
  }

  /**
   * Attach a combining mark with a strict per-cell storage ceiling.
   *
   * @param glyph - One combining scalar.
   */
  private combine(glyph: string): void {
    const { x, y } = this.active.cursor;
    const line = this.active.lines[y];
    let column = this.isWrapPending ? x : Math.max(0, x - 1);
    if (line?.[column]?.width === 0) {
      column = Math.max(0, column - 1);
    }
    const prior = line?.[column];
    if (!(line !== undefined && prior !== undefined && prior.text.length + glyph.length <= VT.glyphLength)) {
      return;
    }

    line[column] = { ...prior, text: prior.text + glyph };
    this.active.dirty.add(y);
  }

  /**
   * Apply a supported ESC final.
   *
   * @param final - Parsed escape final.
   */
  private escape(final: string): void {
    const handlers: Record<string, () => void> = {
      D: () => {
        this.index(1);
      },
      E: () => {
        this.move(0, this.active.cursor.y);
        this.index(1);
      },
      M: () => {
        this.index(-1);
      },
      '7': () => {
        this.saved.set(this.active, { ...this.active.cursor, style: this.style });
      },
      '8': () => {
        const saved = this.saved.get(this.active) ?? { x: 0, y: 0, style: DEFAULT_TERMINAL_STYLE };
        this.move(saved.x, saved.y);
        this.style = saved.style;
      },
      c: () => {
        this.reset();
      },
    };
    handlers[final]?.();
  }

  /**
   * Dispatch bounded CSI operations without a large privileged interpreter.
   *
   * @param action - Parsed control sequence.
   */
  private control(action: Control): void {
    if (action.prefix === '?') {
      this.mode(action);
      return;
    }
    if (action.prefix !== '' || action.intermediates !== '') {
      return;
    }
    const { x, y } = this.active.cursor;
    const amount = Math.max(1, action.params[0] ?? 1);
    const row = Math.max(1, action.params[0] ?? 1) - 1;
    const column = Math.max(1, action.params[1] ?? 1) - 1;
    const handlers: Record<string, () => void> = {
      A: () => {
        this.move(x, y - amount);
      },
      B: () => {
        this.move(x, y + amount);
      },
      C: () => {
        this.move(x + amount, y);
      },
      D: () => {
        this.move(x - amount, y);
      },
      E: () => {
        this.move(0, y + amount);
      },
      F: () => {
        this.move(0, y - amount);
      },
      G: () => {
        this.move(row, y);
      },
      '`': () => {
        this.move(row, y);
      },
      d: () => {
        this.move(x, row);
      },
      H: () => {
        this.move(column, row);
      },
      f: () => {
        this.move(column, row);
      },
      J: () => {
        this.erase(action.params[0] ?? 0, true);
      },
      K: () => {
        this.erase(action.params[0] ?? 0, false);
      },
      '@': () => {
        this.characters(amount, true);
      },
      P: () => {
        this.characters(amount, false);
      },
      X: () => {
        this.fill(y, x, x + amount);
      },
      L: () => {
        this.lines(-amount);
      },
      M: () => {
        this.lines(amount);
      },
      S: () => {
        this.active.scroll(this.top, this.bottom, amount);
      },
      T: () => {
        this.active.scroll(this.top, this.bottom, -amount);
      },
      r: () => {
        this.region(row, action.params[1]);
      },
      s: () => {
        this.escape('7');
      },
      u: () => {
        this.escape('8');
      },
      m: () => {
        this.style = terminalStyle(this.style, action.params, action.subparameters);
      },
    };
    handlers[action.final]?.();
  }

  /**
   * Erase visible cells without interpreting saved output as markup.
   *
   * @param mode - ED/EL parameter.
   * @param isDisplay - Whole display versus current line.
   */
  private erase(mode: number, isDisplay: boolean): void {
    const { x, y } = this.active.cursor;
    if (isDisplay && mode === VT.eraseHistory) {
      this.active.history.length = 0;
      return;
    }
    if (mode === VT.eraseAll) {
      this.eraseAll(isDisplay);
      return;
    }
    if (mode !== 0 && mode !== 1) {
      return;
    }
    const isAfter = mode === 0;
    this.fill(y, isAfter ? x : 0, isAfter ? this.active.columns : x + 1);
    if (isDisplay) {
      this.fillRows(isAfter ? y + 1 : 0, (isAfter ? this.active.rows : y) - 1);
    }
  }

  /**
   * Erase a whole display or the current line.
   *
   * @param isDisplay - Whole display versus current line.
   */
  private eraseAll(isDisplay: boolean): void {
    const { y } = this.active.cursor;
    this.fillRows(isDisplay ? 0 : y, isDisplay ? this.active.rows - 1 : y);
  }

  /**
   * Erase a bounded inclusive row range.
   *
   * @param first - First row.
   * @param last - Last row.
   */
  private fillRows(first: number, last: number): void {
    for (let row = first; row <= last; row += 1) {
      this.fill(row, 0, this.active.columns);
    }
  }

  /**
   * Fill a bounded interval using a blank current rendition.
   *
   * @param row - Visible row.
   * @param start - Inclusive column.
   * @param end - Exclusive column.
   */
  private fill(row: number, start: number, end: number): void {
    const line = this.active.lines[row];
    line?.fill({ ...BLANK_CELL, style: this.style }, Math.max(0, start), Math.min(end, this.active.columns));
    if (line !== undefined) {
      this.active.lines[row] = normalizeTerminalRow(line);
    }
    this.active.dirty.add(row);
  }

  /**
   * Insert or delete characters without expanding the row.
   *
   * @param amount - Requested count, clamped before allocation.
   * @param isInsert - Insert versus delete.
   */
  private characters(amount: number, isInsert: boolean): void {
    const { x, y } = this.active.cursor;
    const line = this.active.lines[y];
    if (line === undefined) {
      return;
    }
    const count = Math.min(amount, this.active.columns - x);
    const blanks: TerminalCell[] = Array.from({ length: count }, () => ({ ...BLANK_CELL, style: this.style }));
    if (isInsert) {
      line.splice(x, 0, ...blanks);
      line.length = this.active.columns;
    } else {
      line.splice(x, count);
      line.push(...blanks);
    }
    this.active.lines[y] = normalizeTerminalRow(line);
    this.active.dirty.add(y);
    this.isWrapPending = false;
  }

  /**
   * Insert/delete lines only inside the active scroll region.
   *
   * @param count - Positive delete, negative insert.
   */
  private lines(count: number): void {
    const { y } = this.active.cursor;
    if (y >= this.top && y <= this.bottom) {
      this.active.scroll(y, this.bottom, count, false);
    }
  }

  /**
   * Validate a scroll region before moving the cursor home.
   *
   * @param top - Zero-based first row.
   * @param end - Optional one-based bottom row.
   */
  private region(top: number, end: number | undefined): void {
    const bottom = (end === undefined || end <= 0 ? this.active.rows : end) - 1;
    if (top < 0 || top >= bottom || bottom >= this.active.rows) {
      return;
    }
    this.top = top;
    this.bottom = bottom;
    this.move(0, 0);
  }

  /**
   * Apply only explicit DEC private modes.
   *
   * @param action - Parsed bounded private sequence.
   */
  private mode(action: Control): void {
    if (action.final !== 'h' && action.final !== 'l') {
      return;
    }
    const isEnabled = action.final === 'h';
    for (const value of action.params) {
      const flags: Record<number, () => void> = {
        [VT.cursor]: () => {
          this.isCursorVisible = isEnabled;
          this.active.dirty.add(this.active.cursor.y);
        },
        [VT.wrap]: () => {
          this.isAutoWrap = isEnabled;
          this.isWrapPending = false;
        },
        [VT.bracketed]: () => {
          this.isBracketedPaste = isEnabled;
        },
        [VT.application]: () => {
          this.isApplicationCursor = isEnabled;
        },
        [VT.alternate]: () => {
          this.selectAlternate(isEnabled, false);
        },
        [VT.alternateSave]: () => {
          this.selectAlternate(isEnabled, true);
        },
      };
      flags[value]?.();
    }
  }

  /**
   * Switch independent primary/alternate grids without losing primary state.
   *
   * @param isEnabled - Enter alternate display.
   * @param shouldSave - 1049 clears and restores a separate primary save point.
   */
  private selectAlternate(isEnabled: boolean, shouldSave: boolean): void {
    if (isEnabled === (this.active === this.alternate)) {
      return;
    }
    if (isEnabled && shouldSave) {
      this.primarySave = { ...this.primary.cursor, style: this.style };
      this.alternate = new TerminalGrid(this.primary.columns, this.primary.rows, false);
    }
    this.active = isEnabled ? this.alternate : this.primary;
    if (!isEnabled && shouldSave) {
      this.active.move(this.primarySave.x, this.primarySave.y);
      this.style = this.primarySave.style;
    }
    this.top = 0;
    this.bottom = this.active.rows - 1;
    this.isWrapPending = false;
    this.active.invalidate();
  }

  /**
   * Retain only OSC 8 targets as untrusted data; ignore titles/clipboard/control OSC.
   *
   * @param data - Bounded parsed payload.
   * @param isTruncated - Over-cap payloads must never become active links.
   */
  private osc(data: string, isTruncated: boolean): void {
    if (!data.startsWith('8;')) {
      return;
    }
    const separator = data.indexOf(';', VT.wide);
    this.link = isTruncated || separator === -1 || separator === data.length - 1 ? null : data.slice(separator + 1);
  }
}
