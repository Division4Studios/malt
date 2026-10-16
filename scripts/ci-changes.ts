/**
 * Conservative CI selection; unknown events, refs or diffs run the full gate.
 *
 * @file
 */
import { spawnSync } from 'node:child_process';

/** Human-facing root documents; operational prompts and skills are excluded. */
const ROOT_DOCUMENTS = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'SUPPORT.md',
  'SPONSORING.md',
  'THIRD_PARTY_NOTICES.md',
]);

/**
 * Accept only a nonempty list of human-facing Markdown documents.
 *
 * @param files - Complete changed paths, including both sides of renames.
 * @returns Whether only documentation changed.
 */
export function isDocumentationOnly(files: readonly string[]): boolean {
  return (
    files.length > 0 &&
    files.every((file) => {
      if (ROOT_DOCUMENTS.has(file)) {
        return true;
      }
      const parts = file.split('/');
      return (
        file.startsWith('docs/') &&
        file.endsWith('.md') &&
        parts.every((part) => !['..', '.', 'AGENTS.md', 'CLAUDE.md', 'SKILL.md'].includes(part)) &&
        !file.includes('\\') &&
        !file.includes('\n') &&
        !file.includes('\r')
      );
    })
  );
}

/**
 * Compare immutable event commits with no API pagination or rename omissions.
 *
 * @param event - GitHub event name; manual runs always use the full gate.
 * @param base - Full event base SHA.
 * @param head - Full event head SHA.
 * @param cwd - Checkout directory, or the current checkout when omitted.
 * @returns Whether the complete Git diff qualifies for the documentation path.
 */
export function isDocumentationDiff(event: string, base: string, head: string, cwd?: string): boolean {
  if (
    !['pull_request', 'push', 'merge_group'].includes(event) ||
    !/^[\da-f]{40}$/v.test(base) ||
    !/^[\da-f]{40}$/v.test(head) ||
    /^0+$/v.test(base)
  ) {
    return false;
  }
  const range = `${base}${event === 'pull_request' ? '...' : '..'}${head}`;
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- CI uses the runner-installed Git with validated SHA arguments and no shell.
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  return (
    result.status === 0 &&
    result.error === undefined &&
    result.stdout.endsWith('\0') &&
    isDocumentationOnly(result.stdout.slice(0, -1).split('\0'))
  );
}

if (import.meta.main) {
  const isSelected = isDocumentationDiff(
    process.env['GITHUB_EVENT_NAME'] ?? '',
    process.env['CI_BASE_SHA'] ?? '',
    process.env['CI_HEAD_SHA'] ?? '',
  );
  process.stdout.write(`docs_only=${String(isSelected)}\n`);
}
