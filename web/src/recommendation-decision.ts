/**
 * Approve or reject one exact recommendation revision from its detail:
 * the complete decision context, a required rationale, one operation
 * identity reused by every retry of the same decision, controls disabled
 * while a request is in flight, a refresh prompt for a stale revision, and
 * results announced through a live region. The draft rationale survives
 * re-renders, offline errors and restarts of the request.
 *
 * @file
 */
import { button, tag } from './console-dom.js';
import { t } from './i18n.js';
import { LANE_LABELS, ticketText } from './recommendations-model.js';
import { element } from './worker-ui.js';

import type { RecommendationDetail } from './recommendations-model.js';

/** Longest error text announced; the broker's full reason stays in its log. */
const ERROR_MAX = 300;
/** Digits of a revision shown to identify it. */
const REVISION_SHOWN = 12;

/** What the decision panel needs from the shell. */
export interface DecisionHooks {
  /** Send one exact decision; resolves with the broker's receipt. */
  readonly decide: (input: {
    operationId: string;
    id: string;
    revision: string;
    decision: 'approve' | 'reject';
    rationale: string;
  }) => Promise<unknown>;
  /** Redraw the open detail with the panel's new state. */
  readonly redraw: () => void;
  /** Re-read the list and the open detail after a decision or a stale answer. */
  readonly reload: () => void;
  /** Fresh operation identity; defaults to `crypto.randomUUID`. */
  readonly identity?: () => string;
}

/** Decision state for the open revision. */
interface Draft {
  /** Revision the draft belongs to. */
  readonly key: string;
  /** Rationale typed so far. */
  rationale: string;
  /** Identity reused by every retry of one decision. */
  operation: { readonly decision: 'approve' | 'reject'; readonly id: string } | null;
  /** A request is in flight. */
  isBusy: boolean;
  /** Announcement for assistive technology. */
  message: string;
  /** The broker said the revision changed. */
  isStale: boolean;
}

/** The decision panel for whichever recommendation is open. */
export class RecommendationDecision {
  /** Shell callbacks. */
  private readonly hooks: DecisionHooks;
  /** Draft of the open revision. */
  private draft: Draft | null = null;

  /**
   * Create the panel controller.
   *
   * @param hooks - Decision route and refresh.
   */
  public constructor(hooks: DecisionHooks) {
    this.hooks = hooks;
  }

  /**
   * The decision context and, while a human decision is awaited, the controls.
   *
   * @param detail - Open recommendation.
   * @returns Panel element.
   */
  public render(detail: RecommendationDetail): HTMLElement {
    const key = `${detail.id}:${detail.revision}`;
    if (this.draft?.key !== key) {
      this.draft = { key, rationale: '', operation: null, isBusy: false, message: '', isStale: false };
    }
    const panel = element('div', 'recommendation-decision');
    panel.append(recommendationContext(detail));
    const live = element('p', 'subtle', this.draft.message);
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    if (this.draft.isStale) {
      panel.append(
        live,
        button(t('Refresh'), {
          cssClass: 'secondary',
          key: `refresh:${key}`,
          action: () => {
            this.hooks.reload();
          },
        }),
      );
      return panel;
    }
    if (detail.state === 'awaiting_human') {
      panel.append(this.controls(detail));
    }
    panel.append(live);
    return panel;
  }

  /**
   * Rationale and the two decision buttons.
   *
   * @param detail - Open recommendation awaiting a decision.
   * @returns Form controls.
   */
  private controls(detail: RecommendationDetail): HTMLElement {
    const { draft } = this;
    const form = element('div', 'recommendation-controls');
    const label = element('label', '', t('Rationale (required)'));
    const field = element('textarea');
    field.value = draft?.rationale ?? '';
    field.addEventListener('input', () => {
      if (draft !== null) {
        draft.rationale = field.value;
      }
    });
    label.append(field);
    form.append(label);
    for (const decision of ['approve', 'reject'] as const) {
      const control = button(t(decision === 'approve' ? 'Approve' : 'Reject'), {
        cssClass: decision === 'approve' ? 'primary' : 'secondary',
        key: `${decision}:${detail.id}`,
        action: () => {
          void this.submit(detail, decision, field);
        },
      });
      control.disabled = draft?.isBusy === true;
      form.append(control);
    }
    return form;
  }

  /**
   * Send one decision; repeated clicks while it is in flight send nothing.
   *
   * @param detail - Open recommendation.
   * @param decision - Approve or reject.
   * @param field - Rationale field.
   */
  private async submit(
    detail: RecommendationDetail,
    decision: 'approve' | 'reject',
    field: HTMLTextAreaElement,
  ): Promise<void> {
    const { draft } = this;
    if (draft === null || draft.isBusy) {
      return;
    }
    draft.rationale = field.value;
    if (draft.rationale.trim() === '') {
      this.announce(t('Write a rationale before deciding.'));
      return;
    }
    if (draft.operation?.decision !== decision) {
      draft.operation = { decision, id: (this.hooks.identity ?? (() => crypto.randomUUID()))() };
    }
    draft.isBusy = true;
    this.announce(t('Sending decision…'));
    try {
      const receipt: unknown = await this.hooks.decide({
        operationId: draft.operation.id,
        id: detail.id,
        revision: detail.revision,
        decision,
        rationale: draft.rationale.trim(),
      });
      this.settle(draft, receipt);
    } catch (error) {
      draft.isBusy = false;
      const reason = error instanceof Error ? error.message : t('The decision could not be sent.');
      this.announce(
        t('Not decided: {reason} Your rationale is kept; try again.', { reason: reason.slice(0, ERROR_MAX) }),
      );
    }
  }

  /**
   * Show the broker's answer: a stale revision asks for a refresh, a decision reloads.
   *
   * @param draft - Draft the request was sent from.
   * @param receipt - Broker receipt.
   */
  private settle(draft: Draft, receipt: unknown): void {
    const outcome: unknown = receipt !== null && typeof receipt === 'object' ? Reflect.get(receipt, 'outcome') : null;
    const target = draft;
    target.isBusy = false;
    if (outcome === 'stale') {
      target.isStale = true;
      this.announce(t('This proposal changed since you opened it. Refresh to review the current revision.'));
      return;
    }
    let message = t('Rejected.');
    if (outcome === 'approved') {
      message = t('Approved.');
    }
    this.announce(message);
    this.hooks.reload();
  }

  /**
   * Record an announcement and ask the shell to show it.
   *
   * @param message - Text for the live region.
   */
  private announce(message: string): void {
    if (this.draft !== null) {
      this.draft.message = message;
    }
    this.hooks.redraw();
  }
}

/**
 * One item per line, or a plain note when there are none.
 *
 * @param items - Text items.
 * @returns Joined text.
 */
function lines(items: readonly string[]): string {
  return items.length === 0 ? t('None') : items.join('\n');
}

/**
 * Everything a decision rests on, as text.
 *
 * @param detail - Open recommendation.
 * @returns Definition list of the decision context.
 */
export function recommendationContext(detail: RecommendationDetail): HTMLElement {
  const list = element('dl', 'recommendation-context');
  const rows: [string, string][] = [
    [t('Revision'), detail.revision.slice(0, REVISION_SHOWN)],
    [t('Tickets'), ticketText(detail.tickets)],
    [t('Survivor'), detail.survivor === null ? t('None') : `#${String(detail.survivor)}`],
    [t('Transferred acceptance'), lines(detail.transferredAcceptance)],
    [t('Transferred dependencies'), ticketText(detail.transferredDependencies)],
    [t('Affected assignments'), lines(detail.affectedAssignments)],
  ];
  for (const [label, value] of rows) {
    list.append(element('dt', 'subtle', label), element('dd', '', value));
  }
  const wrapper = element('div');
  wrapper.append(tag(LANE_LABELS[detail.lane], 'tag-state'), list);
  return wrapper;
}
