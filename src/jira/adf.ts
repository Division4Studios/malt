/**
 * Reading Atlassian Document Format, the rich text REST v3 returns for
 * descriptions and comments. MALT only needs plain text from it: every text
 * run for marker matching, and one line per block for an objective's brief.
 *
 * @file
 */

/** Inline nodes whose text belongs to the surrounding line. */
const INLINE_TYPES: ReadonlySet<string> = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'date']);

/**
 * A node's child list.
 *
 * @param node - Any ADF value.
 * @returns Its `content`, or none.
 */
function children(node: object): unknown[] {
  return 'content' in node && Array.isArray(node.content) ? node.content : [];
}

/**
 * A node's type name.
 *
 * @param node - Any ADF value.
 * @returns Its `type`, or empty.
 */
function typeOf(node: unknown): string {
  return typeof node === 'object' && node !== null && 'type' in node && typeof node.type === 'string' ? node.type : '';
}

/**
 * Every text run in an Atlassian Document Format node.
 *
 * @param node - Any ADF value.
 * @returns Its text, depth first.
 */
export function adfText(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const own = 'text' in node && typeof node.text === 'string' ? [node.text] : [];
  return [...own, ...children(node).flatMap((child) => adfText(child))];
}

/**
 * The text an inline node shows.
 *
 * @param node - Inline ADF node.
 * @returns Its text; a hard break is a newline.
 */
function inlineText(node: unknown): string {
  if (typeOf(node) === 'hardBreak') {
    return '\n';
  }
  if (typeof node !== 'object' || node === null) {
    return '';
  }
  if ('text' in node && typeof node.text === 'string') {
    return node.text;
  }
  const attributes = 'attrs' in node && typeof node.attrs === 'object' && node.attrs !== null ? node.attrs : {};
  for (const name of ['text', 'url', 'shortName']) {
    const value: unknown = Reflect.get(attributes, name);
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

/**
 * The lines of an ADF node: each block whose children are all inline is one line.
 *
 * @param node - Any ADF value.
 * @returns Lines, depth first.
 */
function lines(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const content = children(node);
  if (content.length === 0) {
    return [];
  }
  return content.every((child) => INLINE_TYPES.has(typeOf(child)))
    ? [content.map((child) => inlineText(child)).join('')]
    : content.flatMap((child) => lines(child));
}

/**
 * An ADF document as plain text, one line per paragraph, heading or list item.
 *
 * @param document - ADF document, or `null` when Jira has none.
 * @returns Plain text, empty for no document.
 */
export function adfPlainText(document: unknown): string {
  return lines(document)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');
}
