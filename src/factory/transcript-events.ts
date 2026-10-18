/**
 * Decoders for the two supported provider event streams. Each JSON line is
 * validated with Zod before any field is read. Unknown event types are
 * counted rather than rendered, and malformed lines never throw.
 *
 * @file
 */
import { z } from 'zod/v3';

import type { TranscriptBuilder } from './transcript-builder.ts';

/** What a decoder writes to: the transcript builder, or the liveness progress decoder. */
export type TranscriptSink = Pick<
  TranscriptBuilder,
  | 'text'
  | 'openTool'
  | 'closeTool'
  | 'touch'
  | 'addUsage'
  | 'report'
  | 'addTurn'
  | 'setModel'
  | 'countMalformed'
  | 'countUnknown'
  | 'markProviderError'
  | 'awaitInput'
> & {
  /** Record a provider file change; `id` is the provider item, so separate patches to one file stay distinct. */
  readonly fileChange: (changes: readonly { path: string; kind: string }[], id: string) => void;
};

/** Claude tools whose input names a file being written, and the naming field. */
const CLAUDE_EDIT_TOOLS = new Map([
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);
/** Claude tools that stop to ask the operator a question. */
const CLAUDE_INPUT_TOOLS = new Set(['AskUserQuestion']);
/** Tool results that mean the provider is waiting for a permission it was not given. */
const PERMISSION_PATTERN =
  /haven't granted|permission (?:denied|required|to use)|requested permissions?|requires? (?:your )?approval|waiting for (?:user )?(?:approval|input)/iv;
/** Session notices and Codex event or item types that wait for operator input or approval. */
const INPUT_WAIT_PATTERN = /approval|elicitation|permission|request_input|user_input/iv;
/** Phrases that identify provider rate or usage limits in error text. */
const LIMIT_PATTERN = /rate.?limit|usage.?limit|quota/iv;
/** Codex item statuses that mean the call did not succeed. */
const FAILED_STATUSES = new Set(['failed', 'declined']);
/** Non-negative count that defaults to zero when omitted. */
const count = z.number().nonnegative().default(0);
/** Any JSON event: an object with a string type. */
const envelopeSchema = z.object({ type: z.string() }).passthrough();
/** One decoded event envelope. */
type Envelope = z.output<typeof envelopeSchema>;
/** A Codex item: identity, type and untrusted fields. */
type Item = { id: string; type: string } & Record<string, unknown>;
/** Codex item lifecycle phase. */
type Phase = 'started' | 'updated' | 'completed';
/** Arbitrary object fields. */
const fieldsSchema = z.record(z.unknown());

/** Claude's documented usage report. */
const claudeUsageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: count,
  cache_read_input_tokens: count,
});
/** Claude's session initialization. */
const claudeSystemSchema = z.object({ subtype: z.string().optional(), model: z.string().optional() });
/** Claude message content: plain text or content blocks. */
const contentSchema = z.union([z.string(), z.array(z.unknown())]);
/** Claude message body. */
const messageBodySchema = z.object({ content: contentSchema, model: z.string().optional() });
/** Claude assistant or user message wrapper. */
const claudeMessageSchema = z.object({ message: messageBodySchema });
/** Claude assistant text. */
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
/** Claude extended thinking. */
const thinkingBlockSchema = z.object({ type: z.literal('thinking'), thinking: z.string() });
/** Claude tool invocation. */
const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
/** Claude tool result returned to the model. */
const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
/** One part of a tool result. */
const resultPartSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
/** Text parts of a tool result. */
const resultPartsSchema = z.array(resultPartSchema);
/** Claude's final event. */
const claudeResultSchema = z.object({
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  usage: claudeUsageSchema.optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  duration_api_ms: z.number().nonnegative().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  structured_output: z.unknown().optional(),
});
/** Claude's native rate-limit status. */
const rateInfoSchema = z.object({ status: z.string() }).passthrough();
/** Claude's native rate-limit report. */
const claudeRateSchema = z.object({ rate_limit_info: rateInfoSchema });

/** Codex per-turn usage report. */
const codexUsageSchema = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count,
  output_tokens: count,
  reasoning_output_tokens: z.number().nonnegative().optional(),
});
/** Codex item identity. */
const itemSchema = z.object({ id: z.string(), type: z.string() }).passthrough();
/** Codex item lifecycle event. */
const codexItemEventSchema = z.object({ item: itemSchema });
/** Codex message or reasoning text. */
const codexTextSchema = z.object({ text: z.string() });
/** Codex shell command. */
const codexCommandSchema = z.object({
  command: z.string(),
  aggregated_output: z.string().optional(),
  exit_code: z.number().int().nullable().optional(),
  status: z.string().optional(),
});
/** One Codex file change. */
const changeSchema = z.object({ path: z.string(), kind: z.string() });
/** Codex workspace patch. */
const codexFileChangeSchema = z.object({ changes: z.array(changeSchema) });
/** Codex MCP tool call. */
const codexMcpSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  status: z.string().optional(),
});
/** MCP result content wrapper. */
const mcpContentSchema = z.object({ content: z.unknown() });
/** Codex web search. */
const codexSearchSchema = z.object({ query: z.string() });
/** One Codex plan entry. */
const todoItemSchema = z.object({ text: z.string(), completed: z.boolean() });
/** Codex plan list. */
const codexTodoSchema = z.object({ items: z.array(todoItemSchema) });
/** Error payload carrying a message. */
const messageSchema = z.object({ message: z.string() });
/** Codex turn failure. */
const codexFailureSchema = z.object({ error: messageSchema.optional() });

/**
 * Decode one line into an event envelope, counting lines that are not JSON objects.
 *
 * @param builder - Accumulator that counts malformed lines.
 * @param line - One raw stream line.
 * @returns Validated envelope, or null for blank or malformed lines.
 */
function envelope(builder: TranscriptSink, line: string): Envelope | null {
  if (line.trim() === '') {
    return null;
  }
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(line));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Non-JSON diagnostics are counted below rather than thrown.
  }
  builder.countMalformed();
  return null;
}

/**
 * Flatten a tool result's content into display text.
 *
 * @param content - Untrusted result content (string or content blocks).
 * @returns Joined text, with non-text parts named.
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  const parts = resultPartsSchema.safeParse(content);
  if (!parts.success) {
    return content === undefined ? '' : JSON.stringify(content);
  }
  return parts.data.map((part) => part.text ?? `[${part.type}]`).join('\n');
}

/**
 * Record a Claude tool invocation and the file it edits, if any.
 *
 * @param builder - Transcript accumulator.
 * @param tool - Validated tool use block.
 */
function claudeToolUse(builder: TranscriptSink, tool: z.output<typeof toolUseBlockSchema>): void {
  builder.openTool(tool.id, tool.name, tool.input);
  if (CLAUDE_INPUT_TOOLS.has(tool.name)) {
    builder.awaitInput(`Question through ${tool.name}`, tool.id);
  }
  const key = CLAUDE_EDIT_TOOLS.get(tool.name);
  const fields = fieldsSchema.safeParse(tool.input);
  const target = key === undefined || !fields.success ? undefined : fields.data[key];
  if (typeof target === 'string' && target !== '') {
    builder.touch(target);
  }
}

/**
 * Record a Claude assistant content block.
 *
 * @param builder - Transcript accumulator.
 * @param block - Untrusted content block.
 */
function claudeAssistantBlock(builder: TranscriptSink, block: unknown): void {
  const text = textBlockSchema.safeParse(block);
  if (text.success) {
    builder.text('assistant', 'Assistant', text.data.text);
    return;
  }
  const thinking = thinkingBlockSchema.safeParse(block);
  if (thinking.success) {
    builder.text('thinking', 'Thinking', thinking.data.thinking);
    return;
  }
  const tool = toolUseBlockSchema.safeParse(block);
  if (tool.success) {
    claudeToolUse(builder, tool.data);
  }
}

/**
 * Pair a Claude tool result block with its call.
 *
 * @param builder - Transcript accumulator.
 * @param block - Untrusted content block from a user message.
 */
function claudeToolResult(builder: TranscriptSink, block: unknown): void {
  const result = toolResultBlockSchema.safeParse(block);
  if (!result.success) {
    return;
  }
  const output = resultText(result.data.content);
  const isError = result.data.is_error === true;
  if (isError && PERMISSION_PATTERN.test(output)) {
    builder.awaitInput('Permission not granted for a tool call', result.data.tool_use_id);
  }
  builder.closeTool(result.data.tool_use_id, output, { isError, exitCode: null });
}

/**
 * Record a Claude message event (assistant output or user tool results).
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function claudeMessage(builder: TranscriptSink, event: Envelope): void {
  const message = claudeMessageSchema.safeParse(event);
  if (!message.success || typeof message.data.message.content === 'string') {
    return;
  }
  const isAssistant = event.type === 'assistant';
  if (isAssistant && message.data.message.model !== undefined) {
    builder.setModel(message.data.message.model);
  }
  for (const block of message.data.message.content) {
    if (isAssistant) {
      claudeAssistantBlock(builder, block);
    } else {
      claudeToolResult(builder, block);
    }
  }
}

/**
 * Choose the display body of Claude's final event.
 *
 * @param result - Validated final event.
 * @returns Result text, structured output or error list.
 */
function resultBody(result: z.output<typeof claudeResultSchema>): string {
  if (result.result !== undefined) {
    return result.result;
  }
  return result.structured_output === undefined
    ? (result.errors ?? []).join('\n')
    : JSON.stringify(result.structured_output);
}

/**
 * Record Claude's final result, usage, cost and turn count.
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function claudeResult(builder: TranscriptSink, event: Envelope): void {
  const parsed = claudeResultSchema.safeParse(event);
  if (!parsed.success) {
    builder.countUnknown();
    return;
  }
  const result = parsed.data;
  if (result.usage !== undefined) {
    builder.addUsage({
      input: result.usage.input_tokens,
      cacheRead: result.usage.cache_read_input_tokens,
      cacheWrite: result.usage.cache_creation_input_tokens,
      output: result.usage.output_tokens,
      reasoning: null,
    });
  }
  builder.report({
    ...(result.total_cost_usd !== undefined && { costUsd: result.total_cost_usd }),
    ...(result.num_turns !== undefined && { turns: result.num_turns }),
    ...(result.duration_api_ms !== undefined && { apiDurationMs: result.duration_api_ms }),
  });
  if (result.is_error !== true) {
    builder.text('result', 'Result', resultBody(result));
    return;
  }
  builder.markProviderError();
  const suffix = result.subtype === undefined ? '' : ` (${result.subtype})`;
  builder.text('result', `Error result${suffix}`, resultBody(result), 'error');
}

/**
 * Record a Claude rate-limit notice when the provider is not simply allowing requests.
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function claudeRate(builder: TranscriptSink, event: Envelope): void {
  const rate = claudeRateSchema.safeParse(event);
  if (!rate.success || rate.data.rate_limit_info.status === 'allowed') {
    return;
  }
  const { status } = rate.data.rate_limit_info;
  const level = status === 'rejected' ? 'error' : 'warning';
  builder.text('status', 'Rate limit', `Provider rate limit status: ${status}.`, level);
}

/**
 * Record a Claude session notice.
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function claudeSystem(builder: TranscriptSink, event: Envelope): void {
  const system = claudeSystemSchema.safeParse(event);
  if (!system.success) {
    builder.countUnknown();
    return;
  }
  if (system.data.model !== undefined) {
    builder.setModel(system.data.model);
  }
  const subtype = system.data.subtype ?? 'system';
  if (INPUT_WAIT_PATTERN.test(subtype)) {
    builder.awaitInput(`Session notice: ${subtype}`, null);
  }
  builder.text('status', subtype === 'init' ? 'Session started' : `System: ${subtype}`, system.data.model ?? '');
}

/** Claude event handlers keyed by event type. */
const CLAUDE_HANDLERS = new Map<string, (builder: TranscriptSink, event: Envelope) => void>([
  ['system', claudeSystem],
  ['rate_limit_event', claudeRate],
  ['assistant', claudeMessage],
  ['user', claudeMessage],
  ['result', claudeResult],
]);

/**
 * Decode one Claude `stream-json` line.
 *
 * @param builder - Transcript accumulator.
 * @param line - One raw stream line.
 */
export function claudeLine(builder: TranscriptSink, line: string): void {
  const event = envelope(builder, line);
  if (event === null) {
    return;
  }
  const handler = CLAUDE_HANDLERS.get(event.type);
  if (handler === undefined) {
    builder.countUnknown();
    return;
  }
  handler(builder, event);
}

/**
 * Record a Codex shell command start or completion.
 *
 * @param builder - Transcript accumulator.
 * @param item - Untrusted item.
 * @param phase - Lifecycle phase.
 */
function codexCommand(builder: TranscriptSink, item: Item, phase: Phase): void {
  const command = codexCommandSchema.safeParse(item);
  if (!command.success) {
    builder.countUnknown();
    return;
  }
  builder.openTool(item.id, 'shell', { command: command.data.command });
  if (phase !== 'completed') {
    return;
  }
  const exitCode = command.data.exit_code ?? null;
  const hasFailed = FAILED_STATUSES.has(command.data.status ?? '') || (exitCode !== null && exitCode !== 0);
  builder.closeTool(item.id, command.data.aggregated_output ?? '', { isError: hasFailed, exitCode });
}

/**
 * Record a Codex MCP tool call start or completion.
 *
 * @param builder - Transcript accumulator.
 * @param item - Untrusted item.
 * @param phase - Lifecycle phase.
 */
function codexMcp(builder: TranscriptSink, item: Item, phase: Phase): void {
  const call = codexMcpSchema.safeParse(item);
  if (!call.success) {
    builder.countUnknown();
    return;
  }
  builder.openTool(item.id, `${call.data.server}.${call.data.tool}`, call.data.arguments);
  if (phase !== 'completed') {
    return;
  }
  const failure = messageSchema.safeParse(call.data.error);
  const content = mcpContentSchema.safeParse(call.data.result);
  const output = resultText(content.success ? content.data.content : call.data.result);
  builder.closeTool(item.id, failure.success ? failure.data.message : output, {
    isError: failure.success || FAILED_STATUSES.has(call.data.status ?? ''),
    exitCode: null,
  });
}

/**
 * Record a Codex web search start or completion.
 *
 * @param builder - Transcript accumulator.
 * @param item - Untrusted item.
 * @param phase - Lifecycle phase.
 */
function codexSearch(builder: TranscriptSink, item: Item, phase: Phase): void {
  const search = codexSearchSchema.safeParse(item);
  builder.openTool(item.id, 'web_search', { query: search.success ? search.data.query : '' });
  if (phase === 'completed') {
    builder.closeTool(item.id, '', { isError: false, exitCode: null });
  }
}

/**
 * Record a completed Codex message, reasoning, change, plan or error item.
 *
 * @param builder - Transcript accumulator.
 * @param item - Untrusted item.
 */
function codexCompleted(builder: TranscriptSink, item: Item): void {
  const text = codexTextSchema.safeParse(item);
  const changes = codexFileChangeSchema.safeParse(item);
  const todo = codexTodoSchema.safeParse(item);
  const failure = messageSchema.safeParse(item);
  if (item.type === 'agent_message' && text.success) {
    builder.text('assistant', 'Assistant', text.data.text);
  } else if (item.type === 'reasoning' && text.success) {
    builder.text('thinking', 'Thinking', text.data.text);
  } else if (item.type === 'file_change' && changes.success) {
    builder.fileChange(changes.data.changes, item.id);
  } else if (item.type === 'todo_list' && todo.success) {
    const lines = todo.data.items.map((entry) => `${entry.completed ? '[x]' : '[ ]'} ${entry.text}`);
    builder.text('status', 'Plan', lines.join('\n'));
  } else if (item.type === 'error' && failure.success) {
    builder.text('status', 'Provider error', failure.data.message, 'error');
  } else {
    builder.countUnknown();
  }
}

/** Codex tool-like item handlers keyed by item type. */
const CODEX_TOOLS = new Map<string, (builder: TranscriptSink, item: Item, phase: Phase) => void>([
  ['command_execution', codexCommand],
  ['mcp_tool_call', codexMcp],
  ['web_search', codexSearch],
]);

/**
 * Record one Codex item lifecycle event.
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 * @param phase - Lifecycle phase from the event type.
 */
function codexItem(builder: TranscriptSink, event: Envelope, phase: Phase): void {
  const parsed = codexItemEventSchema.safeParse(event);
  if (!parsed.success) {
    builder.countUnknown();
    return;
  }
  const { item } = parsed.data;
  const tool = CODEX_TOOLS.get(item.type);
  if (INPUT_WAIT_PATTERN.test(item.type)) {
    builder.awaitInput(`Waiting on ${item.type}`, item.id);
  } else if (tool !== undefined) {
    tool(builder, item, phase);
  } else if (phase === 'completed') {
    codexCompleted(builder, item);
  }
}

/**
 * Record a Codex turn's usage.
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function codexTurn(builder: TranscriptSink, event: Envelope): void {
  builder.addTurn();
  const usage = codexUsageSchema.safeParse(event['usage']);
  if (!usage.success) {
    return;
  }
  const { data } = usage;
  builder.addUsage({
    input: Math.max(0, data.input_tokens - data.cached_input_tokens),
    cacheRead: data.cached_input_tokens,
    cacheWrite: data.cache_write_input_tokens,
    output: data.output_tokens,
    reasoning: data.reasoning_output_tokens ?? null,
  });
}

/**
 * Record a Codex failed turn or stream error.
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function codexError(builder: TranscriptSink, event: Envelope): void {
  const isTurn = event.type === 'turn.failed';
  const turnMessage = codexFailureSchema.safeParse(event).data?.error?.message;
  const streamMessage = messageSchema.safeParse(event).data?.message;
  const message = (isTurn ? turnMessage : streamMessage) ?? 'The provider reported an error.';
  if (isTurn) {
    builder.markProviderError();
  }
  const fallback = isTurn ? 'Turn failed' : 'Provider error';
  builder.text('status', LIMIT_PATTERN.test(message) ? 'Rate limit' : fallback, message, 'error');
}

/**
 * Record a Codex session start.
 *
 * @param builder - Transcript accumulator.
 */
function codexSession(builder: TranscriptSink): void {
  builder.text('status', 'Session started', '');
}

/** Accept a lifecycle event that carries nothing worth showing. */
function ignoreEvent(): void {
  // Turn starts are implied by the items and usage that follow.
}

/** Codex lifecycle handlers keyed by event type. */
const CODEX_LIFECYCLE = new Map<string, (builder: TranscriptSink, event: Envelope) => void>([
  ['turn.completed', codexTurn],
  ['turn.failed', codexError],
  ['error', codexError],
  ['thread.started', codexSession],
  ['turn.started', ignoreEvent],
]);
/** Codex item event types and their lifecycle phase. */
const CODEX_PHASES = new Map<string, Phase>([
  ['item.started', 'started'],
  ['item.updated', 'updated'],
  ['item.completed', 'completed'],
]);

/**
 * Decode one Codex `exec --json` line.
 *
 * @param builder - Transcript accumulator.
 * @param line - One raw stream line.
 */
export function codexLine(builder: TranscriptSink, line: string): void {
  const event = envelope(builder, line);
  if (event === null) {
    return;
  }
  const phase = CODEX_PHASES.get(event.type);
  const lifecycle = CODEX_LIFECYCLE.get(event.type);
  if (phase !== undefined) {
    codexItem(builder, event, phase);
  } else if (INPUT_WAIT_PATTERN.test(event.type)) {
    builder.awaitInput(`Waiting on ${event.type}`, null);
  } else if (lifecycle === undefined) {
    builder.countUnknown();
  } else {
    lifecycle(builder, event);
  }
}
