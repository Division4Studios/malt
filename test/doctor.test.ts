/** @file First-run doctor: every check's pass and fail paths with injected probes, JSON and text output. */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { formatDoctor, isAtLeast, runDoctor } from '../src/doctor.ts';

import type { DoctorProbes, DoctorReport } from '../src/doctor.ts';

/** Outputs of a healthy machine, keyed by `file args`. */
const HEALTHY: Readonly<Record<string, string>> = {
  'git --version': 'git version 2.47.0',
  'claude --version': '2.1.0 (Claude Code)',
  'claude --setting-sources  auth status': JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'private@example.com',
  }),
  'codex --version': 'codex-cli 0.50.0',
  'codex login status': 'Logged in using ChatGPT',
  'gh --version': 'gh version 2.60.0',
  'gh auth status': 'Logged in to github.com account private-user',
};

/**
 * Probes for a healthy machine, with selected commands removed or overridden.
 *
 * @param overrides - Probe replacements.
 * @param missing - `file args` keys that fail as if the command were absent.
 * @returns Injected probes; no real CLI, port or file is touched.
 */
function probes(overrides: Partial<DoctorProbes> = {}, missing: readonly string[] = []): Partial<DoctorProbes> {
  return {
    nodeVersion: () => '24.15.0',
    engines: () => '>=24.15.0',
    run: async (file, args) => {
      await Promise.resolve();
      const key = `${file} ${args.join(' ')}`;
      const output = HEALTHY[key];
      if (output === undefined || missing.includes(key)) {
        throw new Error(`spawn ${file} ENOENT`);
      }
      return { stdout: output, stderr: '' };
    },
    isPortFree: async () => {
      await Promise.resolve();
      return true;
    },
    isBroker: async () => {
      await Promise.resolve();
      return false;
    },
    probeWrite: async () => {
      await Promise.resolve();
    },
    exists: () => true,
    ...overrides,
  };
}

/**
 * One check's status by id.
 *
 * @param report - Doctor result.
 * @param id - Check identity.
 * @returns Status and fix line.
 */
function status(report: DoctorReport, id: string): { status: string; fix: string | null } {
  const found = report.checks.find((item) => item.id === id);
  assert.ok(found !== undefined, `missing check ${id}`);
  return { status: found.status, fix: found.fix };
}

await test('a healthy machine passes every check without echoing account details', async () => {
  const report = await runDoctor({ project: '/work/project', probes: probes() });
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((item) => item.id),
    ['node', 'git', 'claude', 'codex', 'providers', 'github', 'broker-port', 'console-port', 'writable'],
  );
  assert.ok(report.checks.every((item) => item.status === 'pass' && item.fix === null));
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /private@example\.com|private-user/v);
  assert.match(formatDoctor(report), /^PASS {3}Node\.js: 24\.15\.0/mv);
});

await test('an old Node.js, missing Git, busy ports or an unwritable project fail with a fix line', async () => {
  const report = await runDoctor({
    project: '/work/project',
    probes: probes(
      {
        nodeVersion: () => '22.9.0',
        isPortFree: async () => {
          await Promise.resolve();
          return false;
        },
        probeWrite: async () => {
          await Promise.reject(new Error('EACCES'));
        },
      },
      ['git --version'],
    ),
  });
  assert.equal(report.ok, false);
  for (const id of ['node', 'git', 'broker-port', 'console-port', 'writable']) {
    assert.equal(status(report, id).status, 'fail', id);
    assert.ok((status(report, id).fix ?? '') !== '', id);
  }
  assert.match(formatDoctor(report), /5 checks failed/v);
  assert.match(formatDoctor(report), /^ {7}fix: Install Node\.js >=24\.15\.0/mv);
});

await test('a missing or logged-out provider is fix-it; no provider at all fails', async () => {
  const one = await runDoctor({ project: '/p', probes: probes({}, ['claude --setting-sources  auth status']) });
  assert.equal(one.ok, true);
  assert.equal(status(one, 'claude').status, 'fix-it');
  assert.match(status(one, 'claude').fix ?? '', /claude auth login/v);
  assert.equal(status(one, 'providers').status, 'pass');

  const none = await runDoctor({ project: '/p', probes: probes({}, ['claude --version', 'codex login status']) });
  assert.equal(none.ok, false);
  assert.match(status(none, 'claude').fix ?? '', /Install Claude Code/v);
  assert.match(status(none, 'codex').fix ?? '', /codex login/v);
  assert.equal(status(none, 'providers').status, 'fail');
});

await test('GitHub CLI absent or logged out is fix-it, and a port held by a MALT broker passes', async () => {
  const absent = await runDoctor({ project: '/p', probes: probes({}, ['gh --version']) });
  assert.equal(status(absent, 'github').status, 'fix-it');
  assert.match(status(absent, 'github').fix ?? '', /cli\.github\.com/v);
  const loggedOut = await runDoctor({ project: '/p', probes: probes({}, ['gh auth status']) });
  assert.equal(status(loggedOut, 'github').status, 'fix-it');
  assert.match(status(loggedOut, 'github').fix ?? '', /gh auth login/v);

  const busy = await runDoctor({
    project: '/p',
    brokerPort: 5000,
    probes: probes({
      isPortFree: async (port) => {
        await Promise.resolve();
        return port !== 5000;
      },
      isBroker: async (port) => {
        await Promise.resolve();
        return port === 5000;
      },
    }),
  });
  assert.equal(status(busy, 'broker-port').status, 'pass');
  assert.ok(busy.checks.some((item) => item.label === 'Broker port 5000'));
  const skipped = await runDoctor({ project: '/p', skipPorts: true, probes: probes() });
  assert.ok(skipped.checks.every((item) => !item.id.endsWith('-port')));
});

await test('the write probe targets .malt when present and leaves no file behind', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'malt-doctor-'));
  try {
    const targets: string[] = [];
    const before = await runDoctor({
      project,
      probes: probes({
        exists: (target) => target === project,
        probeWrite: async (directory) => {
          targets.push(directory);
          await Promise.resolve();
        },
      }),
    });
    assert.equal(status(before, 'writable').status, 'pass');
    assert.deepEqual(targets, [project]);
    // The real probe writes and removes a uniquely named file.
    const { probeWrite, ...real } = probes({ exists: (target) => target === project });
    assert.ok(probeWrite !== undefined);
    const written = await runDoctor({ project, probes: real });
    assert.equal(status(written, 'writable').status, 'pass');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test's own temporary folder.
    assert.deepEqual(readdirSync(project), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await test('engines comparison accepts equal and newer versions only', () => {
  assert.equal(isAtLeast('24.15.0', '>=24.15.0'), true);
  assert.equal(isAtLeast('24.16.1', '>=24.15.0'), true);
  assert.equal(isAtLeast('25.0.0', '>=24.15.0'), true);
  assert.equal(isAtLeast('24.14.9', '>=24.15.0'), false);
  assert.equal(isAtLeast('v24', '>=24.15.0'), false);
  assert.equal(isAtLeast('unknown', '>=24.15.0'), false);
});
