/**
 * Static WCAG 2.2 AA guarantees for the console: theme text contrast in both
 * themes, a global reduced-motion rule, visible focus wherever an outline is
 * removed, view stylesheets that use theme tokens instead of fixed dark
 * colours, and accessible names for every shell control and every
 * script-built dialog.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

/** Minimum contrast for normal text (WCAG 1.4.3). */
const TEXT_CONTRAST = 4.5;
/** Text colour tokens. */
const FOREGROUNDS = ['text', 'muted', 'subtle', 'cyan', 'violet', 'green', 'red', 'amber'];
/** Surfaces text appears on. */
const BACKGROUNDS = ['bg', 'surface', 'raised', 'panel', 'rail', 'column', 'input-bg', 'node-bg', 'well-bg'];
/** Pairs beyond the general grid: specific text on its specific surface. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['error-text', 'error-bg'],
  ['text', 'error-bg'],
  ['on-accent', 'cyan'],
  ['on-accent', 'violet'],
  ['muted', 'chip-bg'],
];
/** Console stylesheets other than the main one. */
const VIEW_STYLESHEETS = ['board.css', 'workflows.css', 'sessions.css'];
/** Web folder. */
const WEB = path.resolve('web');

/** The console's main stylesheet. */
const STYLE = await readFile(path.join('web', 'style.css'), 'utf8');

/**
 * Custom properties declared in one rule block.
 *
 * @param selector - Exact selector text opening the block, with its indentation.
 * @returns Token name to colour.
 */
function tokens(selector: string): Map<string, string> {
  const start = STYLE.indexOf(`${selector} {`);
  assert.ok(start !== -1, `${selector} block exists`);
  const declarations = STYLE.slice(start, STYLE.indexOf('}', start)).split(';');
  const found = new Map<string, string>();
  for (const declaration of declarations) {
    const [name = '', value = ''] = declaration.trim().split(':', 2);
    if (name.startsWith('--') && value.trimStart().startsWith('#')) {
      found.set(name.slice(2), value.trim());
    }
  }
  return found;
}

/**
 * Relative luminance of an opaque `#rrggbb` colour; an alpha suffix is ignored.
 *
 * @param hex - Colour.
 * @returns Luminance from 0 to 1.
 */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * WCAG contrast ratio of two colours.
 *
 * @param first - One colour.
 * @param second - The other colour.
 * @returns Ratio from 1 to 21.
 */
function contrast(first: string, second: string): number {
  const [low = 0, high = 0] = [luminance(first), luminance(second)].toSorted((left, right) => left - right);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Text and surface pairs failing the text contrast minimum in one theme.
 *
 * @param theme - Theme name for messages.
 * @param colours - Its tokens.
 * @returns Failure descriptions.
 */
function contrastFailures(theme: string, colours: ReadonlyMap<string, string>): string[] {
  const pairs: (readonly [string, string])[] = FOREGROUNDS.flatMap((foreground) =>
    BACKGROUNDS.map((background) => [foreground, background] as const),
  );
  pairs.push(...PAIRS);
  const failures: string[] = [];
  for (const [foreground, background] of pairs) {
    const text = colours.get(foreground);
    const surface = colours.get(background);
    assert.ok(text !== undefined && surface !== undefined, `${theme} defines --${foreground} and --${background}`);
    const ratio = contrast(text, surface);
    if (ratio < TEXT_CONTRAST) {
      failures.push(`${theme}: --${foreground} on --${background} is ${ratio.toFixed(2)}:1`);
    }
  }
  return failures;
}

/**
 * A theme's tokens over the dark defaults.
 *
 * @param base - Default tokens.
 * @param theme - Tokens the theme redefines.
 * @returns Combined tokens.
 */
function overlay(base: ReadonlyMap<string, string>, theme: ReadonlyMap<string, string>): Map<string, string> {
  const combined = new Map(base);
  for (const [name, value] of theme) {
    combined.set(name, value);
  }
  return combined;
}

/**
 * One file in the web folder.
 *
 * @param parts - Path below `web`.
 * @returns Its text.
 */
async function webFile(...parts: string[]): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed console sources inside this repository.
  return readFile(path.join(WEB, ...parts), 'utf8');
}

/**
 * CSS rules as selector and body pairs.
 *
 * @param css - Stylesheet text.
 * @returns Rules in order; at-rule wrappers are left in the selector text.
 */
function rules(css: string): { selector: string; body: string }[] {
  return css.split('}').map((chunk) => {
    const open = chunk.lastIndexOf('{');
    return { selector: chunk.slice(0, Math.max(open, 0)).trim(), body: chunk.slice(open + 1) };
  });
}

/**
 * Start tags of one element name in an HTML document.
 *
 * @param html - Document text.
 * @param tag - Element name.
 * @returns Each start tag's text and position.
 */
function startTags(html: string, tag: string): { text: string; at: number }[] {
  const found: { text: string; at: number }[] = [];
  for (let at = html.indexOf(`<${tag}`); at !== -1; at = html.indexOf(`<${tag}`, at + 1)) {
    const next = html[at + tag.length + 1] ?? '';
    if ([' ', '>', '\n'].includes(next)) {
      found.push({ text: html.slice(at, html.indexOf('>', at) + 1), at });
    }
  }
  return found;
}

/**
 * Whether a shell form control has an accessible name.
 *
 * @param html - Shell document.
 * @param control - The control's start tag and position.
 * @param control.text - Start tag text.
 * @param control.at - Its position in the document.
 * @returns True when a label, wrapping label or ARIA name names it.
 */
function isLabelledControl(html: string, control: { text: string; at: number }): boolean {
  const id = control.text.split(' id="', 2)[1]?.split('"', 1)[0];
  const isForLabel = id !== undefined && html.includes(`for="${id}"`);
  const before = html.slice(0, control.at);
  const isWrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
  return isForLabel || isWrapped || control.text.includes('aria-label') || control.text.includes('type="hidden"');
}

await test('theme text meets 4.5:1 on every surface in dark, system-light and chosen-light themes', () => {
  const dark = tokens(':root');
  const systemLight = overlay(dark, tokens("  :root:not([data-theme='dark'])"));
  const chosenLight = overlay(dark, tokens(":root[data-theme='light']"));
  const failures = [
    contrastFailures('dark', dark),
    contrastFailures('system light', systemLight),
    contrastFailures('light', chosenLight),
  ].flat();
  assert.deepEqual(failures, []);
});

await test('reduced motion turns off every animation and transition, and removed outlines have a visible replacement', async () => {
  const reduced = rules(STYLE).find(
    (rule) => rule.selector.includes('prefers-reduced-motion: reduce') && rule.selector.endsWith('*::after'),
  );
  assert.ok(reduced?.body.includes('animation: none !important') === true);
  assert.ok(reduced.body.includes('transition: none !important'));
  const sheets = await Promise.all(['style.css', ...VIEW_STYLESHEETS].map(async (name) => webFile(name)));
  const css = sheets.join('\n');
  for (const rule of rules(css)) {
    if (!(rule.body.includes('outline: none') || rule.body.includes('outline: 0;'))) {
      continue;
    }

    const base = rule.selector.split(':focus-visible', 1)[0] ?? rule.selector;
    assert.ok(
      css.includes(`${base}:focus-visible`) || css.includes(`:has(${base}:focus-visible)`),
      `${rule.selector} replaces its outline with a visible focus style`,
    );
  }
});

await test('view stylesheets take surface and text colours from theme tokens', async () => {
  const sheets = await Promise.all(VIEW_STYLESHEETS.map(async (name) => webFile(name)));
  for (const [index, css] of sheets.entries()) {
    const fixed = css.split('\n').filter((line) => {
      const declaration = line.trim();
      return (declaration.startsWith('background:') || declaration.startsWith('color:')) && declaration.includes('#');
    });
    assert.deepEqual(fixed, [], `${VIEW_STYLESHEETS[index] ?? ''} uses theme tokens for backgrounds and text`);
  }
});

await test('every shell control has an accessible name and every script-built dialog is labelled', async () => {
  const shell = await webFile('index.html');
  assert.ok(shell.includes('<html lang="'));
  const controls = ['input', 'select', 'textarea'].flatMap((tag) => startTags(shell, tag));
  for (const control of controls) {
    assert.ok(isLabelledControl(shell, control), `${control.text} has a label`);
  }
  for (const control of startTags(shell, 'button')) {
    const content = shell.slice(control.at + control.text.length, shell.indexOf('</button>', control.at));
    const visible = content
      .split('<')
      .map((part) => part.slice(part.indexOf('>') + 1))
      .join('')
      .trim();
    assert.ok(visible !== '' || control.text.includes('aria-label'), `${control.text} has a name`);
  }
  const folder = path.join(WEB, 'src');
  const names = (await readdir(folder)).filter((name) => name.endsWith('.ts'));
  const sources = await Promise.all(names.map(async (name) => webFile('src', name)));
  for (const [index, source] of sources.entries()) {
    if (source.includes("element('dialog'")) {
      assert.ok(source.includes("setAttribute('aria-labelledby'"), `${names[index] ?? ''} labels the dialog it builds`);
    }
  }
});
