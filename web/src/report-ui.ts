/**
 * Safe bounded Markdown subset for operator evidence; never interprets HTML.
 *
 * @file
 */
import { element } from './worker-ui.js';
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
 * @returns Safe, bounded report.
 */
export function renderReport(value: string): HTMLElement {
  const body = element('div', 'evidence-markdown');
  const lines = value.slice(0, REPORT_LIMIT).split('\n');
  let state: ReportState = { code: null, list: null };
  for (const line of lines.slice(0, LINE_LIMIT)) {
    state = appendLine(body, state, line);
  }
  if (value.length > REPORT_LIMIT || lines.length > LINE_LIMIT) {
    body.append(element('p', 'subtle', 'Report preview bounded. Full evidence remains in the worker artifacts.'));
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
