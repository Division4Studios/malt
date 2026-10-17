/**
 * Safe bounded operator reports and read-only handoff previews; never interprets HTML.
 *
 * @file
 */
import { child, displayText, records, text } from './api.js';
import { formatDateTime, t } from './i18n.js';
import { element } from './worker-ui.js';

import type { Data, Snapshot } from './api.js';
/** Bound hostile or accidental oversized reports. */
const REPORT_LIMIT = 24_000;
/** Bound layout work per report. */
const LINE_LIMIT = 180;

/**
 * Render supported emphasis without HTML parsing.
 *
 * @param node - Safe output container.
 * @param value - Untrusted report text.
 */
function inline(node: HTMLElement, value: string): void {
  let offset = 0;
  for (const match of value.matchAll(/\*\*(?<strong>[^\n*]+)\*\*|`(?<code>[^\n`]+)`/gv)) {
    node.append(document.createTextNode(value.slice(offset, match.index)));
    const strong = match.groups?.['strong'];
    node.append(element(strong === undefined ? 'code' : 'strong', '', strong ?? match.groups?.['code'] ?? ''));
    offset = match.index + match[0].length;
  }
  node.append(document.createTextNode(value.slice(offset)));
}

/**
 * Render headings, paragraphs, bullets and fenced code as native elements.
 *
 * @param value - Untrusted project/model text.
 * @param boundedNotice - Truthful context-specific explanation when layout is bounded.
 * @returns Safe, bounded report.
 */
export function renderReport(
  value: string,
  boundedNotice = t('Report preview bounded. Full evidence remains in the worker artifacts.'),
): HTMLElement {
  const body = element('div', 'evidence-markdown');
  const lines = value.slice(0, REPORT_LIMIT).split('\n');
  let state: ReportState = { code: null, list: null };
  for (const line of lines.slice(0, LINE_LIMIT)) {
    state = appendLine(body, state, line);
  }
  if (value.length > REPORT_LIMIT || lines.length > LINE_LIMIT) {
    body.append(element('p', 'subtle', boundedNotice));
  }
  return body;
}

/** Only the current native list and code block are retained. */
interface ReportState {
  /** Open literal code fence. */
  code: HTMLPreElement | null;
  /** Open bullet list. */
  list: HTMLUListElement | null;
}

/**
 * Append one bounded line without HTML parsing.
 *
 * @param body - Safe report container.
 * @param state - Current block context.
 * @param line - Untrusted line.
 * @returns Next immutable block context.
 */
function appendLine(body: HTMLElement, state: ReportState, line: string): ReportState {
  if (line.startsWith('```')) {
    const code = state.code === null ? element('pre') : null;
    if (code !== null) {
      body.append(code);
    }
    return { code, list: null };
  }
  if (state.code !== null) {
    state.code.append(document.createTextNode(`${line}\n`));
    return state;
  }
  if (/^[*\-] /v.test(line)) {
    const list = state.list ?? element('ul');
    if (state.list === null) {
      body.append(list);
    }
    const item = element('li');
    inline(item, line.slice(2));
    list.append(item);
    return { code: null, list };
  }
  if (line.trim() === '') {
    return { code: null, list: null };
  }
  const node = element(/^#{1,6} /v.test(line) ? 'h4' : 'p');
  inline(node, line.replace(/^#{1,6} /v, ''));
  body.append(node);
  return { code: null, list: null };
}

/** Maximum records rendered in Mission, independently of the backend window. */
const HANDOFF_LIMIT = 6;
/** Bound each read-only field, including when an incompatible backend returns excess text. */
const FIELD_LIMIT = 4000;
/** Compact summaries expand into the bounded stored record. */
const SUMMARY_LIMIT = 280;

/**
 * Read bounded literal text without leaving a clipped surrogate in the DOM.
 *
 * @param value - Untrusted snapshot record.
 * @param key - Expected field.
 * @returns Safe text, with missing data explicit at the call site.
 */
function handoffText(value: Data, key: string): string {
  return text(value, key).slice(0, FIELD_LIMIT).toWellFormed();
}

/**
 * Update freshness in place so connectivity alone never replaces focused details.
 *
 * @param isConnected - Actual local service connection state.
 */
export function refreshHandoffConnection(isConnected: boolean): void {
  for (const status of document.querySelectorAll('.handoff-connection')) {
    status.textContent = t(
      isConnected
        ? 'Latest six durable reports and peer messages. Expand for the bounded stored record.'
        : 'Disconnected. These handoffs are stale observations; agents cannot be controlled offline.',
    );
  }
}

/**
 * Show only actual report/message sources; generic Activity is a separate view.
 *
 * @param state - Selected project's current snapshot.
 * @param isConnected - Current connection, not an inferred agent presence.
 * @returns Six native read-only previews with truthful empty/legacy states.
 */
export function handoffPreviews(state: Snapshot, isConnected: boolean): HTMLElement {
  const body = element('section', 'panel-body handoff-feed');
  body.setAttribute('aria-label', t('Latest handoffs and messages'));
  const status = element('p', 'subtle handoff-connection');
  status.textContent = t(
    isConnected
      ? 'Latest six durable reports and peer messages. Expand for the bounded stored record.'
      : 'Disconnected. These handoffs are stale observations; agents cannot be controlled offline.',
  );
  body.append(status);
  const raw = state.factory['handoffs'];
  if (!Array.isArray(raw)) {
    body.append(element('p', 'subtle', t('Handoff feed unavailable from this backend snapshot.')));
    return body;
  }
  const entries = records(raw.slice(0, HANDOFF_LIMIT));
  for (const entry of entries) {
    body.append(handoffPreview(entry));
  }
  if (entries.length === 0) {
    body.append(element('p', 'subtle', t('No durable handoffs or peer messages have been recorded for this project.')));
  }
  return body;
}

/**
 * Render one source-qualified record without creating an acknowledgment or instruction.
 *
 * @param entry - Backend-projected record, rendered only as text.
 * @returns Keyboard-operable disclosure with known/unknown provenance.
 */
function handoffPreview(entry: Data): HTMLElement {
  const detail = element('details', 'triage-card handoff-preview');
  const key = `handoff:${handoffText(entry, 'id')}`;
  detail.dataset['queueKey'] = key;
  const summary = element('summary');
  summary.dataset['queueFocus'] = key;
  const signal = element('span', 'triage-signal', '›');
  signal.setAttribute('aria-hidden', 'true');
  const heading = element('span', 'handoff-heading');
  const assignment = child(entry, 'assignment');
  const purpose = displayText(handoffText(assignment, 'title'), t('Assignment purpose unavailable'));
  const sender = displayText(handoffText(entry, 'sender'), t('Origin unavailable'));
  const recipient = displayText(handoffText(entry, 'recipient'), t('Destination unavailable'));
  const isManager = entry['kind'] === 'manager_report';
  const kind = t(isManager ? 'Manager report' : 'Peer message');
  const reported = displayText(handoffText(entry, 'summary'), handoffText(entry, 'body'));
  const purposePreview = purpose.slice(0, SUMMARY_LIMIT).toWellFormed();
  const summaryPreview = displayText(reported.slice(0, SUMMARY_LIMIT).toWellFormed(), t('Summary unavailable'));
  const stage = displayText(handoffText(assignment, 'kind'), t('unavailable'));
  const route = t('Issue: {issue} · Stage: {stage}', { issue: issueIdentity(assignment), stage });
  heading.append(
    element('strong', '', purposePreview),
    element('span', 'handoff-route', `${sender} → ${recipient}`),
    element('span', 'subtle', route),
    element('span', 'subtle', summaryPreview),
    handoffTime(entry),
  );
  summary.append(signal, heading, element('span', 'pill', kind));
  const content = element('div', 'triage-body');
  const outcome = displayText(handoffText(entry, 'outcome'), t('unavailable'));
  const processState = displayText(handoffText(entry, 'processState'), t('unavailable'));
  const storedBody = displayText(handoffText(entry, 'body'), t('Stored body unavailable.'));
  const report = renderReport(
    storedBody,
    t('Stored record display bounded; full transcript and artifact availability are not established by this preview.'),
  );
  const intended = t('Intended recipient: {recipient}. {assignment}', {
    recipient,
    assignment: assignmentLabel(assignment),
  });
  content.append(
    element('p', 'subtle', t('Recorded purpose: {purpose}', { purpose })),
    element('p', 'subtle', intended),
    element('p', 'subtle', transportLabel(entry, isManager)),
    element(
      'p',
      'subtle',
      t(
        'Reported outcome: {outcome}. Process state: {processState}. This record is not independent delivery verification.',
        { outcome, processState },
      ),
    ),
    element('p', 'subtle', t(entry['truncated'] === true ? 'Stored preview truncated.' : 'Bounded stored preview.')),
    report,
  );
  detail.append(summary, content);
  return detail;
}

/**
 * Present only recorded assignment fields, without deriving a ticket from prose.
 *
 * @param assignment - Available durable association.
 * @returns Literal context with missing values identified.
 */
function assignmentLabel(assignment: Data): string {
  return t('Issue: {issue}. Job: {job}. Task: {task}. Stage: {stage}.', {
    issue: issueIdentity(assignment),
    job: displayText(handoffText(assignment, 'jobId'), t('unavailable')),
    task: displayText(handoffText(assignment, 'taskId'), t('unavailable')),
    stage: displayText(handoffText(assignment, 'kind'), t('unavailable')),
  });
}

/**
 * Format only an explicit valid issue number.
 *
 * @param assignment - Recorded context, never parsed prose.
 * @returns Issue identity or an explicit unknown.
 */
function issueIdentity(assignment: Data): string {
  const { issue } = assignment;
  return typeof issue === 'number' && Number.isSafeInteger(issue) && issue > 0 ? `#${String(issue)}` : t('unavailable');
}

/**
 * Separate explicit worker origin from the transport that stored the record.
 *
 * @param entry - Projected source evidence.
 * @param isManager - Explicit manager-report kind.
 * @returns Truthful source description with legacy origins left unknown.
 */
function transportLabel(entry: Data, isManager: boolean): string {
  if (isManager) {
    return t(
      entry['hasOriginEvidence'] === true
        ? 'Transport: factory instruction. Origin comes from matching structured worker provenance.'
        : 'Transport: factory instruction. Worker origin metadata is unavailable; no author is inferred from its body.',
    );
  }
  return t('Transport: broker message. Actual sender ID: {sender}. Body text does not change its recorded author.', {
    sender: displayText(handoffText(entry, 'transportSender'), t('unavailable')),
  });
}

/**
 * Render a real finite timestamp or an explicit unknown, never the current time.
 *
 * @param entry - Recorded event metadata.
 * @returns Semantic local time.
 */
function handoffTime(entry: Data): HTMLElement {
  const { recordedAt: stamp } = entry;
  const date = new Date(typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : NaN);
  if (Number.isNaN(date.getTime())) {
    return element('span', 'subtle', t('Recorded time unavailable'));
  }
  const time = element('time', 'subtle', formatDateTime(date));
  time.dateTime = date.toISOString();
  return time;
}
