/**
 * Resolving the executables MALT launches without a shell.
 *
 * @file
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Extensions a shell-free launch can run on Windows. */
const RUNNABLE_EXTENSIONS = ['.exe', '.com'] as const;
/** Bare executable names already resolved to an absolute path. */
const RESOLVED = new Map<string, string>();

/**
 * The absolute path of a bare executable name, searched only in absolute PATH
 * directories. On Windows a bare name is otherwise looked up in the child's
 * working directory first, so a `gh.exe` or `git.exe` committed to a project
 * would run instead of the installed tool. Elsewhere, and for any name with a
 * directory, the name is returned unchanged.
 *
 * @param file - Executable name or path.
 * @returns The path to launch.
 */
export function trustedExecutable(file: string): string {
  if (process.platform !== 'win32' || file.includes('/') || file.includes('\\')) {
    return file;
  }
  const known = RESOLVED.get(file.toLowerCase());
  if (known !== undefined) {
    return known;
  }
  const extensions = path.extname(file) === '' ? RUNNABLE_EXTENSIONS : [''];
  const directories = (process.env['PATH'] ?? '').split(path.delimiter);
  for (const directory of directories) {
    // A relative PATH entry would resolve against the workspace, which is exactly what is avoided.
    if (!path.isAbsolute(directory)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${file}${extension}`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Probes PATH directories for a named executable; nothing is read.
      if (existsSync(candidate)) {
        RESOLVED.set(file.toLowerCase(), candidate);
        return candidate;
      }
    }
  }
  return file;
}
