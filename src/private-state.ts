/**
 * Git exclusion for private project operational state.
 *
 * @file
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { hasErrorCode } from './errors.ts';

/**
 * Patterns Git treats as excluding the same root directory, so an existing one is never duplicated.
 *
 * @param rule - Canonical rule; only directory rules have anchored and slashless spellings.
 * @returns Every accepted spelling of the rule.
 */
function equivalentRules(rule: string): ReadonlySet<string> {
  if (!rule.endsWith('/')) {
    return new Set([rule]);
  }
  const name = rule.slice(0, -1);
  return new Set([name, rule, `/${name}`, `/${rule}`]);
}

/**
 * Append missing final ignore rules without replacing user-authored rules.
 *
 * @param file - Ignore file inside the selected project.
 * @param required - Rules that must not be followed by any negation, so they override preceding ones.
 * @throws {Error} When the ignore file cannot be read or updated.
 */
function ensureFinalRules(file: string, required: readonly string[]): void {
  let existing = '';
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the selected project's two fixed ignore files are accessed.
    existing = readFileSync(file, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
  // Git ignores comments and blank lines.
  const rules = existing
    .split(/\r?\n/v)
    .map((line) => withoutTrailingSpaces(line))
    .filter((line) => line !== '' && !line.startsWith('#'));
  const missing = required.filter((rule) => {
    const equivalent = equivalentRules(rule);
    const last = rules.findLastIndex((line) => equivalent.has(line));
    return last === -1 || rules.slice(last + 1).some((line) => line.startsWith('!'));
  });
  if (missing.length === 0) {
    return;
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- Synchronous configuration bootstrap must install exclusions before writing secrets; both files are fixed project paths.
  appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : eol}${missing.join(eol)}${eol}`);
}

/**
 * Drop the trailing spaces Git ignores; a backslash-escaped final space stays part of the pattern.
 *
 * @param line - One ignore-file line without its line ending.
 * @returns The pattern as Git reads it.
 */
function withoutTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    end -= 1;
  }
  return end < line.length && line[end - 1] === '\\' ? line.slice(0, end + 1) : line.slice(0, end);
}

/**
 * Exclude all operational state, including the generated README and skills.
 * Git ignores cannot untrack files already committed by the operator.
 *
 * @param root - Selected project root.
 * @param directory - Its existing private state directory.
 * @throws {Error} When the exclusions cannot be installed.
 */
export function ensurePrivateStateIgnored(root: string, directory: string): void {
  ensureFinalRules(path.join(root, '.gitignore'), ['.mlt/', '.malt/']);
  ensureFinalRules(path.join(directory, '.gitignore'), ['*']);
}
