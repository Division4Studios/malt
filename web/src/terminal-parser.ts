/**
 * Chunk-safe VT escape-sequence tokenizer. Pure state machine: no DOM, no screen
 * state. Bytes or strings may be split anywhere; results are identical once adjacent
 * `print` actions are concatenated. Every buffer is capped, so hostile input cannot
 * grow memory. Colon sub-parameter boundaries are retained; C1 controls and
 * SOS/PM/APC strings are discarded.
 *
 * @file
 */

/** VT character classes and control bytes. */
const VT = {
  highSurrogateFirst: 55_296,
  highSurrogateLast: 56_319,
  cancel: 24,
  substitute: 26,
  escape: 27,
  space: 32,
  delete: 127,
  c1First: 128,
  c1Last: 159,
  intermediateLast: 47,
  digitFirst: 48,
  digitLast: 57,
  finalFirst: 64,
  finalLast: 126,
  prefixFirst: 60,
  prefixLast: 63,
  parameterLast: 59,
  bell: 7,
} as const;
/** Decimal parameter radix. */
const RADIX = 10;

/** Maximum retained numeric parameters; further ones are dropped. */
export const MAX_PARAMS = 16;
/** Maximum value of one numeric parameter (larger values clamp). */
export const MAX_PARAM_VALUE = 65_535;
/** Maximum intermediate characters before a sequence is ignored. */
export const MAX_INTERMEDIATES = 2;
/** Maximum retained characters of an OSC payload. */
export const MAX_OSC_LENGTH = 4096;
/** Maximum retained characters of a DCS payload. */
export const MAX_DCS_LENGTH = 4096;

/** One tokenized terminal action. */
export type TerminalAction =
  | { type: 'print'; text: string }
  | { type: 'execute'; code: number }
  | { type: 'esc'; intermediates: string; final: string }
  | { type: 'csi'; prefix: string; params: number[]; subparameters?: number[]; intermediates: string; final: string }
  | { type: 'osc'; data: string; truncated: boolean }
  | {
      type: 'dcs';
      prefix: string;
      params: number[];
      intermediates: string;
      final: string;
      data: string;
      truncated: boolean;
    };

/** Finite parser states; string payload states are bounded separately. */
type State =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'escapeIgnore'
  | 'csi'
  | 'csiIgnore'
  | 'osc'
  | 'dcsEntry'
  | 'dcsPassthrough'
  | 'ignoreString';

/**
 * Test the printable VT character classes without consuming controls.
 *
 * @param ch - One Unicode character.
 * @returns Whether it is ordinary printable text.
 */
function isPrintable(ch: string): boolean {
  return ch > '\u{9F}' || (ch >= ' ' && ch < '\u{7F}');
}

/** Incremental parser; retained partial sequences are bounded. */
export class TerminalParser {
  /** Current finite parser state. */
  private state: State = 'ground';
  /** Streaming UTF-8 decoder, shared only within this parser. */
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  /** At most one trailing UTF-16 high surrogate. */
  private carry = '';
  /** At most one private CSI prefix. */
  private prefix = '';
  /** Bounded intermediate character buffer. */
  private intermediates = '';
  /** Bounded numeric parameter list. */
  private params: number[] = [];
  /** Indices belonging to a colon group, bounded by the parameter ceiling. */
  private subparameters: number[] = [];
  /** Current clamped numeric parameter, or omitted sentinel. */
  private current = -1;
  /** Bounded OSC/DCS payload. */
  private data = '';
  /** Whether the current string payload exceeded its cap. */
  private truncated = false;
  /** DCS final byte retained until string termination. */
  private dcsFinal = '';
  /** Whether an ESC backslash belongs to the completed string. */
  private swallowTerminator = false;

  /**
   * Tokenize one chunk.
   *
   * @param chunk - UTF-8 bytes (multi-byte characters may split) or text.
   * @returns Actions completed by this chunk; partial sequences are retained.
   */
  public feed(chunk: Uint8Array | string): TerminalAction[] {
    let text =
      typeof chunk === 'string'
        ? this.carry + this.decoder.decode() + chunk
        : this.carry + this.decoder.decode(chunk, { stream: true });
    this.carry = '';
    const last = text.codePointAt(text.length - 1) ?? 0;
    if (last >= VT.highSurrogateFirst && last <= VT.highSurrogateLast) {
      this.carry = text.slice(-1);
      text = text.slice(0, -1);
    }
    const out: TerminalAction[] = [];
    let run = '';
    for (const ch of text) {
      if (this.state === 'ground' && isPrintable(ch)) {
        run += ch;
        continue;
      }
      if (run !== '') {
        out.push({ type: 'print', text: run });
        run = '';
      }
      this.step(ch, out);
    }
    if (run !== '') {
      out.push({ type: 'print', text: run });
    }
    return out;
  }

  /** Clear partial sequence buffers. */
  private reset(): void {
    this.prefix = '';
    this.intermediates = '';
    this.params = [];
    this.subparameters = [];
    this.current = -1;
    this.data = '';
    this.truncated = false;
  }

  /** Append one clamped parameter while enforcing the count cap. */
  private pushParam(): void {
    if (this.params.length < MAX_PARAMS) {
      this.params.push(this.current);
    }
    this.current = -1;
  }

  /**
   * Finish the current parameter list.
   *
   * @returns Bounded omitted-or-numeric parameters.
   */
  private finishParams(): number[] {
    if (this.current >= 0 || this.params.length > 0) {
      this.pushParam();
    }
    return this.params;
  }

  /**
   * Emit a completed bounded string token.
   *
   * @param out - Output actions for this chunk.
   */
  private finishString(out: TerminalAction[]): void {
    if (this.state === 'osc') {
      out.push({ type: 'osc', data: this.data, truncated: this.truncated });
    } else if (this.state === 'dcsPassthrough') {
      out.push({
        type: 'dcs',
        prefix: this.prefix,
        params: this.params,
        intermediates: this.intermediates,
        final: this.dcsFinal,
        data: this.data,
        truncated: this.truncated,
      });
    }
  }

  /**
   * Apply universal escape, cancellation and control transitions.
   *
   * @param ch - One Unicode character.
   * @param out - Completed actions.
   */
  private step(ch: string, out: TerminalAction[]): void {
    const code = ch.codePointAt(0) ?? 0;
    const isSwallow = this.swallowTerminator;
    this.swallowTerminator = false;
    if (code === VT.cancel || code === VT.substitute) {
      this.state = 'ground';
      this.reset();
      return;
    }
    const isInString = ['osc', 'dcsPassthrough', 'ignoreString'].includes(this.state);
    if (code === VT.escape) {
      if (isInString) {
        this.finishString(out);
        this.swallowTerminator = true;
      }
      this.reset();
      this.state = 'escape';
      return;
    }
    if (code === VT.delete || (code >= VT.c1First && code <= VT.c1Last)) {
      return;
    }
    if (isInString) {
      this.stringChar(ch, code, out);
      return;
    }
    if (code < VT.space) {
      out.push({ type: 'execute', code });
      return;
    }
    this.dispatch(ch, code, isSwallow, out);
  }

  /**
   * Dispatch finite sequence-state handling.
   *
   * @param ch - One Unicode character.
   * @param code - Numeric code point.
   * @param isSwallow - Whether a string terminator was seen.
   * @param out - Completed actions.
   */
  private dispatch(ch: string, code: number, isSwallow: boolean, out: TerminalAction[]): void {
    switch (this.state) {
      case 'escape': {
        this.escapeChar(ch, code, isSwallow, out);
        return;
      }
      case 'escapeIntermediate': {
        if (code <= VT.intermediateLast) {
          this.addIntermediate(ch, 'escapeIgnore');
        } else {
          this.emitEsc(ch, out);
        }
        return;
      }
      case 'escapeIgnore': {
        if (code >= VT.digitFirst) {
          this.state = 'ground';
        }
        return;
      }
      case 'csi': {
        this.csiChar(ch, code, out);
        return;
      }
      case 'csiIgnore': {
        if (code >= VT.finalFirst && code <= VT.finalLast) {
          this.state = 'ground';
        }
        return;
      }
      case 'dcsEntry': {
        this.dcsChar(ch, code);
        break;
      }
      case 'ground':
      case 'osc':
      case 'ignoreString':
      case 'dcsPassthrough':
    }
  }

  /**
   * Append an intermediate or enter the bounded ignore state.
   *
   * @param ch - Current intermediate.
   * @param overflow - State used after overflow.
   */
  private addIntermediate(ch: string, overflow: State): void {
    if (this.intermediates.length >= MAX_INTERMEDIATES) {
      this.state = overflow;
    } else {
      this.intermediates += ch;
    }
  }

  /**
   * Finish an escape sequence and return to ground.
   *
   * @param ch - Escape final.
   * @param out - Completed actions.
   */
  private emitEsc(ch: string, out: TerminalAction[]): void {
    out.push({ type: 'esc', intermediates: this.intermediates, final: ch });
    this.state = 'ground';
    this.reset();
  }

  /**
   * Recognize escape introducers and intermediate bytes.
   *
   * @param ch - Current character.
   * @param code - Numeric code point.
   * @param isSwallow - Whether this completes a string terminator.
   * @param out - Completed actions.
   */
  private escapeChar(ch: string, code: number, isSwallow: boolean, out: TerminalAction[]): void {
    switch (ch) {
      case '[': {
        this.state = 'csi';

        break;
      }
      case ']': {
        this.state = 'osc';

        break;
      }
      case 'P': {
        this.state = 'dcsEntry';

        break;
      }
      case 'X':
      case '^':
      case '_': {
        this.state = 'ignoreString';

        break;
      }
      default: {
        if (code <= VT.intermediateLast) {
          this.state = 'escapeIntermediate';
          this.intermediates = ch;
        } else if (isSwallow && ch === '\\') {
          this.state = 'ground';
        } else {
          this.emitEsc(ch, out);
        }
      }
    }
  }

  /**
   * Accumulate a bounded decimal parameter.
   *
   * @param ch - Current character.
   * @param code - Numeric code point.
   * @returns Whether it was a parameter character.
   */
  private paramChar(ch: string, code: number): boolean {
    if (code >= VT.digitFirst && code <= VT.digitLast) {
      const base = Math.max(this.current, 0);
      this.current = Math.min(MAX_PARAM_VALUE, base * RADIX + (code - VT.digitFirst));
      return true;
    }
    if (ch === ';' || ch === ':') {
      this.pushParam();
      if (ch === ':' && this.params.length < MAX_PARAMS) {
        this.subparameters.push(this.params.length);
      }
      return true;
    }
    return false;
  }

  /**
   * Accept one private prefix before numeric parameters.
   *
   * @param ch - Prefix character.
   * @param overflow - State used for malformed repeated prefixes.
   */
  private takePrefix(ch: string, overflow: State): void {
    if (this.params.length === 0 && this.current < 0 && this.intermediates === '' && this.prefix === '') {
      this.prefix = ch;
    } else {
      this.state = overflow;
    }
  }

  /**
   * Accumulate or finish a control sequence.
   *
   * @param ch - Current character.
   * @param code - Numeric code point.
   * @param out - Completed actions.
   */
  private csiChar(ch: string, code: number, out: TerminalAction[]): void {
    if (code >= VT.prefixFirst && code <= VT.prefixLast) {
      this.takePrefix(ch, 'csiIgnore');
    } else if (code >= VT.digitFirst && code <= VT.parameterLast) {
      this.paramChar(ch, code);
      if (this.intermediates !== '') {
        this.state = 'csiIgnore';
      }
    } else if (code >= VT.space && code <= VT.intermediateLast) {
      this.addIntermediate(ch, 'csiIgnore');
    } else {
      out.push({
        type: 'csi',
        prefix: this.prefix,
        params: this.finishParams(),
        ...(this.subparameters.length > 0 && { subparameters: this.subparameters }),
        intermediates: this.intermediates,
        final: ch,
      });
      this.state = 'ground';
      this.reset();
    }
  }

  /**
   * Accumulate a device-control-string header.
   *
   * @param ch - Current character.
   * @param code - Numeric code point.
   */
  private dcsChar(ch: string, code: number): void {
    if (code >= VT.prefixFirst && code <= VT.prefixLast) {
      this.takePrefix(ch, 'ignoreString');
    } else if (code >= VT.digitFirst && code <= VT.parameterLast) {
      this.paramChar(ch, code);
      if (this.intermediates !== '') {
        this.state = 'ignoreString';
      }
    } else if (code >= VT.space && code <= VT.intermediateLast) {
      this.addIntermediate(ch, 'ignoreString');
    } else {
      this.params = this.finishParams();
      this.dcsFinal = ch;
      this.state = 'dcsPassthrough';
    }
  }

  /**
   * Retain bounded OSC/DCS payload and recognize BEL.
   *
   * @param ch - Current character.
   * @param code - Numeric code point.
   * @param out - Completed actions.
   */
  private stringChar(ch: string, code: number, out: TerminalAction[]): void {
    if (code === VT.bell && this.state === 'osc') {
      this.finishString(out);
      this.state = 'ground';
      this.reset();
      return;
    }
    if (this.state === 'ignoreString') {
      return;
    }
    const limit = this.state === 'osc' ? MAX_OSC_LENGTH : MAX_DCS_LENGTH;
    if (this.data.length + ch.length <= limit) {
      this.data += ch;
    } else {
      this.truncated = true;
    }
  }
}
