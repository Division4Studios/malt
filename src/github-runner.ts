/**
 * Shell-free, bounded GitHub CLI execution shared by Project, delivery and
 * learning integrations.
 *
 * @file
 */
import { execFile } from 'node:child_process';

import { MeshError } from './protocol.ts';

/** Largest buffered GitHub CLI response. */
const OUTPUT_MAX_BYTES = 4_194_304;
/** Deadline for one GitHub CLI request. */
const CLI_TIMEOUT_MS = 30_000;

/** A CLI runner, injectable so tests do not create real GitHub artifacts. */
export type GitHubRunner = (args: readonly string[], input?: unknown) => Promise<unknown>;

/**
 * Run GitHub CLI without a shell, writing structured request bodies to stdin.
 *
 * @param root - Broker-accessible project directory.
 * @returns A bounded, noninteractive JSON runner.
 */
export function githubRunner(root: string): GitHubRunner {
  return async (args, input) =>
    new Promise<unknown>((resolve, reject) => {
      const child = execFile(
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's authenticated gh CLI without a shell.
        'gh',
        [...args],
        {
          cwd: root,
          windowsHide: true,
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: OUTPUT_MAX_BYTES,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
        },
        // eslint-disable-next-line promise/prefer-await-to-callbacks -- execFile's callback is required to stream structured stdin and keep bounded output.
        (error, stdout) => {
          if (error !== null) {
            reject(
              new MeshError(
                'GITHUB_UNAVAILABLE',
                'GitHub CLI failed. Check gh installation, authentication, repo/project scopes, network access and project permissions. Inspect saved operation progress before retrying issue creation.',
              ),
            );
            return;
          }
          try {
            resolve(stdout.trim() === '' ? null : JSON.parse(stdout));
          } catch {
            reject(new MeshError('GITHUB_UNAVAILABLE', 'GitHub CLI returned invalid JSON.'));
          }
        },
      );
      // A command may exit before it consumes stdin. Its callback reports the
      // failure; do not let an EPIPE become an uncaught process error.
      child.stdin?.on('error', () => {
        /* The execFile completion callback reports the child failure. */
      });
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    });
}
