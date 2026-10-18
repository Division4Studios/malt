/**
 * Bounded decoding of persistent manager streams. Native CLIs emit JSON lines
 * that may arrive split across chunks, interleaved with diagnostics or larger
 * than any sensible event. Lines are bounded, malformed input never becomes
 * state, and both supported providers normalize to one small event model.
 *
 * @file
 */

/** Longest accepted event line; larger lines are discarded and counted. */
export const MANAGER_LINE_MAX = 1_048_576;
/** Longest retained assistant text per event. */
const TEXT_MAX = 64_000;

/** Normalized manager stream event. */
export type ManagerEvent =
  | { readonly kind: 'session'; readonly sessionId: string; readonly model: string | null }
  | { readonly kind: 'ack'; readonly messageId: string }
  | { readonly kind: 'text'; readonly replyTo: string | null; readonly text: string }
  | { readonly kind: 'tool'; readonly replyTo: string | null; readonly name: string }
  | {
      readonly kind: 'turn';
      readonly isError: boolean;
      readonly usageTokens: number | null;
      readonly detail: string | null;
    }
  | { readonly kind: 'rate'; readonly info: unknown }
  | { readonly kind: 'error'; readonly message: string };

/** Splits a text stream into bounded lines across arbitrary chunk boundaries. */
export class LineDecoder {
  /** Lines discarded for exceeding the bound. */
  public oversized = 0;
  /** Pending partial line. */
  private pending = '';
  /** Whether the current line already exceeded the bound and is being discarded. */
  private isDiscarding = false;
  /** Maximum line length. */
  private readonly max: number;

  /**
   * Prepare a decoder.
   *
   * @param max - Maximum accepted line length in UTF-16 units.
   */
  public constructor(max = MANAGER_LINE_MAX) {
    this.max = max;
  }

  /**
   * Accept a chunk and return every completed line.
   *
   * @param chunk - Newly received text.
   * @returns Complete, bounded lines without terminators.
   */
  public push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (let index = rest.indexOf('\n'); index !== -1; index = rest.indexOf('\n')) {
      const piece = rest.slice(0, index);
      rest = rest.slice(index + 1);
      if (this.isDiscarding || this.pending.length + piece.length > this.max) {
        this.oversized += this.isDiscarding ? 0 : 1;
        this.isDiscarding = false;
        this.pending = '';
        continue;
      }
      lines.push(`${this.pending}${piece}`.replace(/\r$/v, ''));
      this.pending = '';
    }
    if (!this.isDiscarding) {
      this.pending += rest;
      if (this.pending.length > this.max) {
        this.oversized += 1;
        this.isDiscarding = true;
        this.pending = '';
      }
    }
    return lines;
  }
}

/**
 * Narrow decoded JSON to a plain object.
 *
 * @param value - Decoded JSON.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an optional string field.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @returns The string, or null.
 */
function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Sum actual reported token counts, null when none are reported.
 *
 * @param usage - Native usage object.
 * @returns Token total or null.
 */
function tokens(usage: unknown): number | null {
  if (!isRecord(usage)) {
    return null;
  }
  const keys = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  const counts = keys.map((key) => usage[key]).filter((value): value is number => typeof value === 'number');
  return counts.length === 0 ? null : counts.reduce((sum, value) => sum + value, 0);
}

/**
 * Bound assistant text.
 *
 * @param text - Native text.
 * @returns Bounded text.
 */
function bounded(text: string): string {
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;
}

/**
 * Normalize one Claude assistant message into text and tool events.
 *
 * @param event - Native assistant event.
 * @returns Normalized events.
 */
function claudeAssistant(event: Record<string, unknown>): ManagerEvent[] {
  const replyTo = textField(event, 'user_message_uuid');
  const { message } = event;
  const content = isRecord(message) ? message['content'] : null;
  if (!Array.isArray(content)) {
    return [];
  }
  const events: ManagerEvent[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      texts.push(block['text']);
    } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      events.push({ kind: 'tool', replyTo, name: block['name'] });
    }
  }
  const text = texts.join('\n').trim();
  return text === '' ? events : [{ kind: 'text', replyTo, text: bounded(text) }, ...events];
}

/**
 * Normalize one Claude stream-json event.
 *
 * @param event - Decoded event.
 * @returns Normalized events; unknown events produce none.
 */
function claudeEvent(event: Record<string, unknown>): ManagerEvent[] {
  const type = textField(event, 'type');
  if (type === 'system' && event['subtype'] === 'init') {
    const sessionId = textField(event, 'session_id');
    return sessionId === null ? [] : [{ kind: 'session', sessionId, model: textField(event, 'model') }];
  }
  if (type === 'user' && event['isReplay'] === true) {
    const messageId = textField(event, 'uuid');
    return messageId === null ? [] : [{ kind: 'ack', messageId }];
  }
  if (type === 'assistant') {
    return claudeAssistant(event);
  }
  if (type === 'result') {
    const isError = event['is_error'] === true || event['subtype'] !== 'success';
    const detail = isError ? (textField(event, 'result') ?? textField(event, 'subtype')) : null;
    return [{ kind: 'turn', isError, usageTokens: tokens(event['usage']), detail }];
  }
  return type === 'rate_limit_event' ? [{ kind: 'rate', info: event['rate_limit_info'] }] : [];
}

/**
 * Normalize one Codex `exec --json` event.
 *
 * @param event - Decoded event.
 * @returns Normalized events; unknown events produce none.
 */
function codexEvent(event: Record<string, unknown>): ManagerEvent[] {
  const type = textField(event, 'type');
  if (type === 'thread.started') {
    const sessionId = textField(event, 'thread_id');
    return sessionId === null ? [] : [{ kind: 'session', sessionId, model: null }];
  }
  if (type === 'item.completed' && isRecord(event['item'])) {
    const { item } = event;
    if (item['type'] === 'agent_message' && typeof item['text'] === 'string' && item['text'].trim() !== '') {
      return [{ kind: 'text', replyTo: null, text: bounded(item['text'].trim()) }];
    }
    return item['type'] === 'mcp_tool_call' && typeof item['tool'] === 'string'
      ? [{ kind: 'tool', replyTo: null, name: item['tool'] }]
      : [];
  }
  if (type === 'turn.completed') {
    return [{ kind: 'turn', isError: false, usageTokens: tokens(event['usage']), detail: null }];
  }
  if (type === 'turn.failed' || type === 'error') {
    const failure = event['error'];
    const message = textField(isRecord(failure) ? failure : event, 'message');
    return [{ kind: 'turn', isError: true, usageTokens: null, detail: message ?? 'The turn failed.' }];
  }
  return [];
}

/**
 * Decode one line from either supported provider.
 *
 * @param provider - Manager provider family.
 * @param line - One bounded line.
 * @returns Normalized events; non-JSON diagnostics produce none.
 */
export function decodeManagerLine(provider: 'claude' | 'codex', line: string): ManagerEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(decoded)) {
    return [];
  }
  return provider === 'claude' ? claudeEvent(decoded) : codexEvent(decoded);
}

/**
 * Encode one operator turn for Claude's streaming input.
 *
 * @param messageId - Durable message identity, echoed back as the acknowledgment.
 * @param text - Message text.
 * @returns One JSON line including its terminator.
 */
export function claudeInput(messageId: string, text: string): string {
  return `${JSON.stringify({ type: 'user', uuid: messageId, message: { role: 'user', content: text } })}\n`;
}
