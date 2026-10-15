/** @file Real owned PTY trees are retired on close and broker-link disconnect. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startTerminalProcess } from '../src/factory/terminal-process.ts';

import { createCleanup, createProject, until } from './helpers.ts';

const pidSchema = z.number().int().positive();
const processesSchema = z.object({ processes: z.array(z.object({ pid: pidSchema })) });

/**
 * Inspect only a PID reported by our test's native fixture.
 *
 * @param pid - Owned descendant.
 * @returns Whether it still exists.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const mode of ['close', 'disconnect'] as const) {
  await test(
    `owned PTY ${mode} retires a SIGTERM-resistant CLI and its grandchildren`,
    { timeout: 25_000 },
    async (t) => {
      const defer = createCleanup(t);
      const project = createProject(defer);
      const artifact = path.join(project.directory, 'terminal');
      let text = '';
      let cliPid = 0;
      let failure = '';
      const terminal = startTerminalProcess({
        launch: { provider: 'codex', file: 'codex', cwd: project.root, columns: 80, rows: 24 },
        artifact,
        memoryMb: 512,
        cpuPercent: 50,
        fixture: true,
        onFrame(frame) {
          if (frame.type === 'error') {
            failure = `${frame.code}: ${frame.message}`;
            return;
          }
          if (frame.type === 'started') {
            cliPid = frame.pid;
          } else if (frame.type === 'data') {
            text += Buffer.from(frame.data).toString();
          }
        },
      });
      defer(async () => terminal.stop());
      try {
        await until(() => text.includes('SIZE 80 24') || failure !== '', 10_000);
      } catch {
        await terminal.stop();
        assert.fail(JSON.stringify({ failure, text }));
      }
      assert.equal(failure, '', 'The contained host must start successfully.');
      terminal.send({ type: 'input', data: Buffer.from('spawn\rignore-term\r') });
      await until(() => text.includes('GRANDCHILD ') && text.includes('IGNORING SIGTERM'), 10_000);
      const match = /GRANDCHILD (?<pid>\d+)/v.exec(text);
      const grandchild = Number(match?.groups?.['pid']);
      assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0, text);
      assert.ok(isAlive(cliPid));
      assert.ok(isAlive(grandchild));
      if (process.platform === 'win32') {
        const telemetry = path.join(artifact, 'resources.json');
        await until(() => {
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only this owned Job's secret-free PID telemetry.
            const rows = processesSchema.parse(JSON.parse(readFileSync(telemetry, 'utf8'))).processes;
            return (
              rows.some((row) => row.pid === cliPid) && rows.some((row) => row.pid === grandchild) && rows.length >= 4
            );
          } catch {
            return false;
          }
        }, 10_000);
      }
      if (mode === 'close') {
        terminal.send({ type: 'close' });
        await terminal.closed;
      } else {
        await terminal.stop();
      }
      await until(() => !isAlive(cliPid) && !isAlive(grandchild), 10_000);
      await terminal.stop();
      await terminal.stop();
      assert.throws(() => {
        terminal.send({ type: 'resize', columns: 100, rows: 30 });
      });
    },
  );
}
