/**
 * Zero-model preflight run just before a paid model turn, on the exact
 * environment the attempt will use: the sealed source view is readable, Git
 * works in the attempt's checkout and the project's check commands can start.
 * A failure parks the step as an unpaid gate with one blocker naming the
 * check, so no paid turn is spent on a broken environment.
 *
 * @file
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import { commandInvocation } from './commands.ts';
import { sealedHead } from './source-reader.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryJob } from './schema.ts';

/** Weight of one octal digit in a file mode. */
const OCTAL = 8;
/** Owner, group and other execute permission bits. */
const EXECUTE_BITS = [OCTAL * OCTAL, OCTAL, 1];
/** File modes carry permissions in their low nine bits. */
const PERMISSION_RANGE = 0o1000;
/** Executable suffixes Windows tries for a bare command name. */
const WINDOWS_SUFFIXES = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Whether a path is a file the operating system would run: on POSIX it needs execute permission.
 *
 * @param candidate - Absolute path.
 * @returns True for an executable file.
 */
function isExecutable(candidate: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Checks a project-configured command path without running it.
  const stats = statSync(candidate, { throwIfNoEntry: false });
  if (stats?.isFile() !== true) {
    return false;
  }
  const permissions = stats.mode % PERMISSION_RANGE;
  return process.platform === 'win32' || EXECUTE_BITS.some((bit) => Math.floor(permissions / bit) % 2 === 1);
}

/**
 * Whether an executable can be found where the operating system would look for it.
 *
 * @param file - Configured command executable.
 * @param cwd - Directory the command runs in; relative PATH entries resolve against it.
 * @returns True when the resolved executable exists and may run.
 */
export function canStart(file: string, cwd: string): boolean {
  const resolved = commandInvocation(file, []).file;
  if (path.isAbsolute(resolved) || resolved.includes('/') || resolved.includes('\\')) {
    return isExecutable(path.resolve(cwd, resolved));
  }
  const isWindows = process.platform === 'win32';
  const suffixes = isWindows ? ['', ...WINDOWS_SUFFIXES] : [''];
  // An empty POSIX PATH entry is the current directory: the attempt checkout the command runs in.
  const directories = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((directory) => directory !== '' || !isWindows)
    .map((directory) => path.resolve(cwd, directory));
  return directories.some((directory) =>
    suffixes.some((suffix) => isExecutable(path.join(directory, `${resolved}${suffix}`))),
  );
}

/**
 * Check the attempt's environment before any paid turn.
 *
 * @param context - Project Git, ledger and check commands.
 * @param job - Fenced attempt about to launch its provider.
 * @param cwd - The attempt's prepared checkout.
 * @returns Why the paid turn must not start, or null when preflight passed.
 */
export async function assignmentPreflight(
  context: FactoryContext,
  job: FactoryJob,
  cwd: string,
): Promise<string | null> {
  const failure = (check: string, detail: string): string =>
    `Preflight stopped this ${job.kind} attempt before any paid turn: ${check} ${detail} Fix it and the step retries.`;
  const head = sealedHead(context.repository.store, job.id);
  if (head === null) {
    return failure('the read-only source view', 'was not sealed for this attempt.');
  }
  try {
    if ((await context.workspaces.git(['ls-tree', '-r', '--name-only', head])) === '') {
      return failure('the sealed source view', `at ${head} lists no files.`);
    }
  } catch {
    return failure('the sealed source view', `at ${head} cannot be read from the repository.`);
  }
  try {
    await context.workspaces.git(['status', '--porcelain'], cwd);
  } catch {
    return failure('Git', `does not work in the attempt's checkout (${path.basename(cwd)}).`);
  }
  const commands = [...context.settings.testCommands, ...context.settings.endToEndCommands];
  const missing = commands.find((check) => !canStart(check.file, cwd));
  return missing === undefined
    ? null
    : failure('the project check command', `${missing.file} cannot be started from this checkout.`);
}
