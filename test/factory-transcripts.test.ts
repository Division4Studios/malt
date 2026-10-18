/**
 * Transcript normalization of synthetic Claude and Codex provider streams:
 * tool pairing, errors, truncation, touched files and malformed lines.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readStreamLines } from '../src/factory/attempt-stream.ts';
import { estimateCost } from '../src/factory/price-table.ts';
import { NODES_MAX, TranscriptBuilder } from '../src/factory/transcript-builder.ts';
import { normalizeLines } from '../src/factory/transcripts.ts';

/**
 * Serialize synthetic events as stream lines.
 *
 * @param events - Event objects or raw lines.
 * @returns JSON lines.
 */
function lines(...events: unknown[]): string[] {
  return events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)));
}

/** A Claude run with paired, failed and unfinished tool calls. */
const claudeStream = lines(
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test-model', tools: ['Edit'] },
  {
    type: 'assistant',
    message: {
      model: 'claude-test-model',
      content: [
        { type: 'thinking', thinking: 'Plan the change.' },
        { type: 'text', text: 'Editing the file.' },
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Edit',
          input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        },
        { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm   test', description: 'Run tests' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu2', content: 'tests failed', is_error: true },
        { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'edited' }] },
      ],
    },
  },
  'not json at all',
  { type: 'stream_event', event: {} },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu3', name: 'Edit', input: { file_path: 'src/a.ts' } },
        { type: 'tool_use', id: 'tu4', name: 'Write', input: { file_path: 'src/b.ts', content: 'x' } },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'ok' }] } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 400 },
    total_cost_usd: 0.25,
    duration_ms: 9000,
    duration_api_ms: 7000,
    num_turns: 3,
  },
);

void test('Claude streams pair tool results, mark failures and unfinished calls, and count files', () => {
  const parsed = normalizeLines(claudeStream, 'claude', {
    isCollecting: true,
    isLive: false,
    prompt: { text: 'Line one\nLine two', truncated: false },
  });
  assert.deepEqual(
    parsed.nodes.map((node) => node.kind),
    ['input', 'status', 'thinking', 'assistant', 'tool', 'tool', 'tool', 'tool', 'status', 'result'],
  );
  const tools = parsed.nodes.filter((node) => node.kind === 'tool').map((node) => node.tool);
  assert.deepEqual(
    tools.map((tool) => [tool?.id, tool?.status, tool?.summary]),
    [
      ['tu1', 'ok', 'src/a.ts'],
      ['tu2', 'error', 'npm test'],
      ['tu3', 'ok', 'src/a.ts'],
      ['tu4', 'incomplete', 'src/b.ts'],
    ],
  );
  assert.equal(tools[0]?.output, 'edited');
  assert.equal(tools[1]?.output, 'tests failed');
  assert.equal(parsed.nodes.find((node) => node.tool?.id === 'tu2')?.level, 'error');
  assert.deepEqual(parsed.files, [
    { path: 'src/a.ts', touches: 2 },
    { path: 'src/b.ts', touches: 1 },
  ]);
  const { digest } = parsed;
  assert.deepEqual(digest.tokens, { input: 100, cacheRead: 400, cacheWrite: 20, output: 50, reasoning: null });
  assert.equal(digest.reportedCostUsd, 0.25);
  assert.equal(digest.turns, 3);
  assert.equal(digest.apiDurationMs, 7000);
  assert.equal(digest.model, 'claude-test-model');
  assert.equal(digest.malformedLines, 1);
  assert.equal(digest.unknownEvents, 1);
  assert.deepEqual(digest.tools, {
    total: 4,
    failed: 1,
    byName: [
      { name: 'Edit', calls: 2, failed: 0 },
      { name: 'Bash', calls: 1, failed: 1 },
      { name: 'Write', calls: 1, failed: 0 },
    ],
  });
  assert.equal(digest.filesTouched, 2);
  assert.equal(digest.providerError, false);
  const live = normalizeLines(claudeStream, 'claude', { isCollecting: true, isLive: true });
  assert.equal(live.nodes.find((node) => node.tool?.id === 'tu4')?.tool?.status, 'running');
});

void test('Claude error results and rejected rate limits become error markers', () => {
  const parsed = normalizeLines(
    lines(
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1 } },
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Too many turns'] },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'late' }] } },
    ),
    'claude',
    { isCollecting: true, isLive: false },
  );
  assert.deepEqual(
    parsed.nodes.map((node) => [node.kind, node.label, node.level]),
    [
      ['status', 'Rate limit', 'error'],
      ['result', 'Error result (error_max_turns)', 'error'],
      ['tool', 'unknown', 'info'],
    ],
  );
  assert.equal(parsed.nodes[1]?.text, 'Too many turns');
  assert.equal(parsed.nodes[2]?.tool?.output, 'late');
  assert.equal(parsed.digest.providerError, true);
  assert.equal(parsed.digest.tokens, null);
  assert.equal(parsed.digest.reportedCostUsd, null, 'An absent cost stays unknown, never zero.');
});

/** A Codex run with a failing command, a patch, an MCP call and two turns. */
const codexStream = lines(
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
  {
    type: 'item.completed',
    item: {
      id: 'c1',
      type: 'command_execution',
      command: 'npm test',
      aggregated_output: '1 failing',
      exit_code: 1,
      status: 'failed',
    },
  },
  { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Fix the assertion.' } },
  {
    type: 'item.completed',
    item: {
      id: 'f1',
      type: 'file_change',
      status: 'completed',
      changes: [
        { path: 'src/x.ts', kind: 'update' },
        { path: 'src/y.ts', kind: 'add' },
      ],
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'm1',
      type: 'mcp_tool_call',
      server: 'agentmesh',
      tool: 'mesh_whoami',
      arguments: {},
      result: { content: [{ type: 'text', text: 'factory-developer-1' }] },
      status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: { id: 'c2', type: 'command_execution', command: 'npm run lint', status: 'in_progress' },
  },
  { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Fixed.' } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 },
  },
  { type: 'error', message: 'You have hit your usage limit.' },
  '{"broken": ',
  { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 5 } },
  { type: 'item.completed', item: { id: 'x1', type: 'mystery' } },
);

void test('Codex streams pair items by id, keep exit codes and sum per-turn usage', () => {
  const parsed = normalizeLines(codexStream, 'codex', { isCollecting: true, isLive: false });
  assert.deepEqual(
    parsed.nodes.map((node) => node.kind),
    ['status', 'tool', 'thinking', 'file_change', 'tool', 'tool', 'assistant', 'status'],
  );
  const command = parsed.nodes[1]?.tool;
  assert.deepEqual(
    [command?.name, command?.summary, command?.status, command?.exitCode, command?.output],
    ['shell', 'npm test', 'error', 1, '1 failing'],
  );
  const mcp = parsed.nodes[4]?.tool;
  assert.ok(mcp !== undefined && mcp !== null);
  assert.equal(mcp.name, 'agentmesh.mesh_whoami');
  assert.equal(mcp.output, 'factory-developer-1');
  assert.equal(parsed.nodes[5]?.tool?.status, 'incomplete');
  assert.deepEqual(parsed.nodes[3]?.changes, [
    { path: 'src/x.ts', kind: 'update' },
    { path: 'src/y.ts', kind: 'add' },
  ]);
  assert.deepEqual(parsed.nodes[7]?.label, 'Rate limit');
  assert.deepEqual(parsed.digest.tokens, { input: 800, cacheRead: 400, cacheWrite: 0, output: 55, reasoning: 10 });
  assert.equal(parsed.digest.turns, 2);
  assert.equal(parsed.digest.reportedCostUsd, null);
  assert.equal(parsed.digest.malformedLines, 1);
  assert.equal(parsed.digest.unknownEvents, 1);
  assert.equal(parsed.digest.filesTouched, 2);
  assert.deepEqual(
    parsed.files.map((file) => file.path),
    ['src/x.ts', 'src/y.ts'],
  );
  const metricsOnly = normalizeLines(codexStream, 'codex', { isCollecting: false, isLive: false });
  assert.deepEqual(metricsOnly.nodes, []);
  assert.deepEqual(metricsOnly.digest, parsed.digest);
});

void test('node counts and text sizes are bounded and truncation is reported', () => {
  const long = 'x'.repeat(10_000);
  const events = Array.from({ length: NODES_MAX + 50 }, (_, index) => {
    return {
      type: 'item.completed',
      item: { id: `a${String(index)}`, type: 'agent_message', text: index === 0 ? long : 'ok' },
    };
  });
  const parsed = normalizeLines(
    lines(
      {
        type: 'item.started',
        item: { id: 'big', type: 'mcp_tool_call', server: 's', tool: 't', arguments: { blob: long } },
      },
      ...events,
      {
        type: 'item.completed',
        item: { id: 'big', type: 'mcp_tool_call', server: 's', tool: 't', result: long, status: 'completed' },
      },
    ),
    'codex',
    { isCollecting: true, isLive: false },
  );
  assert.equal(parsed.nodes.length, NODES_MAX);
  assert.equal(parsed.nodesTruncated, true);
  const [tool, first] = parsed.nodes;
  assert.ok(tool?.tool !== undefined && tool.tool !== null);
  assert.equal(tool.tool.inputTruncated, true);
  assert.equal(tool.tool.outputTruncated, true, 'A result still pairs with a stored call after the node cap.');
  assert.ok(tool.tool.output.length < long.length);
  assert.ok(first !== undefined);
  assert.equal(first.truncated, true);
  assert.equal(first.text.length, 4000);
  assert.equal(parsed.digest.tools.total, 1, 'Metrics keep counting beyond the node cap.');
});

await test('oversized change events and long paths are bounded and marked truncated', () => {
  const builder = new TranscriptBuilder(true);
  builder.fileChange(
    Array.from({ length: 501 }, (_, index) => ({ path: `src/file-${String(index)}.ts`, kind: 'update' })),
  );
  builder.touch(`deep/${'a'.repeat(5000)}.ts`);
  const parsed = builder.finish(false);
  assert.equal(parsed.nodes.at(0)?.truncated, true, 'a change event over the file cap says so');
  assert.equal(parsed.filesTruncated, true);
  assert.ok(
    parsed.files.every((file) => file.path.length <= 4000),
    'touched paths are clipped like other text',
  );
});

await test('usage with an unknown cache component is never priced as zero', () => {
  const price = { model: 'm', input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 4 };
  const known = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000, reasoning: null, total: 2_000_000 };
  assert.equal(estimateCost(known, price), 5);
  assert.equal(estimateCost({ ...known, cacheRead: null }, price), null);
  assert.equal(estimateCost({ ...known, cacheWrite: null }, price), null);
});

await test('malformed known events count as unknown and failed patches change no files', () => {
  const claude = normalizeLines(lines({ type: 'assistant' }, { type: 'rate_limit_event' }), 'claude', {
    isCollecting: true,
    isLive: false,
  });
  assert.equal(claude.digest.unknownEvents, 2);
  const codex = normalizeLines(
    lines({
      type: 'item.completed',
      item: { id: 'i1', type: 'file_change', status: 'failed', changes: [{ path: 'src/a.ts', kind: 'update' }] },
    }),
    'codex',
    { isCollecting: true, isLive: false },
  );
  assert.deepEqual(codex.files, []);
  assert.ok(codex.nodes.some((node) => node.label === 'Patch failed'));
});

await test('a stream cut inside an event never hands the fragment to the decoder', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'malt-stream-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'stdout.log');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture file in this test's own temporary directory.
  await writeFile(file, '{"type":"a"}\n{"type":"b"}\n{"type":"c","text":"cut off');
  const seen: string[] = [];
  const read = await readStreamLines({ file, size: 46, mtimeMs: 0 }, (line) => {
    seen.push(line);
  });
  assert.equal(read.available, true);
  assert.deepEqual(seen, ['{"type":"a"}', '{"type":"b"}']);
});
