/**
 * Provider-neutral accumulator for one attempt's transcript and stream
 * metrics. Provider decoders call its methods in event order; it bounds node
 * count and every text field, pairs tool calls with results and records which
 * files were changed. Truncation is always reported, never silent.
 *
 * @file
 */
import type { FileTouch, TranscriptNode } from './telemetry-schema.ts';

/** Most transcript nodes kept for one attempt. */
export const NODES_MAX = 2000;
/** Longest assistant, thinking, result or status text. */
const TEXT_MAX = 4000;
/** Longest serialized tool input. */
const TOOL_INPUT_MAX = 2000;
/** Longest tool output excerpt. */
const TOOL_OUTPUT_MAX = 2000;
/** Longest one-line primary argument summary. */
const SUMMARY_MAX = 200;
/** Longest node label. */
const LABEL_MAX = 120;
/** Most distinct files recorded as touched. */
const FILES_MAX = 500;
/** Most tool names reported in per-name counts. */
const TOOL_NAMES_MAX = 50;
/** Most prompt lines shown in the input node. */
const PROMPT_LINES = 40;
/** JSON indentation for serialized tool input. */
const JSON_INDENT = 2;
/** Input keys that best describe a tool call, in priority order. */
const SUMMARY_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'cmd',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
  'skill',
] as const;

/** Severity of a transcript node. */
type Level = TranscriptNode['level'];

/** Token counts accumulated from provider usage reports. */
export interface TokenCounts {
  /** Uncached input tokens. */
  input: number;
  /** Input tokens served from the provider cache. */
  cacheRead: number;
  /** Input tokens written to the provider cache. */
  cacheWrite: number;
  /** Output tokens, including reasoning where the provider counts it there. */
  output: number;
  /** Reasoning tokens, when the provider reports them separately. */
  reasoning: number | null;
}

/** Stream-derived metrics independent of the job record. */
export interface StreamDigest {
  /** Reported token split, null when the stream reported no usage. */
  readonly tokens: TokenCounts | null;
  /** Provider-reported cost in USD, null when not reported. */
  readonly reportedCostUsd: number | null;
  /** Reported or counted model turns. */
  readonly turns: number | null;
  /** Provider-reported API time in milliseconds. */
  readonly apiDurationMs: number | null;
  /** Model named by the stream, when it names one. */
  readonly model: string | null;
  /** Whether the provider reported an error result or failed turn. */
  readonly providerError: boolean;
  /** Tool call counts. */
  readonly tools: { total: number; failed: number; byName: { name: string; calls: number; failed: number }[] };
  /** Distinct files changed. */
  readonly filesTouched: number;
  /** Lines that were not JSON objects. */
  readonly malformedLines: number;
  /** JSON events of a type this version does not interpret. */
  readonly unknownEvents: number;
}

/** Complete normalized result of one stream. */
export interface TranscriptParse {
  /** Ordered bounded nodes (empty when nodes were not collected). */
  readonly nodes: TranscriptNode[];
  /** Whether the node cap dropped later nodes. */
  readonly nodesTruncated: boolean;
  /** Files changed, most touched first. */
  readonly files: FileTouch[];
  /** Whether the distinct-file cap dropped paths. */
  readonly filesTruncated: boolean;
  /** Stream metrics. */
  readonly digest: StreamDigest;
}

/** Tracked state of one tool call, kept even when its node was not stored. */
interface ToolTrack {
  /** Tool name. */
  readonly name: string;
  /** Current status. */
  status: 'ok' | 'error' | 'running' | 'incomplete';
  /** Stored transcript node, null beyond the node cap. */
  readonly node: TranscriptNode | null;
}

/** Text clipped to a bound with an explicit flag. */
export interface Clipped {
  /** Retained text. */
  readonly text: string;
  /** Whether characters were removed. */
  readonly truncated: boolean;
}

/**
 * Clip text to a character bound.
 *
 * @param value - Untrusted text.
 * @param max - Largest retained length.
 * @returns Retained prefix and whether anything was dropped.
 */
export function clip(value: string, max: number): Clipped {
  return value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false };
}

/**
 * Serialize an arbitrary tool payload for display.
 *
 * @param value - Untrusted decoded JSON value.
 * @returns Plain string or indented JSON.
 */
export function display(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined ? '' : JSON.stringify(value, null, JSON_INDENT);
}

/**
 * Rank larger counts first, then by a tie-breaking comparison.
 *
 * @param left - First count.
 * @param right - Second count.
 * @param tie - Comparison used when both counts are equal.
 * @returns Negative when the left entry ranks first.
 */
function byCount(left: number, right: number, tie: number): number {
  return right === left ? tie : right - left;
}

/**
 * Choose the argument that best identifies a tool call.
 *
 * @param input - Untrusted tool input.
 * @returns One-line bounded description, or an empty string.
 */
export function primaryArgument(input: unknown): string {
  if (typeof input === 'string') {
    return clip(input.replaceAll(/\s+/gv, ' ').trim(), SUMMARY_MAX).text;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  for (const key of SUMMARY_KEYS) {
    const value = fields.get(key);
    if (typeof value === 'string' && value.trim() !== '') {
      return clip(value.replaceAll(/\s+/gv, ' ').trim(), SUMMARY_MAX).text;
    }
  }
  return '';
}

/** Accumulates nodes and metrics for one attempt stream. */
export class TranscriptBuilder {
  /** Whether nodes are being collected, or only metrics. */
  private readonly isCollecting: boolean;
  /** Bounded ordered nodes. */
  private readonly nodes: TranscriptNode[] = [];
  /** Every tool call by provider identity, in call order. */
  private readonly tools = new Map<string, ToolTrack>();
  /** Touch count per changed path. */
  private readonly files = new Map<string, number>();
  /** Whether the node cap was reached. */
  private isNodesTruncated = false;
  /** Whether the file cap was reached. */
  private isFilesTruncated = false;
  /** Summed usage. */
  private tokens: TokenCounts | null = null;
  /** Provider-billed amount in US dollars, when the stream states one. */
  private reportedCostUsd: number | null = null;
  /** Reported or counted turns. */
  private turns: number | null = null;
  /** Reported API time. */
  private apiDurationMs: number | null = null;
  /** Model named by the stream. */
  private model: string | null = null;
  /** Whether the provider reported failure. */
  private hasProviderError = false;
  /** Counter for tool results that arrived without a known call. */
  private orphanResults = 0;
  /** Lines that were not JSON objects. */
  private malformedLines = 0;
  /** JSON events whose type this version does not interpret. */
  private unknownEvents = 0;

  /**
   * Start an empty accumulator.
   *
   * @param isCollecting - Collect transcript nodes as well as metrics.
   */
  public constructor(isCollecting: boolean) {
    this.isCollecting = isCollecting;
  }

  /**
   * Append a text node (assistant, thinking, result, status or input).
   *
   * @param kind - Node kind.
   * @param label - Short heading.
   * @param body - Untrusted body text.
   * @param level - Severity, informational by default.
   */
  public text(
    kind: Exclude<TranscriptNode['kind'], 'tool' | 'file_change'>,
    label: string,
    body: string,
    level: Level = 'info',
  ): void {
    const clipped = clip(body, TEXT_MAX);
    this.push({ kind, label, text: clipped.text, truncated: clipped.truncated, level, tool: null, changes: [] });
  }

  /**
   * Append the assignment prompt preview as the transcript's first node.
   *
   * @param prompt - Untrusted prompt prefix.
   * @param isPartial - Whether the source prompt continues beyond the prefix.
   */
  public input(prompt: string, isPartial: boolean): void {
    const lines = prompt.split('\n');
    const clipped = clip(lines.slice(0, PROMPT_LINES).join('\n'), TEXT_MAX);
    this.push({
      kind: 'input',
      label: 'Assignment prompt',
      text: clipped.text,
      truncated: isPartial || clipped.truncated || lines.length > PROMPT_LINES,
      level: 'info',
      tool: null,
      changes: [],
    });
  }

  /**
   * Record the start of a tool call; repeated starts for one identity are ignored.
   *
   * @param id - Provider call identity used to pair the result.
   * @param name - Tool identifier shown to the operator.
   * @param input - Untrusted tool arguments.
   */
  public openTool(id: string, name: string, input: unknown): void {
    if (this.tools.has(id)) {
      return;
    }
    const serialized = clip(display(input), TOOL_INPUT_MAX);
    const node = this.push({
      kind: 'tool',
      label: clip(name, LABEL_MAX).text,
      text: '',
      truncated: false,
      level: 'info',
      tool: {
        id,
        name: clip(name, LABEL_MAX).text,
        summary: primaryArgument(input),
        input: serialized.text,
        inputTruncated: serialized.truncated,
        output: '',
        outputTruncated: false,
        status: 'running',
        exitCode: null,
      },
      changes: [],
    });
    this.tools.set(id, { name, status: 'running', node });
  }

  /**
   * Pair a tool result with its call; unknown identities become their own node.
   *
   * @param id - Provider call identity.
   * @param output - Untrusted result text.
   * @param result - Whether the tool failed and its process exit code, when known.
   */
  public closeTool(id: string, output: string, result: { isError: boolean; exitCode: number | null }): void {
    const track = this.tools.get(this.tools.has(id) ? id : this.orphan(id));
    if (track === undefined) {
      return;
    }
    const status = result.isError ? 'error' : 'ok';
    track.status = status;
    const { node } = track;
    if (node?.tool === null || node?.tool === undefined) {
      return;
    }
    const excerpt = clip(output, TOOL_OUTPUT_MAX);
    node.tool.output = excerpt.text;
    node.tool.outputTruncated = excerpt.truncated;
    node.tool.status = status;
    node.tool.exitCode = result.exitCode;
    node.level = result.isError ? 'error' : node.level;
  }

  /**
   * Append a file change node and count each named path.
   *
   * @param changes - Paths and change kinds reported by the provider.
   */
  public fileChange(changes: readonly { path: string; kind: string }[]): void {
    for (const change of changes) {
      this.touch(change.path);
    }
    const label = changes.length === 1 ? '1 file changed' : `${String(changes.length)} files changed`;
    this.push({
      kind: 'file_change',
      label,
      text: '',
      truncated: false,
      level: 'info',
      tool: null,
      changes: changes
        .slice(0, FILES_MAX)
        .map((change) => ({ path: clip(change.path, TEXT_MAX).text, kind: change.kind })),
    });
  }

  /**
   * Count one edit of a path.
   *
   * @param file - Path named by an edit tool or change event.
   */
  public touch(file: string): void {
    const current = this.files.get(file);
    if (current !== undefined) {
      this.files.set(file, current + 1);
    } else if (this.files.size < FILES_MAX) {
      this.files.set(file, 1);
    } else {
      this.isFilesTruncated = true;
    }
  }

  /**
   * Add one usage report to the running token totals.
   *
   * @param usage - Token split reported for one turn or for the whole run.
   */
  public addUsage(usage: TokenCounts): void {
    const total = this.tokens ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: null };
    total.input += usage.input;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.output += usage.output;
    if (usage.reasoning !== null) {
      total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    }
    this.tokens = total;
  }

  /**
   * Record whole-run figures reported by the provider's final event.
   *
   * @param report - Reported cost, turns and API time; absent fields stay unknown.
   */
  public report(report: { costUsd?: number; turns?: number; apiDurationMs?: number }): void {
    this.reportedCostUsd = report.costUsd ?? this.reportedCostUsd;
    this.turns = report.turns ?? this.turns;
    this.apiDurationMs = report.apiDurationMs ?? this.apiDurationMs;
  }

  /** Count one completed turn for providers that report turns individually. */
  public addTurn(): void {
    this.turns = (this.turns ?? 0) + 1;
  }

  /**
   * Remember the model named by the stream; the first report wins.
   *
   * @param model - Provider model identifier.
   */
  public setModel(model: string): void {
    this.model ??= clip(model, LABEL_MAX).text;
  }

  /** Count one line that was not a JSON event object. */
  public countMalformed(): void {
    this.malformedLines += 1;
  }

  /** Count one JSON event whose type or shape this version does not interpret. */
  public countUnknown(): void {
    this.unknownEvents += 1;
  }

  /** Mark that the provider reported an error result or failed turn. */
  public markProviderError(): void {
    this.hasProviderError = true;
  }

  /**
   * Close the stream: calls without results become incomplete unless still live.
   *
   * @param isLive - Whether the attempt is still running, so open calls may finish.
   * @returns Bounded nodes, touched files and stream metrics.
   */
  public finish(isLive: boolean): TranscriptParse {
    for (const track of this.tools.values()) {
      if (isLive || track.status !== 'running') {
        continue;
      }
      track.status = 'incomplete';
      const { node } = track;
      if (node?.tool === undefined || node.tool === null) {
        continue;
      }
      node.tool.status = 'incomplete';
      node.level = 'warning';
    }
    const files = this.files
      .entries()
      .map(([file, touches]) => ({ path: file, touches }))
      .toArray()
      .toSorted((left, right) => byCount(left.touches, right.touches, left.path.localeCompare(right.path)));
    return {
      nodes: this.nodes,
      nodesTruncated: this.isNodesTruncated,
      files,
      filesTruncated: this.isFilesTruncated,
      digest: {
        tokens: this.tokens,
        reportedCostUsd: this.reportedCostUsd,
        turns: this.turns,
        apiDurationMs: this.apiDurationMs,
        model: this.model,
        providerError: this.hasProviderError,
        tools: this.toolCounts(),
        filesTouched: this.files.size,
        malformedLines: this.malformedLines,
        unknownEvents: this.unknownEvents,
      },
    };
  }

  /**
   * Store a node unless the cap is reached.
   *
   * @param node - Node without its sequence number.
   * @returns Stored node, or null when the cap dropped it.
   */
  private push(node: Omit<TranscriptNode, 'seq'>): TranscriptNode | null {
    if (!this.isCollecting) {
      return null;
    }
    if (this.nodes.length >= NODES_MAX) {
      this.isNodesTruncated = true;
      return null;
    }
    const stored = { seq: this.nodes.length, ...node, label: clip(node.label, LABEL_MAX).text };
    this.nodes.push(stored);
    return stored;
  }

  /**
   * Register a result whose call was never seen (for example, cut by truncation).
   *
   * @param id - Reported call identity, possibly empty.
   * @returns Identity under which the unpaired call was recorded.
   */
  private orphan(id: string): string {
    this.orphanResults += 1;
    const key = id === '' ? `orphan-${String(this.orphanResults)}` : id;
    this.openTool(key, 'unknown', undefined);
    return key;
  }

  /**
   * Summarize tool calls by name.
   *
   * @returns Totals and the most used names.
   */
  private toolCounts(): StreamDigest['tools'] {
    const names = new Map<string, { calls: number; failed: number }>();
    let failed = 0;
    for (const track of this.tools.values()) {
      const entry = names.get(track.name) ?? { calls: 0, failed: 0 };
      const failure = track.status === 'error' ? 1 : 0;
      names.set(track.name, { calls: entry.calls + 1, failed: entry.failed + failure });
      failed += failure;
    }
    const byName = names
      .entries()
      .map(([name, counts]) => ({ name: clip(name, LABEL_MAX).text, ...counts }))
      .toArray()
      .toSorted((left, right) => byCount(left.calls, right.calls, left.name.localeCompare(right.name)))
      .slice(0, TOOL_NAMES_MAX);
    return { total: this.tools.size, failed, byName };
  }
}
