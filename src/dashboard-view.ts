/**
 * Pure, bounded terminal views. External text cannot inject terminal controls.
 *
 * @file
 */
import { stripVTControlCharacters } from 'node:util';

import { z } from 'zod/v3';

import { FACTORY_ROLES, capacitySchema, featureSchema, publicJobSchema, taskSchema } from './factory/schema.ts';
/** Named pane gap bound. */
const PANE_GAP = 3;
/** Named min terminal height bound. */
const MIN_TERMINAL_HEIGHT = 10;
/** Named outcome columns bound. */
const OUTCOME_COLUMNS = 11;
/** Named phase columns bound. */
const PHASE_COLUMNS = 13;
/** Named role columns bound. */
const ROLE_COLUMNS = 17;
/** Named min terminal width bound. */
const MIN_TERMINAL_WIDTH = 30;

/** Wire snapshot validated independently from the database. */
export const dashboardSchema = z.object({
  configured: z.boolean(),
  active: z.boolean(),
  connected: z.boolean(),
  error: z.string().nullable(),
  resources: z.object({ freeMemoryMb: z.number(), totalMemoryMb: z.number(), cpuPercent: z.number().nullable() }),
  features: z.array(featureSchema),
  tasks: z.array(taskSchema),
  jobs: z.array(publicJobSchema),
  capacities: z.array(capacitySchema),
});
/** Current display snapshot. */
export type DashboardState = z.output<typeof dashboardSchema>;

/**
 * Show a percentage only when measured telemetry exists.
 *
 * @param value - Observed utilization, absent when unknown.
 * @param fallback - Explicit unknown label.
 * @returns Plain display label.
 */
function displayPercent(value: number | null, fallback: string): string {
  return value === null ? fallback : `${String(Math.round(value))}%`;
}

/**
 * Choose the first nonempty display label without treating null as text.
 *
 * @param values - Ordered plain labels.
 * @returns First meaningful label or an empty string.
 */
function firstNonempty(...values: string[]): string {
  return values.find((value) => value !== '') ?? '';
}

/**
 * Describe one logical role's last actual attempt.
 *
 * @param job - Last recorded attempt, absent before initial dispatch.
 * @returns Plain attempt details.
 */
function jobDetails(job: DashboardState['jobs'][number] | undefined): string[] {
  return [
    job?.state === 'running' ? 'PROCESS ACTIVE' : 'SPUN DOWN · no idle model process',
    `Provider: ${job?.provider ?? 'selected on dispatch'}`,
    `Stage: ${job?.kind ?? 'awaiting assignment'}`,
    `PID: ${job?.pid ?? '—'}`,
    `Last outcome: ${job?.summary ?? job?.state ?? 'No attempt yet'}`,
    `Artifacts: ${job?.artifact ?? '—'}`,
  ];
}
/** View tabs. */
export const TABS = ['Team', 'Deliveries', 'Product', 'Activity', 'Capacity'] as const;
/** Selected dashboard view. */
export interface ViewSelection {
  /** Active tab index. */
  readonly tab: number;
  /** Selected row. */
  readonly row: number;
  /** Details scroll offset. */
  readonly scroll: number;
}
/** Terminal styling codes are trusted literals only. */
const COLOR = {
  cyan: '\u{1B}[36m',
  green: '\u{1B}[32m',
  yellow: '\u{1B}[33m',
  red: '\u{1B}[31m',
  dim: '\u{1B}[2m',
  reset: '\u{1B}[0m',
  bold: '\u{1B}[1m',
  selected: '\u{1B}[7m',
};
/** First printable ASCII character. */
const CONTROL_LIMIT = 32;
/** Delete and C1 control block boundaries. */
const DELETE_CODE = 127;
/** Last C1 terminal control. */
const C1_LIMIT = 159;
/** Minimum usable split-pane width. */
const SPLIT_WIDTH = 100;
/** Ratio of the left pane to full terminal width. */
const LIST_RATIO = 0.42;
/** Reserved header/footer lines. */
const CHROME_LINES = 7;

/**
 * Convert untrusted messages and logs to safe printable terminal text.
 *
 * @param value - Project text.
 * @returns Text stripped of control sequences and control characters.
 */
export function safeText(value: string): string {
  const plain = stripVTControlCharacters(stripOperatingSystemCommands(value));
  return Array.from(plain, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < CONTROL_LIMIT || (code >= DELETE_CODE && code <= C1_LIMIT) ? ' ' : character;
  }).join('');
}

/**
 * Remove complete OSC payloads before platform-specific VT stripping sees them.
 *
 * @param value - Untrusted terminal text, possibly containing title or hyperlink commands.
 * @returns Text outside OSC sequences; an unterminated payload is discarded.
 */
function stripOperatingSystemCommands(value: string): string {
  const parts = value.replaceAll('\u{9D}', '\u{1B}]').split('\u{1B}]');
  let output = parts[0] ?? '';
  for (const part of parts.slice(1)) {
    const endings = [part.indexOf('\u{7}'), part.indexOf('\u{1B}\\'), part.indexOf('\u{9C}')].filter(
      (index) => index >= 0,
    );
    const end = Math.min(...endings);
    if (!Number.isFinite(end)) {
      continue;
    }
    const length = part[end] === '\u{1B}' ? 2 : 1;
    output += part.slice(end + length);
  }
  return output;
}

/**
 * Bound a plain-text cell without splitting terminal escape codes.
 *
 * @param text - Untrusted cell text.
 * @param width - Available columns.
 * @returns Padded, bounded cell.
 */
function cell(text: string, width: number): string {
  const safe = safeText(text);
  return (safe.length > width ? `${safe.slice(0, Math.max(0, width - 1))}…` : safe).padEnd(width);
}

/**
 * Choose a consistent lifecycle color.
 *
 * @param state - Role or delivery status.
 * @returns Trusted ANSI foreground code.
 */
function color(state: string): string {
  if (['running', 'development', 'review', 'verifying'].includes(state)) {
    return COLOR.cyan;
  }
  if (['done', 'succeeded'].includes(state)) {
    return COLOR.green;
  }
  return ['blocked', 'failed'].includes(state) ? COLOR.red : COLOR.yellow;
}

/**
 * Rows and details for a current tab.
 *
 * @param state - Validated wire state.
 * @param selection - Current keyboard selection.
 * @returns Plain display text, independent of terminal IO.
 */
export function viewRows(
  state: DashboardState,
  selection: ViewSelection,
): { rows: { label: string; state: string }[]; detail: string[] } {
  switch (TABS[selection.tab]) {
    case 'Team': {
      return teamView(state, selection);
    }
    case 'Deliveries': {
      return deliveryView(state, selection);
    }
    case 'Product': {
      return productView(state, selection);
    }
    case 'Activity': {
      return activityView(state, selection);
    }
    case 'Capacity':
    case undefined: {
      return capacityView(state, selection);
    }
  }
  return capacityView(state, selection);
}

/**
 * Wrap plain details to avoid truncating findings.
 *
 * @param lines - Detail paragraphs.
 * @param width - Pane columns.
 * @returns Wrapped printable rows.
 */
function wrap(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => {
    const text = safeText(line);
    const chunks = [];
    for (let offset = 0; offset < Math.max(1, text.length); offset += width) {
      chunks.push(text.slice(offset, offset + width));
    }
    return chunks;
  });
}

/**
 * Render a terminal-size bounded frame with selection and detail panes.
 *
 * @param state - Current real factory state.
 * @param selection - Selected pane and row.
 * @param size - Terminal dimensions.
 * @param notice - Pending action or connection status.
 * @returns Complete ANSI frame.
 */
export function renderDashboard(
  state: DashboardState,
  selection: ViewSelection,
  size: { width: number; height: number },
  notice: string,
): string {
  const width = Math.max(MIN_TERMINAL_WIDTH, size.width);
  const height = Math.max(MIN_TERMINAL_HEIGHT, size.height);
  const live = state.jobs.filter((job) => job.state === 'running').length;
  const done = state.tasks.filter((task) => task.phase === 'done').length;
  const header = `${COLOR.bold}${COLOR.cyan}${cell('MALT  /  SOFTWARE FACTORY', width)}${COLOR.reset}`;
  const cpu = displayPercent(state.resources.cpuPercent, '…');
  const resources = `${String(live)} active · ${String(done)} delivered · ${state.active ? 'AUTO' : 'PAUSED'} · GitHub ${state.connected ? 'connected' : 'unverified'} · CPU ${cpu} · Free ${String(Math.round(state.resources.freeMemoryMb))} MiB`;
  const tabs = TABS.map(
    (tab, index) =>
      `${index === selection.tab ? COLOR.selected : COLOR.dim} ${String(index + 1)} ${tab} ${COLOR.reset}`,
  ).join(' ');
  const view = viewRows(state, selection);
  const bodyHeight = height - CHROME_LINES;
  const leftWidth = width >= SPLIT_WIDTH ? Math.floor(width * LIST_RATIO) : width;
  const detailWidth = Math.max(1, width - leftWidth - PANE_GAP);
  const detail = wrap(view.detail, detailWidth).slice(selection.scroll);
  const start = Math.max(0, selection.row - bodyHeight + 1);
  const rows = Array.from({ length: bodyHeight }, (_, index) => {
    const item = view.rows[start + index];
    const isSelected = start + index === selection.row;
    const selectionColor = isSelected ? COLOR.selected : color(item?.state ?? 'parked');
    const left =
      item === undefined ? cell('', leftWidth) : `${selectionColor}${cell(item.label, leftWidth)}${COLOR.reset}`;
    return width >= SPLIT_WIDTH
      ? `${left} ${COLOR.dim}│${COLOR.reset} ${cell(detail[index] ?? '', detailWidth)}`
      : left;
  });
  return [
    '\u{1B}[H',
    header,
    cell(resources, width),
    tabs,
    ...rows,
    `${COLOR.dim}${'─'.repeat(width)}${COLOR.reset}`,
    `${COLOR.yellow}${cell(firstNonempty(notice, state.error ?? '', '↑↓ select · Tab view · ←→ detail · i instruct · c scope · n objective · Space pause/start · q quit'), width)}${COLOR.reset}`,
    `${COLOR.dim}${cell(width < SPLIT_WIDTH ? 'Widen terminal to 100+ columns to show the details pane.' : 'Ctrl+C exits dashboard; broker and factory keep running. Instructions persist in the project .malt.', width)}${COLOR.reset}`,
  ].join('\n');
}

/**
 * Render the teamView pane from validated project state.
 *
 * @param state - Factory snapshot.
 * @param selection - Keyboard selection.
 * @returns Plain rows and selected details.
 */
function teamView(state: DashboardState, selection: ViewSelection): ReturnType<typeof viewRows> {
  const roles = FACTORY_ROLES.map((role) => {
    const attempt = state.jobs.findLast((candidate) => candidate.role === role);
    const isLive = attempt?.state === 'running';
    return {
      label: `${isLive ? '●' : '○'} ${role.padEnd(ROLE_COLUMNS)} ${isLive ? attempt.provider : 'spun down'}`,
      state: isLive ? 'running' : 'parked',
      job: attempt,
      role,
    };
  });
  const selected = roles[selection.row];
  const job = selected?.job;
  const task = state.tasks.find((candidate) => candidate.id === job?.taskId);
  const delivery = task === undefined ? 'planning / research' : `#${String(task.issue)} ${task.title}`;
  return {
    rows: roles,
    detail: [
      selected?.role ?? 'Select a role',
      ...jobDetails(job),
      `Delivery: ${delivery}`,
      '',
      'Next assignment comes from the durable queue.',
      'i: send instruction · c: request coordinated scope change',
      'x: cancel the active attempt',
      ...(task?.feedback.slice(-PANE_GAP) ?? []),
    ],
  };
}

/**
 * Render the deliveryView pane from validated project state.
 *
 * @param state - Factory snapshot.
 * @param selection - Keyboard selection.
 * @returns Plain rows and selected details.
 */
function deliveryView(state: DashboardState, selection: ViewSelection): ReturnType<typeof viewRows> {
  const tasks = state.tasks.toSorted((a, b) => Number(a.phase === 'done') - Number(b.phase === 'done'));
  const task = tasks[selection.row];
  return {
    rows: tasks.map((item) => {
      return {
        label: `#${String(item.issue)} ${item.phase.padEnd(PHASE_COLUMNS)} ${item.title}`,
        state: item.phase,
      };
    }),
    detail:
      task === undefined
        ? ['No deliveries yet.', 'Product owner and lead prepare atomic tickets first.']
        : [
            task.title,
            `Issue #${String(task.issue)} · parent #${String(task.parentIssue)}`,
            `Stage: ${task.phase} · owner: ${task.developer ?? 'unassigned'}`,
            `Attempts: ${String(task.attempts)}`,
            `PR: ${task.prUrl ?? 'not published'}`,
            `Head: ${task.head ?? '—'}`,
            `Base: ${task.base ?? '—'}`,
            `Approvals: ${firstNonempty(task.reviews.map((review) => [review.role, review.outcome].join(' ')).join(', '), 'none')}`,
            `Depends on: ${firstNonempty(task.dependencies.join(', '), 'none')}`,
            '',
            'Acceptance criteria',
            ...task.acceptanceCriteria.map((criterion) => `• ${criterion}`),
            '',
            'Feedback',
            ...task.feedback,
            task.error ?? '',
            `Worktree: ${task.worktree ?? 'retired / not created'}`,
          ],
  };
}

/**
 * Render the productView pane from validated project state.
 *
 * @param state - Factory snapshot.
 * @param selection - Keyboard selection.
 * @returns Plain rows and selected details.
 */
function productView(state: DashboardState, selection: ViewSelection): ReturnType<typeof viewRows> {
  const feature = state.features[selection.row];
  return {
    rows: state.features.map((item) => {
      return {
        label: `${item.phase.padEnd(PHASE_COLUMNS)} ${item.objective}`,
        state: item.phase,
      };
    }),
    detail:
      feature === undefined
        ? ['No product objectives.', 'n: queue an objective for product owner + lead']
        : [
            feature.objective,
            `Stage: ${feature.phase}`,
            `Parent issue: ${feature.parentIssue ?? 'not created'}`,
            feature.error ?? '',
            'Lead-reviewed atomic scopes',
            ...(feature.plan?.deliveries.map((scope) => `${scope.key}: ${scope.title}`) ?? ['Planning not complete.']),
          ],
  };
}

/**
 * Render the activityView pane from validated project state.
 *
 * @param state - Factory snapshot.
 * @param selection - Keyboard selection.
 * @returns Plain rows and selected details.
 */
function activityView(state: DashboardState, selection: ViewSelection): ReturnType<typeof viewRows> {
  const jobs = state.jobs.toReversed();
  const job = jobs[selection.row];
  return {
    rows: jobs.map((item) => {
      return {
        label: `${item.role.padEnd(ROLE_COLUMNS)} ${item.state.padEnd(OUTCOME_COLUMNS)} ${item.kind}`,
        state: item.state,
      };
    }),
    detail:
      job === undefined
        ? ['No attempts recorded.']
        : [
            job.role,
            `Stage: ${job.kind} · ${job.state}`,
            `Provider: ${job.provider}`,
            `Started: ${displayTime(job.startedAt)}`,
            `Usage: ${job.usageTokens ?? 'unknown'} tokens`,
            `Reservation: ${String(job.reservation)}`,
            job.summary ?? '',
            `Artifacts: ${job.artifact}`,
            'Open these project-local artifacts for prompts, check evidence and logs.',
          ],
  };
}

/**
 * Render the capacityView pane from validated project state.
 *
 * @param state - Factory snapshot.
 * @param selection - Keyboard selection.
 * @returns Plain rows and selected details.
 */
function capacityView(state: DashboardState, selection: ViewSelection): ReturnType<typeof viewRows> {
  const capacity = state.capacities[selection.row];
  return {
    rows: state.capacities.map((item) => {
      return {
        label: `${item.provider} · ${String(item.usedTokens)} used · ${String(item.reservedTokens)} reserved`,
        state: item.cooldownUntil > Date.now() ? 'blocked' : 'ready',
      };
    }),
    detail:
      capacity === undefined
        ? ['Configure project provider budgets first.']
        : [
            capacity.provider,
            `Scheduling tokens used: ${String(capacity.usedTokens)}`,
            `Reserved: ${String(capacity.reservedTokens)}`,
            `Subscription quota: ${displayPercent(capacity.subscriptionUsedPercent, 'UNKNOWN')}`,
            `Telemetry: ${capacity.telemetrySource ?? 'not reported'}`,
            `Accounting reset: ${displayTime(capacity.resetAt)}`,
            `Cooldown: ${capacity.cooldownUntil > Date.now() ? displayTime(capacity.cooldownUntil) : 'none'}`,
            '',
            'Scheduling budgets are separate from provider subscription limits.',
            'Idle roles run no processes. OS pressure parks new jobs.',
            'Windows managed processes have CPU/memory Job Object ceilings.',
          ],
  };
}

/**
 * Format one ledger timestamp for the local operator.
 *
 * @param value - Millisecond timestamp.
 * @returns Local display time.
 */
function displayTime(value: number): string {
  const date = new Date(value);
  return date.toLocaleString();
}
