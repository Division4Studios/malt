/**
 * Decoders for the two supported provider event streams. Each JSON line is
 * validated with Zod before any field is read. Unknown event types are
 * counted rather than rendered, and malformed lines never throw.
 *
 * @file
 */

import { z } from 'zod/v3';

import type { TranscriptBuilder } from './transcript-builder.ts';

/** Claude tools whose input names a file being written, and the naming field. */
const CLAUDE_EDIT_TOOLS = new Map([
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);
/** Non-negative count that defaults to zero when omitted. */
const count = z.number().nonnegative().default(0);
/** Any JSON event: an object with a string type. */
const envelopeSchema = z.object({ type: z.string() }).passthrough();
/** One decoded event envelope. */
type Envelope = z.output<typeof envelopeSchema>;
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

/**
 * Decode one line into an event envelope, counting lines that are not JSON objects.
 *
 * @param builder - Accumulator that counts malformed lines.
 * @param line - One raw stream line.
 * @returns Validated envelope, or null for blank or malformed lines.
 */
function envelope(builder: TranscriptBuilder, line: string): Envelope | null {
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
function claudeToolUse(builder: TranscriptBuilder, tool: z.output<typeof toolUseBlockSchema>): void {
  builder.openTool(tool.id, tool.name, tool.input);
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
function claudeAssistantBlock(builder: TranscriptBuilder, block: unknown): void {
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
function claudeToolResult(builder: TranscriptBuilder, block: unknown): void {
  const result = toolResultBlockSchema.safeParse(block);
  if (!result.success) {
    return;
  }
  builder.closeTool(result.data.tool_use_id, resultText(result.data.content), {
    isError: result.data.is_error === true,
    exitCode: null,
  });
}

/**
 * Record a Claude message event (assistant output or user tool results).
 *
 * @param builder - Transcript accumulator.
 * @param event - Validated envelope.
 */
function claudeMessage(builder: TranscriptBuilder, event: Envelope): void {
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
function claudeResult(builder: TranscriptBuilder, event: Envelope): void {
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
function claudeRate(builder: TranscriptBuilder, event: Envelope): void {
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
function claudeSystem(builder: TranscriptBuilder, event: Envelope): void {
  const system = claudeSystemSchema.safeParse(event);
  if (!system.success) {
    builder.countUnknown();
    return;
  }
  if (system.data.model !== undefined) {
    builder.setModel(system.data.model);
  }
  const subtype = system.data.subtype ?? 'system';
  builder.text('status', subtype === 'init' ? 'Session started' : `System: ${subtype}`, system.data.model ?? '');
}

/** Claude event handlers keyed by event type. */
const CLAUDE_HANDLERS = new Map<string, (builder: TranscriptBuilder, event: Envelope) => void>([
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
export function claudeLine(builder: TranscriptBuilder, line: string): void {
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
