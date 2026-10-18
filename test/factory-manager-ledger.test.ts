/**
 * Persistent manager ledger and stream decoding: generation fencing, explicit
 * delivery states, restart recovery, decisions and bounded provider streams.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManagerLedger } from '../src/factory/manager-ledger.ts';
import { LineDecoder, claudeInput, decodeManagerLine } from '../src/factory/manager-stream.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('manager messages move through fenced delivery states and never revive after a session ends', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let now = 1000;
  const store = new Store(config, { now: () => now });
  defer(() => {
    store.close();
  });
  const ledger = new ManagerLedger(store);
  const first = ledger.begin('claude', 'haiku');
  assert.throws(() => ledger.begin('claude', null), { code: 'FACTORY_GATED' }, 'Only one live generation.');
  const message = ledger.enqueue('operator', 'Ship checkout.');
  assert.equal(ledger.nextQueued()?.id, message.id);
  assert.equal(ledger.transition(message.id, first.generation, 'acknowledged'), false, 'No skipping states.');
  assert.ok(ledger.transition(message.id, first.generation, 'sent'));
  assert.equal(ledger.inFlight(first.generation)?.id, message.id);
  assert.ok(ledger.transition(message.id, first.generation, 'acknowledged'));
  assert.equal(ledger.transition(message.id, first.generation + 1, 'answered'), false, 'Other generations are fenced.');
  ledger.update(first.generation, { state: 'working', pid: 42, nativeSession: 'native-1' });
  now = 2000;
  ledger.update(first.generation, { state: 'failed', reason: 'Process exited.' });
  const failed = ledger.page().find((entry) => entry.id === message.id);
  assert.equal(failed?.state, 'failed', 'An unanswered message fails with its generation; nothing is resent.');
  assert.equal(ledger.update(first.generation, { state: 'waiting' }), false, 'An ended generation stays ended.');
  assert.equal(ledger.resumable('claude'), 'native-1');
  const second = ledger.begin('claude', null);
  assert.equal(second.generation, first.generation + 1);
  assert.equal(ledger.recoverAfterRestart(), second.generation);
  assert.equal(ledger.current()?.state, 'stopped');
});

await test('reports, decisions and cursors are durable and answered exactly once', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  const ledger = new ManagerLedger(store);
  const report = ledger.record('report', 'QA 1 approved #4.');
  assert.deepEqual(
    ledger.pendingReports().map((entry) => entry.id),
    [report.id],
  );
  const digest = ledger.enqueue('digest', 'Reports since your last update: …');
  ledger.markDelivered([report.id], digest.id);
  assert.deepEqual(ledger.pendingReports(), []);
  const decision = ledger.ask('Approve a 640-line exception for #7?', ['Approve', 'Split it'], 'diff: +600/-40');
  assert.deepEqual(
    ledger.openDecisions().map((entry) => entry.id),
    [decision.id],
  );
  assert.equal(ledger.answer(decision.id, 'Split it').answer, 'Split it');
  assert.throws(() => ledger.answer(decision.id, 'Approve'), { code: 'FACTORY_GATED' });
  assert.deepEqual(ledger.openDecisions(), []);
  ledger.advance('events', 10);
  ledger.advance('events', 4);
  assert.equal(ledger.cursor('events'), 10, 'Cursors never move backwards.');
  assert.ok(ledger.latestSeq() >= 2);
  assert.deepEqual(
    ledger.page(0, 1).map((entry) => entry.id),
    [report.id],
  );
});

await test('stream lines survive chunking, bound oversized input and ignore diagnostics', () => {
  const decoder = new LineDecoder(16);
  assert.deepEqual(decoder.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(decoder.push(':2}\r\n'), ['{"b":2}']);
  assert.deepEqual(decoder.push('x'.repeat(40)), []);
  assert.deepEqual(decoder.push('still too long\nok\n'), ['ok']);
  assert.equal(decoder.oversized, 1);
  assert.deepEqual(decodeManagerLine('claude', 'warning: not json'), []);
  assert.deepEqual(decodeManagerLine('claude', '{"type":"result"'), []);
});

await test('claude and codex events normalize to one manager event model', () => {
  const ack = JSON.stringify({ type: 'user', isReplay: true, uuid: 'm-1', message: { content: 'hi' } });
  assert.deepEqual(decodeManagerLine('claude', ack), [{ kind: 'ack', messageId: 'm-1' }]);
  const assistant = JSON.stringify({
    type: 'assistant',
    user_message_uuid: 'm-1',
    message: {
      content: [
        { type: 'text', text: 'Checking status.' },
        { type: 'tool_use', name: 'mesh_factory_brief' },
      ],
    },
  });
  assert.deepEqual(decodeManagerLine('claude', assistant), [
    { kind: 'text', replyTo: 'm-1', text: 'Checking status.' },
    { kind: 'tool', replyTo: 'm-1', name: 'mesh_factory_brief' },
  ]);
  const result = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  assert.deepEqual(decodeManagerLine('claude', result), [
    { kind: 'turn', isError: false, usageTokens: 12, detail: null },
  ]);
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-haiku' });
  assert.deepEqual(decodeManagerLine('claude', init), [{ kind: 'session', sessionId: 's-1', model: 'claude-haiku' }]);
  assert.deepEqual(decodeManagerLine('codex', JSON.stringify({ type: 'thread.started', thread_id: 't-1' })), [
    { kind: 'session', sessionId: 't-1', model: null },
  ]);
  const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ' Done. ' } });
  assert.deepEqual(decodeManagerLine('codex', message), [{ kind: 'text', replyTo: null, text: 'Done.' }]);
  const failed = JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } });
  assert.deepEqual(decodeManagerLine('codex', failed), [
    { kind: 'turn', isError: true, usageTokens: null, detail: 'usage limit' },
  ]);
  const input: unknown = JSON.parse(claudeInput('m-2', 'Status?'));
  assert.deepEqual(input, { type: 'user', uuid: 'm-2', message: { role: 'user', content: 'Status?' } });
});
