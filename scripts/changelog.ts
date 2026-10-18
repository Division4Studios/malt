/**
 * Generate `CHANGELOG.md` from Git history. Every first-parent commit on the
 * chosen ref is one entry, grouped by its Conventional Commit type into the
 * same categories `.github/release.yml` uses for GitHub-generated release
 * notes. Pull requests labelled `skip-changelog` are left out, and their
 * numbers, with the exact commit the file was generated from, are recorded in
 * its header, so re-running with those inputs reproduces the file exactly.
 *
 * Usage: `node scripts/changelog.ts [--ref <rev>] [--skip 12,34] [--labels] [--check [--at <rev>]]`.
 * `--labels` reads the merged `skip-changelog` pull requests through `gh`;
 * `--check` regenerates from the header's recorded inputs and fails when the
 * committed file differs, and with `--at` also fails unless the file was
 * generated exactly at that revision, so a release cannot ship a stale one.
 *
 * @file
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** Release-note categories, in `.github/release.yml` order. */
export const GROUPS = [
  'Security',
  'Features',
  'Fixes',
  'Documentation and community',
  'Dependencies',
  'Other changes',
] as const;
/** One release-note category. */
export type Group = (typeof GROUPS)[number];
/** Conventional Commit types mapped to their category; anything else is "Other changes". */
const TYPE_GROUPS: Readonly<Record<string, Group>> = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Fixes',
  docs: 'Documentation and community',
  deps: 'Dependencies',
};
/** Squash-merge suffix naming the pull request. */
const PULL_REQUEST = / \(#(?<number>\d+)\)$/v;
/** A Conventional Commit type. */
const TYPE = /^[a-z]+$/v;
/** Header line recording the generation inputs. */
const INPUTS = /^<!-- generated from (?<commit>[\da-f]{40}); skipped pull requests: (?<skipped>[\d #,]*|none) -->$/mv;
/** Default output, next to package.json. */
const CHANGELOG = path.resolve(import.meta.dirname, '..', 'CHANGELOG.md');

/** One first-parent commit. */
export interface Commit {
  /** Full commit id. */
  readonly sha: string;
  /** Subject line. */
  readonly subject: string;
}

/** A commit placed in its category. */
export interface Entry {
  /** Release-note category. */
  readonly group: Group;
  /** Conventional scope, if any. */
  readonly scope: string | null;
  /** Subject without type, scope or pull request suffix. */
  readonly description: string;
  /** Squash-merged pull request, if the subject names one. */
  readonly pullRequest: number | null;
}

/**
 * Split a Conventional Commit subject (`type(scope)!: description`).
 *
 * @param text - Subject without its pull request suffix.
 * @returns Type, scope and description, or null for a free-form subject.
 */
function conventional(text: string): { type: string; scope: string | null; description: string } | null {
  const colon = text.indexOf(': ');
  const head = colon < 1 ? '' : text.slice(0, colon).replace(/!$/v, '');
  const open = head.indexOf('(');
  const type = open === -1 ? head : head.slice(0, open);
  const hasScope = open !== -1 && head.endsWith(')') && open + 2 < head.length;
  if (!TYPE.test(type) || (open !== -1 && !hasScope)) {
    return null;
  }
  return { type, scope: hasScope ? head.slice(open + 1, -1) : null, description: text.slice(colon + 2) };
}

/**
 * The category for a type and scope; a `security` or `deps` scope wins over the type.
 *
 * @param type - Conventional type, or empty for a free-form subject.
 * @param scope - Conventional scope, if any.
 * @returns Release-note category.
 */
function groupOf(type: string, scope: string | null): Group {
  if (scope === 'security' || type === 'security') {
    return 'Security';
  }
  return scope === 'deps' || type === 'deps' ? 'Dependencies' : (TYPE_GROUPS[type] ?? 'Other changes');
}

/**
 * Place one commit subject in its release-note category.
 *
 * @param subject - Commit subject.
 * @returns The entry it becomes.
 */
export function parseSubject(subject: string): Entry {
  const pullRequest = PULL_REQUEST.exec(subject)?.groups?.['number'];
  const text = subject.replace(PULL_REQUEST, '').trim();
  const parts = conventional(text);
  const group = groupOf(parts?.type ?? '', parts?.scope ?? null);
  const isScopeGroup = group === 'Security' || group === 'Dependencies';
  return {
    group,
    scope: isScopeGroup ? null : (parts?.scope ?? null),
    description: parts?.description ?? text,
    pullRequest: pullRequest === undefined ? null : Number(pullRequest),
  };
}

/**
 * Render the changelog for a history.
 *
 * @param commits - First-parent commits, newest first.
 * @param inputs - The commit the history ends at and the pull requests to leave out.
 * @param inputs.commit - Full id of the newest commit.
 * @param inputs.skipped - `skip-changelog` pull request numbers.
 * @returns Complete Markdown file.
 */
export function renderChangelog(
  commits: readonly Commit[],
  inputs: { readonly commit: string; readonly skipped: ReadonlySet<number> },
): string {
  const grouped = new Map<Group, string[]>(GROUPS.map((group) => [group, []]));
  for (const commit of commits) {
    const entry = parseSubject(commit.subject);
    if (entry.pullRequest !== null && inputs.skipped.has(entry.pullRequest)) {
      continue;
    }
    const scope = entry.scope === null ? '' : `**${entry.scope}:** `;
    const reference = entry.pullRequest === null ? ` (${commit.sha.slice(0, 7)})` : ` (#${String(entry.pullRequest)})`;
    grouped.get(entry.group)?.push(`- ${scope}${entry.description}${reference}`);
  }
  const skipped = [...inputs.skipped].toSorted((left, right) => left - right).map((number) => `#${String(number)}`);
  const sections = GROUPS.flatMap((group) => {
    const lines = grouped.get(group) ?? [];
    return lines.length === 0 ? [] : [`### ${group}`, '', ...lines, ''];
  });
  return [
    '# Changelog',
    '',
    `<!-- generated from ${inputs.commit}; skipped pull requests: ${skipped.length === 0 ? 'none' : skipped.join(', ')} -->`,
    '',
    'Generated by `node scripts/changelog.ts` from first-parent Git history; do not edit by hand. Each entry is one',
    'squash-merged pull request. Pull requests labelled `skip-changelog` are left out. No release has been published yet,',
    'so every change is listed under Unreleased.',
    '',
    '## Unreleased',
    '',
    ...sections,
  ].join('\n');
}

/**
 * The generation inputs recorded in an existing changelog.
 *
 * @param text - Changelog Markdown.
 * @returns The recorded commit and skipped pull requests, or null when the header is missing.
 */
export function recordedInputs(text: string): { commit: string; skipped: Set<number> } | null {
  const match = INPUTS.exec(text)?.groups;
  if (match === undefined) {
    return null;
  }
  const skipped = (match['skipped'] ?? '').match(/\d+/gv) ?? [];
  return { commit: match['commit'] ?? '', skipped: new Set(skipped.map(Number)) };
}

/**
 * Why a committed changelog cannot be trusted, if it cannot.
 *
 * @param committed - Committed changelog text.
 * @param regenerate - Renders the changelog for recorded inputs.
 * @param expected - Commit the changelog must have been generated at, or null to accept any.
 * @returns The problem, or null when the file is current and reproducible.
 */
export function changelogProblem(
  committed: string,
  regenerate: (inputs: { readonly commit: string; readonly skipped: ReadonlySet<number> }) => string,
  expected: string | null,
): string | null {
  const inputs = recordedInputs(committed);
  if (inputs === null) {
    return 'CHANGELOG.md has no generation header.';
  }
  if (expected !== null && inputs.commit !== expected) {
    return `CHANGELOG.md was generated from ${inputs.commit}, not ${expected}. Regenerate it for this release.`;
  }
  return regenerate(inputs) === committed ? null : 'CHANGELOG.md differs from a regeneration with its recorded inputs.';
}

/**
 * Read first-parent history.
 *
 * @param revision - Revision the history ends at.
 * @returns Full commit id of `revision` and its first-parent commits, newest first.
 */
function history(revision: string): { commit: string; commits: Commit[] } {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Maintainers and CI run the installed Git, shell-free.
  const commit = execFileSync('git', ['rev-list', '--max-count=1', revision], { encoding: 'utf8' }).trim();
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Maintainers and CI run the installed Git, shell-free.
  const log = execFileSync('git', ['log', '--first-parent', '--format=%H%x00%s', commit], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const commits = log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\0', 2);
      return { sha, subject };
    });
  return { commit, commits };
}

/**
 * Merged pull requests labelled `skip-changelog`, read through the GitHub CLI.
 *
 * @returns Their numbers.
 */
function labelledSkips(): Set<number> {
  const output = execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the maintainer's authenticated gh CLI without a shell.
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--label',
      'skip-changelog',
      '--limit',
      '1000',
      '--json',
      'number',
      '--jq',
      '.[].number',
    ],
    { encoding: 'utf8' },
  );
  return new Set(
    output
      .split('\n')
      .filter((line) => line !== '')
      .map(Number),
  );
}

/**
 * Generate, write or check the changelog.
 *
 * @throws {Error} When `--check` finds no header or a different file.
 */
function main(): void {
  const { values } = parseArgs({
    options: {
      ref: { type: 'string', default: 'HEAD' },
      skip: { type: 'string' },
      labels: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      at: { type: 'string' },
    },
  });
  if (values.check) {
    const committed = readFileSync(CHANGELOG, 'utf8');
    const expected = values.at === undefined ? null : history(values.at).commit;
    const problem = changelogProblem(
      committed,
      (inputs) => renderChangelog(history(inputs.commit).commits, inputs),
      expected,
    );
    if (problem !== null) {
      throw new Error(problem);
    }
    process.stdout.write('CHANGELOG.md is reproducible from its recorded inputs.\n');
    return;
  }
  let skipped = new Set((values.skip ?? '').match(/\d+/gv)?.map(Number));
  if (values.labels) {
    skipped = labelledSkips();
  }
  const { commit, commits } = history(values.ref);
  writeFileSync(CHANGELOG, renderChangelog(commits, { commit, skipped }));
  process.stdout.write(`Wrote CHANGELOG.md from ${commit} (${String(commits.length)} commits).\n`);
}

if (import.meta.main) {
  main();
}
