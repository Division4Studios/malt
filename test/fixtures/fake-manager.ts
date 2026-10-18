/**
 * Fixture persistent provider speaking Claude Code's stream-json protocol, as
 * captured from a real session: an init event, a replayed acknowledgment per
 * input, assistant text linked to that input and one result per turn. Message
 * text selects failure paths. No model runs.
 *
 * @file
 */
import { appendFileSync } from 'node:fs';

/** Exit code used to simulate a crash mid-turn. */
const CRASH_CODE = 3;

/**
 * Read a command-line flag value.
 *
 * @param name - Command-line flag such as --session-id.
 * @returns Its value, or undefined.
 */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
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

/** One fixture session. */
class FakeSession {
  /** Native session identity. */
  private readonly session = flag('--session-id') ?? flag('--resume') ?? 'fixture-session';
  /** Optional input log for assertions. */
  private readonly log = flag('--fixture-log');
  /** Whether init was emitted. */
  private isInitialized = false;
  /** Pending partial input. */
  private pending = '';

  /**
   * Accept a stdin chunk.
   *
   * @param chunk - Text chunk.
   */
  public push(chunk: string): void {
    this.pending += chunk;
    for (let index = this.pending.indexOf('\n'); index !== -1; index = this.pending.indexOf('\n')) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.handle(line);
    }
  }

  /**
   * Emit one protocol event.
   *
   * @param event - Event fields.
   */
  private emit(event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ ...event, session_id: this.session })}\n`);
  }

  /**
   * Answer one streamed user message.
   *
   * @param line - One input line.
   */
  private handle(line: string): void {
    const decoded: unknown = line.trim() === '' ? null : JSON.parse(line);
    const message = isRecord(decoded) ? decoded['message'] : null;
    if (!isRecord(decoded) || !isRecord(message) || typeof message['content'] !== 'string') {
      return;
    }
    if (this.log !== undefined) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture log path chosen by the test.
      appendFileSync(this.log, `${line}\n`);
    }
    const text = message['content'];
    const uuid = String(decoded['uuid']);
    if (!this.isInitialized) {
      this.isInitialized = true;
      this.emit({ type: 'system', subtype: 'init', model: 'fixture-model', resumed: flag('--resume') !== undefined });
    }
    if (text.includes('SILENT')) {
      return;
    }
    this.emit({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: text } });
    if (text.includes('CRASH')) {
      process.exitCode = CRASH_CODE;
      process.stdin.destroy();
      return;
    }
    this.respond(uuid, text);
  }

  /**
   * Emit the assistant reply and turn result.
   *
   * @param uuid - Input identity.
   * @param text - Input text.
   */
  private respond(uuid: string, text: string): void {
    if (text.includes('TOOL')) {
      this.emit({
        type: 'assistant',
        user_message_uuid: uuid,
        message: { content: [{ type: 'tool_use', name: 'mesh_factory_brief' }] },
      });
    }
    if (text.includes('FAIL')) {
      this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Fixture failure.' });
      return;
    }
    this.emit({
      type: 'assistant',
      user_message_uuid: uuid,
      message: { content: [{ type: 'text', text: `Received: ${text.slice(0, 200)}` }] },
    });
    this.emit({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 3, output_tokens: 4 } });
  }
}

const fake = new FakeSession();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  fake.push(chunk);
});
