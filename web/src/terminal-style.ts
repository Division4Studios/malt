/** @file Pure bounded SGR styling; terminal strings never become arbitrary CSS. */
/** Immutable styling copied into cells. */
export interface TerminalStyle {
  /** Validated palette or numeric RGB foreground, null for theme default. */
  readonly foreground: string | null;
  /** Validated palette or numeric RGB background, null for theme default. */
  readonly background: string | null;
  /** Bold intensity. */
  readonly bold: boolean;
  /** Dim intensity. */
  readonly dim: boolean;
  /** Italic face. */
  readonly italic: boolean;
  /** Underline decoration. */
  readonly underline: boolean;
  /** Swap foreground and background. */
  readonly inverse: boolean;
  /** Conceal glyphs without changing layout. */
  readonly concealed: boolean;
  /** Strike-through decoration. */
  readonly strike: boolean;
}
/** Shared immutable default. */
export const DEFAULT_TERMINAL_STYLE: TerminalStyle = Object.freeze({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  concealed: false,
  strike: false,
});
/** ANSI palette with readable muted dark-theme colors. */
const PALETTE = [
  '#19232d',
  '#f27386',
  '#78dca4',
  '#e9c884',
  '#81b8ff',
  '#c6a0f6',
  '#79dbde',
  '#dce5ee',
  '#748495',
  '#ff93a3',
  '#a3f2bd',
  '#ffe0a0',
  '#a3cfff',
  '#ddbcff',
  '#a3f1f2',
  '#ffffff',
] as const;
/** SGR wire values and palette dimensions. */
const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
  concealed: 8,
  strike: 9,
  normal: 22,
  plain: 23,
  noUnderline: 24,
  noInverse: 27,
  reveal: 28,
  noStrike: 29,
  foreground: 30,
  background: 40,
  color: 38,
  fill: 48,
  defaultColor: 39,
  defaultFill: 49,
  bright: 90,
  brightFill: 100,
  basicCount: 8,
  paletteCount: 16,
  cube: 6,
  grayStart: 232,
  grayBase: 8,
  grayStep: 10,
  cubeBase: 55,
  cubeStep: 40,
  maximum: 255,
  indexed: 5,
  rgb: 2,
  colorSpaceComponents: 5,
} as const;

/**
 * Clamp wire color components to safe numeric CSS values.
 *
 * @param value - Parsed parameter.
 * @returns One color channel.
 */
function channel(value: number): number {
  return Math.max(0, Math.min(SGR.maximum, value));
}

/**
 * Map a validated ANSI index to native CSS color.
 *
 * @param value - Parsed color index.
 * @returns Numeric color string, never terminal-provided CSS.
 */
function indexed(value: number): string {
  const index = channel(value);
  const basic = PALETTE[index];
  if (basic !== undefined) {
    return basic;
  }
  if (index >= SGR.grayStart) {
    const gray = SGR.grayBase + (index - SGR.grayStart) * SGR.grayStep;
    return `rgb(${String(gray)} ${String(gray)} ${String(gray)})`;
  }
  const cube = index - SGR.paletteCount;
  const components = [
    Math.floor(cube / (SGR.cube * SGR.cube)),
    Math.floor(cube / SGR.cube) % SGR.cube,
    cube % SGR.cube,
  ];
  return `rgb(${components.map((part) => String(part === 0 ? 0 : SGR.cubeBase + part * SGR.cubeStep)).join(' ')})`;
}

/**
 * Decode bounded extended-color parameters.
 *
 * @param parameters - Parsed SGR sequence.
 * @param offset - Extended-color introducer index.
 * @returns Validated color and number of additional consumed parameters.
 */
function extended(parameters: readonly number[], offset: number): { color: string | null; consumed: number } {
  const [mode, first, second, third] = parameters.slice(offset + 1);
  if (first !== undefined && mode === SGR.indexed) {
    return { color: indexed(first), consumed: 2 };
  }
  return first !== undefined && second !== undefined && third !== undefined && mode === SGR.rgb
    ? { color: `rgb(${String(channel(first))} ${String(channel(second))} ${String(channel(third))})`, consumed: 4 }
    : { color: null, consumed: Math.max(0, parameters.length - offset - 1) };
}

/**
 * Decode one colon-delimited color group without interpreting its members as SGR.
 *
 * @param parameters - Complete bounded parameter list.
 * @param offset - Group introducer index.
 * @param subparameters - Indices continuing the preceding colon group.
 * @returns Color and consumed group length; unsupported spaces preserve styling.
 */
function colonColor(
  parameters: readonly number[],
  offset: number,
  subparameters: readonly number[],
): { color: string | null; consumed: number } {
  let end = offset + 1;
  while (subparameters.includes(end)) {
    end += 1;
  }
  const group = parameters.slice(offset + 1, end);
  const [mode, space] = group;
  const hasSpace = mode === SGR.rgb && group.length === SGR.colorSpaceComponents;
  if (hasSpace && space !== -1 && space !== 0) {
    return { color: null, consumed: group.length };
  }
  const components = hasSpace ? group.slice(2) : group.slice(1);
  return { ...extended([0, mode ?? -1, ...components], 0), consumed: group.length };
}

/**
 * Apply one non-color SGR code; unknown codes preserve styling.
 *
 * @param style - Current immutable rendition.
 * @param code - Parsed rendition code.
 * @returns New immutable rendition.
 */
function rendition(style: TerminalStyle, code: number): TerminalStyle {
  const flags = new Map<number, Partial<TerminalStyle>>([
    [SGR.bold, { bold: true }],
    [SGR.dim, { dim: true }],
    [SGR.italic, { italic: true }],
    [SGR.underline, { underline: true }],
    [SGR.inverse, { inverse: true }],
    [SGR.concealed, { concealed: true }],
    [SGR.strike, { strike: true }],
    [SGR.normal, { bold: false, dim: false }],
    [SGR.plain, { italic: false }],
    [SGR.noUnderline, { underline: false }],
    [SGR.noInverse, { inverse: false }],
    [SGR.reveal, { concealed: false }],
    [SGR.noStrike, { strike: false }],
    [SGR.defaultColor, { foreground: null }],
    [SGR.defaultFill, { background: null }],
  ]);
  return code <= 0 ? DEFAULT_TERMINAL_STYLE : { ...style, ...flags.get(code) };
}

/**
 * Apply basic/bright palette codes or a non-color rendition.
 *
 * @param style - Prior immutable rendition.
 * @param code - Parsed SGR code.
 * @returns New immutable rendition.
 */
function basicColor(style: TerminalStyle, code: number): TerminalStyle {
  const ranges = [
    { first: SGR.foreground, field: 'foreground', offset: 0 },
    { first: SGR.background, field: 'background', offset: 0 },
    { first: SGR.bright, field: 'foreground', offset: SGR.basicCount },
    { first: SGR.brightFill, field: 'background', offset: SGR.basicCount },
  ] as const;
  const range = ranges.find((entry) => code >= entry.first && code < entry.first + SGR.basicCount);
  return range === undefined
    ? rendition(style, code)
    : { ...style, [range.field]: indexed(code - range.first + range.offset) };
}

/**
 * Update only a valid extended color; unsupported colon spaces preserve state.
 *
 * @param style - Existing rendition.
 * @param code - Foreground or background introducer.
 * @param color - Decoded value.
 * @param isColon - Whether the sequence is a grouped extended color.
 * @returns Immutable rendition.
 */
function applyColor(style: TerminalStyle, code: number, color: string | null, isColon: boolean): TerminalStyle {
  if (color === null && isColon) {
    return style;
  }
  return code === SGR.color ? { ...style, foreground: color } : { ...style, background: color };
}

/**
 * Apply SGR with bounded numeric palette/true-color support.
 *
 * @param current - Prior cell rendition.
 * @param parameters - Parser-bounded numeric parameters.
 * @param subparameters - Colon-group continuation indices, absent for legacy CSI.
 * @returns Updated rendition without DOM or external dependencies.
 */
export function terminalStyle(
  current: TerminalStyle,
  parameters: readonly number[],
  subparameters: readonly number[] = [],
): TerminalStyle {
  let style = current;
  const values = parameters.length === 0 ? [SGR.reset] : parameters;
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? SGR.reset;
    if (subparameters.includes(index)) {
      continue;
    }
    if (code === SGR.color || code === SGR.fill) {
      const isColon = subparameters.includes(index + 1);
      const result = isColon ? colonColor(values, index, subparameters) : extended(values, index);
      style = applyColor(style, code, result.color, isColon);
      index += result.consumed;
    } else {
      style = basicColor(style, code);
    }
  }
  return style;
}
