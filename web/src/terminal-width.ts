/** @file Bounded display-width classification for combining and common wide terminal glyphs. */
/** Wide character blocks used by native coding-agent interfaces. */
const WIDE = {
  hangulFirst: 4352,
  hangulLast: 4607,
  cjkFirst: 11_904,
  cjkLast: 42_159,
  hangulSyllableFirst: 44_032,
  hangulSyllableLast: 55_203,
  compatibilityFirst: 63_744,
  compatibilityLast: 64_255,
  fullFirst: 65_281,
  fullLast: 65_376,
  emojiFirst: 127_744,
  emojiLast: 129_791,
  extensionFirst: 131_072,
  extensionLast: 262_143,
} as const;

/**
 * Classify a Unicode scalar without retaining unbounded combining input.
 *
 * @param glyph - One decoded Unicode scalar.
 * @returns Zero for combining marks, otherwise one or two display columns.
 */
export function terminalWidth(glyph: string): 0 | 1 | 2 {
  if (glyph === '\u{200D}' || /\p{Mark}/v.test(glyph)) {
    return 0;
  }
  const point = glyph.codePointAt(0) ?? 0;
  const ranges = [
    [WIDE.hangulFirst, WIDE.hangulLast],
    [WIDE.cjkFirst, WIDE.cjkLast],
    [WIDE.hangulSyllableFirst, WIDE.hangulSyllableLast],
    [WIDE.compatibilityFirst, WIDE.compatibilityLast],
    [WIDE.fullFirst, WIDE.fullLast],
    [WIDE.emojiFirst, WIDE.emojiLast],
    [WIDE.extensionFirst, WIDE.extensionLast],
  ] as const;
  return ranges.some(([first, last]) => point >= first && point <= last) ? 2 : 1;
}
