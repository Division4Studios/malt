/** @file Pipe-based terminal fixture protocol and descendant cleanup checks. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = new URL('fixtures/terminal-fixture.ts', import.meta.url);

void test('terminal fixture pipe protocol is deterministic and owns its descendants', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(fixture)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<string> => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return line.value;
  };
  const command = async (text: string): Promise<string> => {
    child.stdin.write(`${text}\n`);
    assert.equal(await next(), `ECHO ${JSON.stringify(text)}`);
    return next();
  };
  let grandchild = 0;
  try {
    assert.equal(await next(), 'SIZE 80 24');
    assert.equal(await command('size'), 'SIZE 80 24');
    assert.equal(await command('resize 100 30'), 'SIZE 100 30');
    assert.equal(await command('frame'), '\u{1B}[?1049h\u{1B}[2J\u{1B}[1;1Hfixture\u{1B}[2;3Hready\u{1B}[?1049l');
    assert.equal(await command('credential'), 'CREDENTIAL sk-fixture-00000000000000000000000000000000');
    assert.equal(await command('hello λ'), 'UNKNOWN');
    assert.equal(await command('ignore-term'), 'IGNORING SIGTERM');
    assert.equal(await command('term'), 'IGNORED SIGTERM');
    if (process.platform !== 'win32') {
      child.kill('SIGTERM');
      assert.equal(await next(), 'IGNORED SIGTERM');
      child.kill('SIGWINCH');
      assert.equal(await next(), 'SIZE 100 30');
    }
    child.stdin.write('hel');
    child.stdin.write('lo\r\n');
    assert.equal(await next(), 'ECHO "hello"');
    assert.equal(await next(), 'UNKNOWN');
    const report = await command('spawn');
    assert.match(report, /^GRANDCHILD \d+$/v);
    grandchild = Number(report.slice('GRANDCHILD '.length));
    assert.doesNotThrow(() => process.kill(grandchild, 0));
    assert.equal(await command('quit'), 'BYE');
    assert.deepEqual(await exited, [0, null]);
    assert.throws(() => process.kill(grandchild, 0));
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
    if (grandchild > 0) {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        /* Already cleaned up. */
      }
    }
  }
});

void test('terminal fixture EOF stops its long-lived grandchild', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(fixture)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let grandchild = 0;
  try {
    child.stdin.write('spawn\n');
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.startsWith('GRANDCHILD ')) {
        continue;
      }

      grandchild = Number(line.slice('GRANDCHILD '.length));
      process.kill(grandchild, 0);
      child.stdin.end();
    }
    assert.ok(grandchild > 0);
    assert.deepEqual(await exited, [0, null]);
    assert.throws(() => process.kill(grandchild, 0));
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
    if (grandchild > 0) {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        // Already cleaned up.
      }
    }
  }
});
