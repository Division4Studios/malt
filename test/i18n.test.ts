/** @file The console catalog is complete, consistent and kept in step with the views; formatting follows the language. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { consoleMessages, moduleMessages, shellMessages } from '../scripts/i18n-keys.ts';
import { ZH_CN, ZH_PARTS } from '../web/dist/catalog-zh.js';
import {
  formatDateTime,
  formatLocale,
  formatMessage,
  phrase,
  resolveLocale,
  sourceOf,
  t,
  translated,
  useLocale,
} from '../web/dist/i18n.js';

/**
 * Modules that may build text without the catalog: dependency-free modules, the terminal emulator and the catalog
 * itself. The terminal workspace, pane and input controls are operator-facing and use the catalog.
 */
const UNCATALOGUED =
  /^(?:api|catalog-.*|diff-parse|freshness|history|i18n|terminal-(?:contract|grid|keys|parser|render|render-model|screen|stream|style|width|writes))\.ts$/v;
/** DOM-building patterns that would show hard-coded English instead of a translated message. */
const HARD_CODED = [
  /\.(?:ariaLabel|placeholder|textContent|title)\s*=\s*["'`]\p{Lu}\p{Ll}/v,
  /setAttribute\(\s*'(?:aria-label|placeholder|title)'\s*,\s*["'`]\p{L}{2}/v,
  /\belement\(\s*'[\w\-]+'\s*,\s*'[^']*'\s*,\s*["'`]\p{L}{2}/v,
  /\b(?:badge|button|checkbox|emptyState|field|labelled|tag)\(\s*["'`]\p{Lu}\p{Ll}/v,
];

/**
 * The bodies of the top-level brace groups in a text.
 *
 * @param text - Message text or a plural branch list.
 * @returns Text inside each outermost `{…}`.
 */
function braceGroups(text: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let body = '';
  for (const character of text) {
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        groups.push(body);
        body = '';
        continue;
      }
    }
    if (depth > 0) {
      body += character;
    }
    if (character === '{') {
      depth += 1;
    }
  }
  return groups;
}

/**
 * Placeholder names a message uses, including those inside plural branches.
 *
 * @param template - Message text.
 * @returns Sorted placeholder names.
 */
function placeholders(template: string): string[] {
  const names = new Set<string>();
  for (const body of braceGroups(template)) {
    const [name = '', kind = '', ...rest] = body.split(',');
    names.add(name.trim());
    if (kind.trim() !== 'plural') {
      continue;
    }
    const branches = braceGroups(rest.join(','));
    for (const branch of branches) {
      for (const nested of placeholders(branch)) {
        names.add(nested);
      }
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

await test('every console message has a Simplified Chinese translation with the same placeholders', async () => {
  const messages = await consoleMessages();
  assert.ok(messages.size > 1000, 'the extractor finds the console’s messages');
  const missing = messages
    .keys()
    .filter((key) => ZH_CN[key] === undefined)
    .toArray();
  assert.deepEqual(missing, [], 'every message is translated');
  for (const [key, value] of Object.entries(ZH_CN)) {
    assert.notEqual(value.trim(), '', `${key} has a translation`);
    assert.deepEqual(placeholders(value), placeholders(key), `${key} keeps its placeholders`);
  }
  const stale = Object.keys(ZH_CN).filter((key) => !messages.has(key));
  assert.deepEqual(stale, [], 'no translation outlives its message');
});

await test('catalog areas never define the same message twice', () => {
  const seen = new Map<string, string>();
  for (const [area, part] of Object.entries(ZH_PARTS)) {
    for (const key of Object.keys(part)) {
      assert.equal(seen.get(key), undefined, `${key} is defined in ${seen.get(key) ?? ''} and ${area}`);
      seen.set(key, area);
    }
  }
});

await test('view modules build visible text through the catalog, never hard-coded English', async () => {
  const directory = path.join('web', 'src');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.ts') && !UNCATALOGUED.test(name));
  const found: string[] = [];
  for (const name of names) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A short, fixed list of console sources.
    const lines = (await readFile(path.join(directory, name), 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (HARD_CODED.some((pattern) => pattern.test(line))) {
        found.push(`${name}:${String(index + 1)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(found, [], 'wrap operator-visible text in t() so it can be translated');
});

await test('the extractor reads literal messages, ternary branches and the static shell', () => {
  assert.deepEqual(
    moduleMessages(
      "t('Save'); t(isOpen ? 'Close' : \"Can't open\"); t(kind === 'x' ? 'A' : 'B'); phrase('Mark'); notice('Hi', true); t(dynamic)",
    ),
    ['Save', 'Close', "Can't open", 'A', 'B', 'Mark', 'Hi'],
  );
  assert.deepEqual(
    shellMessages(
      '<head><title>No</title></head><body><p>Run <code>malt ui</code> now.</p><b aria-label="Shell nav">MALT</b></body>',
    ),
    ['Run', 'now.', 'Shell nav'],
  );
});

await test('plural messages pick the language’s form and fill every placeholder', () => {
  const files = '{files, plural, one {# file} other {# files}} changed · +{additions} −{deletions}';
  assert.equal(formatMessage(files, { files: 1, additions: 2, deletions: 0 }, 'en'), '1 file changed · +2 −0');
  assert.equal(formatMessage(files, { files: 1203, additions: 12, deletions: 3 }, 'en'), '1203 files changed · +12 −3');
  assert.equal(formatMessage('{n, plural, =0 {none} other {# left}}', { n: 0 }, 'en'), 'none');
  assert.equal(formatMessage('Hello {name}', {}, 'en'), 'Hello {name}', 'a missing value stays visible');
  try {
    useLocale('zh-CN');
    assert.equal(t(files, { files: 3, additions: 1, deletions: 2 }), '3 个文件已更改 · +1 −2');
    assert.equal(t('Instruct {role}', { role: 'qa-1' }), '向 qa-1 下达指令');
    assert.equal(t('Not a catalog message'), 'Not a catalog message', 'unknown text falls back to English');
    assert.equal(
      t('{count, plural, one {# untranslated file} other {# untranslated files}}', { count: 1 }),
      '1 untranslated file',
      'an English fallback uses English plural rules',
    );
  } finally {
    useLocale('en');
  }
  assert.equal(t('Pause factory'), 'Pause factory');
});

await test('dates format in the chosen language', () => {
  const at = Date.UTC(2026, 9, 17, 9, 30);
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' };
  // English keeps the host's English variant (en-GB writes 17 October 2026), so compare with that locale.
  const english = new Intl.DateTimeFormat(formatLocale(), options);
  assert.equal(formatDateTime(at, options), english.format(at));
  try {
    useLocale('zh-CN');
    assert.equal(formatDateTime(at, options), '2026年10月17日');
  } finally {
    useLocale('en');
  }
});

await test('module-level tables follow the language, and rendered text maps back to its message', () => {
  const table = translated({ label: phrase('Pause factory'), css: 'kind-approval', nested: [phrase('Start factory')] });
  assert.equal(table.label, 'Pause factory');
  try {
    useLocale('zh-CN');
    assert.equal(table.label, '暂停工厂');
    assert.equal(table.css, 'kind-approval', 'unmarked values are never translated');
    assert.deepEqual([...table.nested], ['启动工厂']);
  } finally {
    useLocale('en');
  }
  assert.deepEqual(sourceOf('暂停工厂', 'zh-CN'), { key: 'Pause factory', parameters: {} });
  assert.deepEqual(sourceOf('向 qa-1 下达指令', 'zh-CN'), { key: 'Instruct {role}', parameters: { role: 'qa-1' } });
  assert.deepEqual(sourceOf('Instruct qa-2', 'en'), { key: 'Instruct {role}', parameters: { role: 'qa-2' } });
  assert.equal(sourceOf('An agent summary', 'en'), null);
});

await test('the system choice follows the browser’s languages', () => {
  assert.equal(resolveLocale('system', ['zh-TW', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale('system', ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLocale('system', ['de-DE']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
});
