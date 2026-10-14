/**
 * Git exclusion for private project operational state.
 *
 * @file
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { hasErrorCode } from './errors.ts';

/**
 * Append a final ignore rule without replacing user-authored rules.
 *
 * @param file - Ignore file inside the selected project.
 * @param rule - Final rule that must override preceding negations.
 * @throws {Error} When the ignore file cannot be read or updated.
 */
function ensureFinalRule(file: string, rule: string): void {
  let existing = '';
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the selected project's two fixed ignore files are accessed.
    existing = readFileSync(file, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
  const rules = existing.split(/\r?\n/v).filter((line) => line.trim() !== '' && !line.startsWith('#'));
  if (rules.slice(-rule.split('\n').length).join('\n') !== rule) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- Synchronous configuration bootstrap must install exclusions before writing secrets; both files are fixed project paths.
    appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${rule}\n`);
  }
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
  ensureFinalRule(path.join(root, '.gitignore'), '.mlt/\n.malt/');
  ensureFinalRule(path.join(directory, '.gitignore'), '*');
}
