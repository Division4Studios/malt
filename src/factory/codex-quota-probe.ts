/**
 * Owned short-lived native account probe. Never starts a thread or model turn.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

import { z } from 'zod';

import { subscriptionEnvironment } from './authentication.ts';
import { terminateTree } from './commands.ts';
import { accountQuota } from './quota-windows.ts';

/** Bound native metadata output independently of the managed wrapper. */
const MAX_BYTES = 65_536;
/** Fixed metadata request identities. */
const INITIALIZE_ID = 0;
/** Account request identity. */
const QUOTA_ID = 1;
/** Native RPC responses are validated before nested data is inspected. */
const envelopeSchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
/** Only the configured executable is passed into this owned helper. */
const executable = z.string().min(1).parse(process.argv[2]);
const child = spawn(
  executable,
  [
    'app-server',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'model_provider="openai"',
    '-c',
    'mcp_servers={}',
    '--stdio',
  ],
  {
    cwd: process.cwd(),
    windowsHide: true,
    env: subscriptionEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
/** One bounded native transport state. */
const state = { buffer: '', bytes: 0, hasReading: false, isStopping: false };

/**
 * Stop only the native process tree owned by this probe.
 */
function stop(): void {
  if (state.isStopping) {
    return;
  }
  state.isStopping = true;
  child.stdin.end();
  if (child.pid !== undefined) {
    void terminateTree(child.pid);
  }
}

/**
 * Handle only initialization and a readonly account response.
 *
 * @param line - Native stdout JSON line.
 */
function receive(line: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.error !== undefined) {
    stop();
    return;
  }
  if (parsed.data.id === INITIALIZE_ID && parsed.data.result !== undefined) {
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: QUOTA_ID })}\n`);
  } else if (parsed.data.id === QUOTA_ID) {
    const reading = accountQuota(parsed.data.result);
    if (reading !== null) {
      state.hasReading = true;
      process.stdout.write(`${JSON.stringify(reading)}\n`);
    }
    stop();
  }
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  state.bytes += Buffer.byteLength(chunk);
  if (state.isStopping || state.bytes > MAX_BYTES) {
    stop();
    return;
  }
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    receive(line);
  }
});
// Vendor stderr can contain account details. The probe emits only normalized quota.
child.stderr.resume();
child.stdin.on('error', stop);
child.on('error', stop);
child.once('close', () => {
  process.exitCode = state.hasReading ? 0 : 1;
});
child.stdin.write(
  `${JSON.stringify({ method: 'initialize', id: INITIALIZE_ID, params: { clientInfo: { name: 'malt-quota', title: 'MALT quota probe', version: '0.1.0' } } })}\n`,
);
