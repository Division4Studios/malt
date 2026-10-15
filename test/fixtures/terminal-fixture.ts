/**
 * Token-free terminal fixture. Newline-delimited stdin commands (LF or CRLF):
 * size; resize <columns> <rows>; frame; credential; spawn; ignore-term; term; quit.
 * Every line is echoed as ECHO <JSON string>; unknown commands report UNKNOWN.
 * Pipes start at 80x24; a TTY uses its actual size and reports SIGWINCH/resize.
 * `term` exercises the SIGTERM handler even on Windows, where child.kill bypasses
 * Node signal handlers. `quit` and EOF clean up the child and grandchild.
 * Internal --descendant/--grandchild modes are used only to construct the tree.
 *
 * @file
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import type { ChildProcess } from 'node:child_process';

const { filename } = import.meta;

/**
 * Launch one internal descendant mode.
 *
 * @param mode - Internal mode word.
 * @returns Owned child with a pipe controlling its lifetime.
 */
function launch(mode: string): ChildProcess {
  return spawn(process.execPath, [filename, mode], { stdio: ['pipe', 'inherit', 'inherit'] });
}

/**
 * Stop a descendant through EOF and await its cleanup.
 *
 * @param child - Owned descendant, if one was started.
 */
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, 'exit');
  child.stdin?.end();
  await exited;
}

/**
 * Keep an intermediary alive until EOF and reap its grandchild.
 */
async function descendant(): Promise<void> {
  const child = launch('--grandchild');
  process.stdin.resume();
  await once(process.stdin, 'end');
  await stop(child);
}

/**
 * Report a real grandchild PID and remain alive until EOF.
 */
function grandchild(): void {
  process.stdout.write(`GRANDCHILD ${String(process.pid)}\n`);
  process.stdin.resume();
}

/**
 * Serve the documented command protocol without any provider dependency.
 */
async function interactive(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  let columns = process.stdout.isTTY ? process.stdout.columns : 80;
  let rows = process.stdout.isTTY ? process.stdout.rows : 24;
  let child: ChildProcess | undefined;
  let isIgnoreTerm = false;
  const reportSize = (): void => {
    process.stdout.write(`SIZE ${String(columns)} ${String(rows)}\n`);
  };
  const actualSize = (): void => {
    if (process.stdout.isTTY) {
      columns = process.stdout.columns;
      rows = process.stdout.rows;
    }
    reportSize();
  };
  if (process.stdout.isTTY) {
    process.stdout.on('resize', actualSize);
  } else {
    process.on('SIGWINCH', actualSize);
  }
  process.on('SIGTERM', () => {
    if (isIgnoreTerm) {
      process.stdout.write('IGNORED SIGTERM\n');
    } else {
      process.stdin.destroy();
    }
  });
  reportSize();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const shouldQuit = (line: string): boolean => {
    process.stdout.write(`ECHO ${JSON.stringify(line)}\n`);
    const resize = /^resize (?<columns>\d{1,3}) (?<rows>\d{1,3})$/v.exec(line);
    if (resize?.groups !== undefined) {
      columns = Math.max(1, Number(resize.groups['columns']));
      rows = Math.max(1, Number(resize.groups['rows']));
      reportSize();
      return false;
    }
    switch (line) {
      case 'size': {
        actualSize();
        break;
      }
      case 'frame': {
        process.stdout.write('\u{1B}[?1049h\u{1B}[2J\u{1B}[1;1Hfixture\u{1B}[2;3Hready\u{1B}[?1049l\n');
        break;
      }
      case 'credential': {
        process.stdout.write('CREDENTIAL sk-fixture-00000000000000000000000000000000\n');
        break;
      }
      case 'spawn': {
        if (child === undefined) {
          child = launch('--descendant');
        } else {
          process.stdout.write('ALREADY SPAWNED\n');
        }
        break;
      }
      case 'ignore-term': {
        isIgnoreTerm = true;
        process.stdout.write('IGNORING SIGTERM\n');
        break;
      }
      case 'term': {
        process.emit('SIGTERM');
        break;
      }
      case 'quit': {
        process.stdout.write('BYE\n');
        return true;
      }
      default: {
        process.stdout.write('UNKNOWN\n');
      }
    }
    return false;
  };
  try {
    for await (const line of input) {
      if (shouldQuit(line)) {
        break;
      }
    }
  } finally {
    input.close();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.unref();
    }
    process.stdin.destroy();
    await stop(child);
  }
}

switch (process.argv[2] ?? '') {
  case '--grandchild': {
    grandchild();
    break;
  }
  case '--descendant': {
    await descendant();
    break;
  }
  default: {
    await interactive();
  }
}
