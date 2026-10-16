/** @file Real loopback/PTY fixture boundaries, with no provider executable or inference call. */
import assert from 'node:assert/strict';
import path from 'node:path';

import { startBroker } from '../src/broker.ts';
import { brokerAdmission } from '../src/factory/admission.ts';
import { startTerminalProcess } from '../src/factory/terminal-process.ts';
import { startWebConsole } from '../src/web/server.ts';
import { terminalPage, terminalView } from '../web/src/terminal-contract.ts';
import { TerminalEventDecoder } from '../web/src/terminal-stream.ts';

import { brokerUrl } from './helpers.ts';
import { terminalProject } from './terminal-project.ts';

import type { Broker } from '../src/broker.ts';
import type { MeshConfig } from '../src/config.ts';
import type { TerminalPage, TerminalView } from '../web/src/terminal-contract.ts';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { TestContext } from 'node:test';

/** A short deterministic policy does not race cold native startup. */
const IDLE_MS = 1000;
/** Bound each actual network read and native process startup. */
const READ_MS = 40_000;
/** Bound fixture text retained by one SSE inspection. */
const TEXT_LIMIT = 65_536;
/** Bound network iterations independently of text content. */
const READ_LIMIT = 512;
/** Safe bounded SSE evidence. */
interface Evidence {
  page: TerminalPage;
  text: string;
}
/** Actual configured lifecycle and native network fixture handles. */
export interface TerminalWebFixture {
  /** Real broker instance. */
  readonly broker: Broker;
  /** Actual project configuration; credentials remain inside the test. */
  readonly mesh: MeshConfig;
  /** Paired web boundary. */
  readonly web: Awaited<ReturnType<typeof startWebConsole>>;
  /** Test-owned browser authentication headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Exact fixture PIDs reported by the real owned host. */
  readonly pids: ReadonlyMap<string, number>;
  /** Actual broker-wide occupancy; fixtures cannot replace its authority. */
  readonly pool: typeof brokerAdmission;
  /** Deterministic idle/absolute native teardown triggers. */
  readonly timers: ReadonlyMap<() => void, number>;
  /** One-shot real browser mutation. */
  readonly control: (operation: string, input: Record<string, unknown>) => Promise<TerminalView>;
  /** Real SSE connection, cancelled on each return. */
  readonly read: (
    id: string,
    after: number,
    shouldAccept: (page: TerminalPage, text: string) => boolean,
  ) => Promise<Evidence>;
  /** Idempotently close the actual HTTP/broker lifecycle before an explicit restart. */
  readonly close: () => Promise<void>;
}

/**
 * Consume bounded native frames without assuming network chunks contain lines.
 *
 * @param reader - Owned actual HTTP response reader.
 * @param id - Requested session scope.
 * @param after - Last applied cursor.
 * @param shouldAccept - Required actual output or lifecycle state.
 * @returns Reassembled scoped evidence.
 */
async function readPages(
  reader: ReadableStreamDefaultReader<unknown>,
  id: string,
  after: number,
  shouldAccept: (page: TerminalPage, text: string) => boolean,
): Promise<Evidence> {
  const decoder = new TerminalEventDecoder();
  let text = '';
  let cursor = after;
  for (let reads = 0; reads < READ_LIMIT; reads += 1) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'Expected native evidence before the SSE ended.');
    assert.ok(chunk.value instanceof Uint8Array);
    for (const event of decoder.push(chunk.value)) {
      const page = terminalPage(event.value, { id, after: cursor });
      cursor = page.nextCursor;
      text += page.output
        .filter((output) => output.type === 'data')
        .map((output) => output.text)
        .join('');
      assert.ok(text.length <= TEXT_LIMIT, 'Fixture evidence stays bounded.');
      if (shouldAccept(page, text)) {
        return { page, text };
      }
    }
  }
  assert.fail('Native fixture exceeded the bounded SSE read limit.');
}

/**
 * Bring up the actual broker, web authentication, Git worktree and fixture-native PTY.
 *
 * @param t - Owning cleanup scope.
 * @returns Paired native controls, scoped output reads and exact fixture process metadata.
 */
export async function terminalWebFixture(t: TestContext): Promise<TerminalWebFixture> {
  const project = await terminalProject(t);
  project.repository.configure({ ...project.settings, terminals: { max: 1, idleMs: IDLE_MS, maximumMs: READ_MS } });
  const timers = new Map<() => void, number>();
  const pids = new Map<string, number>();
  const pool = brokerAdmission;
  const broker = await startBroker(project.mesh, {
    port: 0,
    factoryOptions: () => {
      return {
        agent: async () => {
          await Promise.resolve();
          assert.fail('Inference is disabled in the native terminal fixture.');
        },
        resources: () => ({ freeMemoryMb: 20_000, totalMemoryMb: 32_000, cpuPercent: 0 }),
        terminals: {
          clock: {
            later(callback, ms) {
              timers.set(callback, ms);
              return () => {
                timers.delete(callback);
              };
            },
          },
          preflight: async () => {
            await Promise.resolve();
          },
          inspectMcp: async () => {
            await Promise.resolve();
            return [];
          },
          spawn: (spec) => {
            return startTerminalProcess({
              ...spec,
              fixture: true,
              onFrame(frame) {
                if (frame.type === 'started') {
                  pids.set(path.basename(spec.artifact), frame.pid);
                }
                spec.onFrame(frame);
              },
            });
          },
        },
      };
    },
  });
  let brokerClosing: Promise<void> | null = null;
  const closeBroker = async (): Promise<void> => {
    brokerClosing ??= broker.close();
    await brokerClosing;
  };
  project.defer(closeBroker);
  const mesh = { ...project.mesh, url: brokerUrl(broker.port) };
  const web = await startWebConsole(mesh, 0);
  let webClosing: Promise<void> | null = null;
  const closeWeb = async (): Promise<void> => {
    webClosing ??= web.close();
    await webClosing;
  };
  project.defer(closeWeb);
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const cookie = (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  assert.notEqual(cookie, '');
  const headers = { Origin: web.url, Cookie: cookie, 'Content-Type': 'application/json' };

  /**
   * Apply one real paired browser control, without retrying writes.
   *
   * @param operation - Fixed operator operation.
   * @param input - Test-owned native input or geometry.
   * @returns Matching validated session metadata.
   */
  async function control(operation: string, input: Record<string, unknown>): Promise<TerminalView> {
    const response = await fetch(`${web.url}/api/control?project=home`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(READ_MS),
      body: JSON.stringify({ operation, input }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return terminalView(await response.json());
  }

  /**
   * Read and then really disconnect one SSE view; later calls resume the actual cursor.
   *
   * @param id - Owned native session identity.
   * @param after - Last applied transport cursor.
   * @param shouldAccept - Expected actual metadata/output condition.
   * @returns Last complete applied page and reassembled text.
   */
  async function read(
    id: string,
    after: number,
    shouldAccept: (page: TerminalPage, text: string) => boolean,
  ): Promise<Evidence> {
    const response = await fetch(`${web.url}/api/terminal-stream?project=home&id=${id}`, {
      headers: { ...headers, 'Last-Event-ID': String(after) },
      signal: AbortSignal.timeout(READ_MS),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.body !== null);
    const reader = response.body.getReader();
    try {
      return await readPages(reader, id, after, shouldAccept);
    } finally {
      await reader.cancel();
    }
  }

  const close = async (): Promise<void> => {
    try {
      await closeWeb();
    } finally {
      await closeBroker();
    }
  };
  return { broker, mesh, web, headers, pids, pool, timers, control, read, close };
}
