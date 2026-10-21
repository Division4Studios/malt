/**
 * `--help` documents exactly the commands the CLI dispatches.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { COMMANDS } from '../src/cli-commands.ts';
import { FILE_COMMANDS } from '../src/factory-cli.ts';

import { CLI_PATH } from './helpers.ts';

/** Promise form of the no-shell child process runner. */
const execFileAsync = promisify(execFile);
/** Usage lines indent the command by two spaces; wrapped continuations indent further. */
const INDENT = '  ';

/**
 * Read each documented usage line, keyed by its command.
 *
 * @returns The text after the command on each of its usage lines.
 */
async function documentedUsage(): Promise<Map<string, string[]>> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, '--help'], { windowsHide: true });
  const usage = stdout.slice(stdout.indexOf('Usage:'), stdout.indexOf('\nOptions:'));
  const lines = new Map<string, string[]>();
  for (const line of usage.split('\n')) {
    const entry = line.slice(INDENT.length);
    if (!line.startsWith(INDENT) || !/^[a-z]/v.test(entry)) {
      continue;
    }
    const [command = ''] = entry.split(' ', 1);
    lines.set(command, [...(lines.get(command) ?? []), entry.slice(command.length)]);
  }
  return lines;
}

/**
 * Sort command names for a stable comparison.
 *
 * @param names - Command names.
 * @returns Distinct names in locale order.
 */
function sorted(names: Iterable<string>): string[] {
  const distinct = new Set(names);
  return distinct
    .values()
    .toArray()
    .toSorted((left, right) => left.localeCompare(right));
}

await test('help lists every dispatched command and nothing the CLI rejects', async () => {
  const usage = await documentedUsage();
  assert.deepEqual(sorted(usage.keys()), sorted(COMMANDS));
});

await test('help shows --file FILE for every command that requires a JSON input file', async () => {
  const usage = await documentedUsage();
  for (const command of FILE_COMMANDS) {
    assert.equal(
      usage.get(command)?.some((line) => line.trimStart().startsWith('--file FILE')),
      true,
      `${command} must document its required --file FILE input.`,
    );
  }
});
