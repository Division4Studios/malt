/** @file Run every regression while respecting native Windows process-test contention. */
import { spawnSync } from 'node:child_process';

/** Windows Job/ConPTY tests include cold PowerShell compilation and hard OS ceilings. */
const concurrency = process.platform === 'win32' ? '1' : '2';
/** File scheduling changes no scenarios or assertions inside concurrency regressions. */
const result = spawnSync(
  process.execPath,
  ['--test', `--test-concurrency=${concurrency}`, ...process.argv.slice(2), 'test/**/*.test.ts'],
  { stdio: 'inherit', windowsHide: true },
);
if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
