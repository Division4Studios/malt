/**
 * Project validation has its own cache/temp paths, independent of provider jobs.
 *
 * @file
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Keep executable validation fixtures off hardened POSIX system temp mounts.
 * Windows retains its native TEMP/TMP selection and owned-process controls.
 *
 * @param directory - Trusted private project state directory.
 * @returns Non-secret overrides for configured validation subprocesses only.
 */
export function validationEnvironment(directory: string): Readonly<Record<string, string>> {
  const cache = path.join(directory, 'cache');
  const temporary = path.join(cache, 'validation-tmp');
  if (process.platform !== 'win32') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Derived only from the factory's trusted private project directory.
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
  }
  return {
    NPM_CONFIG_CACHE: path.join(cache, 'npm'),
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    ...(process.platform !== 'win32' && { TMPDIR: temporary }),
  };
}
