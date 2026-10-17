/**
 * List every English message the console can show, so the catalog test can
 * prove each one has a Simplified Chinese translation and no translation is
 * stale. Messages are the literal first argument of `t(...)` (both branches
 * of a literal ternary count), `phrase(...)` and `notice(...)` in
 * `web/src`, and the text and text attributes of the static shell in
 * `web/index.html`. Run directly to print the keys as JSON.
 *
 * @file
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Calls whose first argument is an English message. */
const MESSAGE_CALLS = /(?<![\w$.])(?<name>notice|phrase|t)\(/gv;
/** Shell text attributes the console translates. */
const SHELL_ATTRIBUTES = /\s(?:alt|aria-label|placeholder|title)="(?<value>[^"]*)"/gv;
/** Shell text that is a brand or a symbol, never translated. */
const UNTRANSLATED = new Set(['MALT']);
/** Characters after which a literal is a message: the argument start or a ternary branch. */
const MESSAGE_POSITIONS = new Set(['(', '?', ':']);
/** Characters that open a nested group inside a call argument, with their closers. */
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
/** Fixed console sources; the catalog modules themselves hold no messages. */
const WEB_SOURCE = path.resolve(import.meta.dirname, '..', 'web', 'src');
/** Fixed console shell. */
const SHELL = path.resolve(import.meta.dirname, '..', 'web', 'index.html');

/**
 * Read one quoted literal starting at `start`.
 *
 * @param source - TypeScript text.
 * @param start - Index of the opening quote.
 * @returns Decoded value and the index after the closing quote.
 */
function readQuoted(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let value = '';
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\') {
      const escaped = source[index + 1] ?? '';
      value += escaped === 'n' ? '\n' : escaped;
      index += 2;
    } else {
      value += source[index] ?? '';
      index += 1;
    }
  }
  return { value, end: index + 1 };
}

/**
 * Skip a template literal, including its nested expressions.
 *
 * @param source - TypeScript text.
 * @param start - Index of the opening backtick.
 * @returns Index after the closing backtick.
 */
function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length && source[index] !== '`') {
    if (source[index] === '\\') {
      index += 2;
    } else if (source.startsWith('${', index)) {
      index = skipGroup(source, index + 1, '}');
    } else {
      index += 1;
    }
  }
  return index + 1;
}

/**
 * Skip a bracketed group, honouring strings and templates inside it.
 *
 * @param source - TypeScript text.
 * @param start - Index of the opening bracket.
 * @param close - Its closing bracket.
 * @returns Index after the closing bracket.
 */
function skipGroup(source: string, start: number, close: string): number {
  let index = start + 1;
  while (index < source.length && source[index] !== close) {
    index = skipToken(source, index);
  }
  return index + 1;
}

/**
 * Skip one string, template, group or character.
 *
 * @param source - TypeScript text.
 * @param index - Current index.
 * @returns Index after the token.
 */
function skipToken(source: string, index: number): number {
  const character = source[index] ?? '';
  if (character === "'" || character === '"') {
    return readQuoted(source, index).end;
  }
  if (character === '`') {
    return skipTemplate(source, index);
  }
  const close = OPENERS[character];
  return close === undefined ? index + 1 : skipGroup(source, index, close);
}

/**
 * The literals that make up a call's first argument: one literal, or the
 * literal branches of a ternary. Dynamic arguments contribute nothing.
 *
 * @param source - TypeScript text.
 * @param start - Index just after the call's opening parenthesis.
 * @returns English messages in the first argument.
 */
function firstArgumentLiterals(source: string, start: number): string[] {
  const literals: string[] = [];
  let index = start;
  let previous = '(';
  while (index < source.length && source[index] !== ',' && source[index] !== ')') {
    const character = source[index] ?? '';
    if (character === "'") {
      const quoted = readQuoted(source, index);
      if (MESSAGE_POSITIONS.has(previous)) {
        literals.push(quoted.value);
      }
      previous = "'";
      index = quoted.end;
    } else {
      if (character.trim() !== '') {
        previous = character;
      }
      index = skipToken(source, index);
    }
  }
  return literals;
}

/**
 * Messages in one TypeScript module.
 *
 * @param source - Module text.
 * @returns English messages it passes to the catalog.
 */
export function moduleMessages(source: string): string[] {
  const messages: string[] = [];
  for (const match of source.matchAll(MESSAGE_CALLS)) {
    const literals = firstArgumentLiterals(source, match.index + match[0].length);
    messages.push(...(match.groups?.['name'] === 'notice' ? literals.slice(0, 1) : literals));
  }
  return messages;
}

/**
 * Text the static shell shows: text nodes and text attributes, whitespace
 * collapsed the way the console looks them up.
 *
 * @param html - Shell markup.
 * @returns English shell messages.
 */
export function shellMessages(html: string): string[] {
  const body = html.slice(html.indexOf('<body')).replaceAll(/<code>[^<]*<\/code>/gv, ' ');
  const texts = body
    .split('<')
    .map((part) => part.slice(part.indexOf('>') + 1))
    .filter((part) => part !== '');
  const attributes = body
    .matchAll(SHELL_ATTRIBUTES)
    .map((match) => match.groups?.['value'] ?? '')
    .toArray();
  return [...texts, ...attributes]
    .map((text) => text.replaceAll(/\s+/gv, ' ').trim())
    .filter((text) => /\p{L}{2}/v.test(text) && !UNTRANSLATED.has(text));
}

/**
 * Every message the console can show, with the files that use it.
 *
 * @returns English messages mapped to the files that use them.
 */
export async function consoleMessages(): Promise<Map<string, string[]>> {
  const names = (await readdir(WEB_SOURCE))
    .filter((name) => name.endsWith('.ts') && !name.startsWith('catalog-'))
    .toSorted((left, right) => left.localeCompare(right));
  const found = new Map<string, string[]>();
  const add = (message: string, file: string): void => {
    found.set(message, [...(found.get(message) ?? []), file]);
  };
  const sources = await Promise.all(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only files listed in the fixed console source folder are read.
    names.map(async (name) => ({ name, source: await readFile(path.join(WEB_SOURCE, name), 'utf8') })),
  );
  for (const { name, source } of sources) {
    for (const message of moduleMessages(source)) {
      add(message, name);
    }
  }
  const shell = await readFile(SHELL, 'utf8');
  for (const message of shellMessages(shell)) {
    add(message, 'index.html');
  }
  return found;
}

if (import.meta.main) {
  const messages = await consoleMessages();
  process.stdout.write(`${JSON.stringify(Object.fromEntries(messages), null, 2)}\n`);
}
