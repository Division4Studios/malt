/**
 * Structured diagnostic logging shared by every Agent Mesh process.
 *
 * This module is the ONLY place that writes diagnostics. Its single rule is
 * that diagnostics go to **stderr**, never stdout, because stdout belongs to a
 * protocol: the MCP bridge speaks JSON-RPC over stdout, and the human CLI
 * prints exactly one JSON result there. A stray log line on stdout would
 * corrupt an MCP session, so nothing else in the code base writes to the
 * console directly (ESLint's `no-console` rule enforces this).
 *
 * Every record is a single line of JSON with a timestamp, level, category and
 * event name, followed by caller-selected fields. Callers pass deliberately
 * chosen metadata only: never RPC envelopes, credentials, message bodies, work
 * instructions or whole error objects.
 *
 * The minimum level is read from `AGENTMESH_LOG_LEVEL` on EVERY call rather
 * than once at import time. That lets the CLI apply `--verbose` after all
 * modules have loaded, and lets tests silence output with `silent`.
 *
 * @file
 */

/** Severity of a single diagnostic record, from most to least verbose. */
export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

/** A configurable minimum level; `silent` suppresses every record. */
type Threshold = LogLevel | 'silent';

/**
 * Extra structured fields attached to a record.
 *
 * Values are restricted to JSON scalars so that a caller cannot accidentally
 * serialise a whole object (such as an error or request) into the log.
 * Fields whose value is `undefined` are omitted by `JSON.stringify`.
 */
export type LogFields = Readonly<Record<string, boolean | number | string | null | undefined>>;

/**
 * Numeric rank of each threshold. A record is written when the rank of its
 * level is at least the rank of the configured minimum.
 */
const RANKS: Readonly<Record<Threshold, number>> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** The level used when `AGENTMESH_LOG_LEVEL` is unset or not recognised. */
const DEFAULT_THRESHOLD: Threshold = 'info';

/**
 * Narrow an arbitrary environment value to a known threshold name.
 *
 * @param value - The raw environment variable value, if any.
 * @returns Whether the value names one of the supported thresholds.
 */
function isThreshold(value: string | undefined): value is Threshold {
  // `Object.hasOwn` ignores inherited keys such as `toString`, so a value like
  // "constructor" cannot masquerade as a level.
  return value !== undefined && Object.hasOwn(RANKS, value);
}

/**
 * Resolve the currently configured minimum rank from the environment.
 *
 * @returns The rank below which records are discarded.
 */
function minimumRank(): number {
  const configured = process.env['AGENTMESH_LOG_LEVEL'];
  return RANKS[isThreshold(configured) ? configured : DEFAULT_THRESHOLD];
}

/**
 * Write one structured diagnostic record to stderr if its level is enabled.
 *
 * @param level - Severity of the record.
 * @param category - Subsystem that produced it, for example `broker` or `bridge`.
 * @param event - Short machine-readable event name, for example `rpc_received`.
 * @param fields - Additional scalar metadata; never secrets or message bodies.
 */
export function log(level: LogLevel, category: string, event: string, fields: LogFields = {}): void {
  // Cheap early exit keeps disabled debug logging essentially free.
  if (RANKS[level] < minimumRank()) {
    return;
  }
  // Fixed keys first so every record starts with the same, greppable prefix.
  const now = new Date();
  const record = { timestamp: now.toISOString(), level, category, event, ...fields };
  // One write per record keeps lines intact when several processes share a
  // terminal or a Docker log stream.
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
