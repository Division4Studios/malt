/**
 * Project → Recommendations: the product owner's and lead's ticket proposals
 * by lane, with tickets, evidence and an unread marker. Rows are buttons, so
 * the keyboard alone opens them; opening an unread row records it as read.
 * Polling an unchanged page leaves the DOM and focus alone. An opened row
 * loads its full detail: the context a decision rests on. All external text
 * is set as text.
 *
 * @file
 */
import { button, emptyState, focusedKey, restoreFocus, tag } from './console-dom.js';
import { t } from './i18n.js';
import { recommendationContext } from './recommendation-decision.js';
import {
  LANE_LABELS,
  countLabel,
  kindLabel,
  laneGroups,
  readDetail,
  readPage,
  renderKey,
  ticketText,
} from './recommendations-model.js';
import { element } from './worker-ui.js';

import type {
  RecommendationCounts,
  RecommendationDetail,
  RecommendationPage,
  RecommendationSummary,
} from './recommendations-model.js';

/** Routes the pane reads through the shell. */
export interface RecommendationsHooks {
  /** Read one page of `/api/recommendations`, after a cursor or from the start. */
  readonly list: (after: string | null) => Promise<unknown>;
  /** Record that the operator opened one exact revision. */
  readonly markRead: (id: string, revision: string) => Promise<unknown>;
  /** Read one recommendation's current detail. */
  readonly detail: (id: string) => Promise<unknown>;
}

/** A mounted Recommendations pane. */
export interface RecommendationsHandle {
  /** Stable root element. */
  readonly element: HTMLElement;
  /** Re-read the page; redraws only when what it shows changed. */
  readonly refresh: () => Promise<void>;
  /** Forget the previous project's page and selection. */
  readonly reset: () => void;
  /** Redraw every label in the current language, keeping external text as sent. */
  readonly relabel: () => void;
}
/** Most extra pages followed on one refresh. */
const MAX_PAGES = 10;

/**
 * Show the Project section's pending and unread counts.
 *
 * @param counts - Project totals, or `null` while unknown.
 */
export function showRecommendationCounts(counts: RecommendationCounts | null): void {
  const badge = document.querySelector<HTMLElement>('#recommendation-count');
  if (badge === null) {
    return;
  }
  badge.hidden = counts === null || counts.pending + counts.unread === 0;
  badge.textContent = counts === null ? '' : t('{pending} · {unread} new', { ...counts });
  badge.setAttribute('aria-label', counts === null ? '' : countLabel(counts));
}

/** Stateful pane. */
class RecommendationsView implements RecommendationsHandle {
  /** Stable root element. */
  public readonly element = element('section', 'recommendations');
  /** Shell routes. */
  private readonly hooks: RecommendationsHooks;
  /** Latest valid page. */
  private page: RecommendationPage | null = null;
  /** What the DOM currently shows. */
  private shown = '';
  /** Open row. */
  private selected: string | null = null;
  /** Last read failure. */
  private error = '';
  /** Extra pages the operator asked for beyond the first. */
  private extraPages = 0;
  /** Bumped by `reset`, so a read started for the previous project is discarded. */
  private generation = 0;
  /** Full detail of the open row. */
  private opened: RecommendationDetail | null = null;

  /**
   * Build the pane.
   *
   * @param hooks - Shell routes.
   */
  public constructor(hooks: RecommendationsHooks) {
    this.hooks = hooks;
    this.element.setAttribute('aria-label', t('Recommendations'));
  }

  /**
   * Re-read the pages and redraw only when their visible content changed.
   *
   * @param failure - A mutation error to keep showing after this read.
   */
  public async refresh(failure = ''): Promise<void> {
    const started = this.generation;
    try {
      const page = await this.pages();
      if (started !== this.generation) {
        return;
      }
      this.page = page;
      this.error = failure;
    } catch (error) {
      if (started !== this.generation) {
        return;
      }
      this.error = error instanceof Error ? error.message : t('The recommendation list could not be read.');
    }
    showRecommendationCounts(this.page?.counts ?? null);
    this.render();
  }

  /** Forget the previous project's page and selection; reads already in flight are discarded. */
  public reset(): void {
    this.generation += 1;
    this.page = null;
    this.selected = null;
    this.opened = null;
    this.error = '';
    this.extraPages = 0;
    this.shown = '';
    this.element.replaceChildren();
    showRecommendationCounts(null);
  }

  /** Redraw every label in the current language, keeping external text as sent. */
  public relabel(): void {
    this.shown = '';
    this.render();
  }

  /**
   * Read the first page and the extra pages the operator opened.
   *
   * @returns All loaded rows with the latest counts and the next cursor.
   * @throws {Error} When a page cannot be read.
   */
  private async pages(): Promise<RecommendationPage> {
    const first = readPage(await this.hooks.list(null));
    if (first === null) {
      throw new Error(t('The recommendation list could not be read.'));
    }
    const items = [...first.items];
    let last = first;
    for (let index = 0; index < Math.min(this.extraPages, MAX_PAGES) && last.nextCursor !== null; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- Each page starts after the previous page's cursor.
      const next = readPage(await this.hooks.list(last.nextCursor));
      if (next === null) {
        throw new Error(t('The recommendation list could not be read.'));
      }
      items.push(...next.items);
      last = next;
    }
    return { ...last, items };
  }

  /**
   * Open a row; an unread one is recorded as read at its exact revision.
   *
   * @param item - Row opened.
   */
  private async open(item: RecommendationSummary): Promise<void> {
    this.selected = this.selected === item.id ? null : item.id;
    this.opened = null;
    this.render();
    if (this.selected === null) {
      return;
    }
    await this.load(item.id);
    if (!item.isUnread) {
      return;
    }
    let failure = '';
    try {
      await this.hooks.markRead(item.id, item.revision);
    } catch (error) {
      failure = error instanceof Error ? error.message : t('The read receipt could not be saved.');
    }
    await this.refresh(failure);
  }

  /**
   * Read the open row's full detail.
   *
   * @param id - Open recommendation.
   */
  private async load(id: string): Promise<void> {
    const started = this.generation;
    try {
      const detail = readDetail(await this.hooks.detail(id));
      if (started !== this.generation || this.selected !== id) {
        return;
      }
      this.opened = detail;
    } catch (error) {
      if (started !== this.generation) {
        return;
      }
      this.error = error instanceof Error ? error.message : t('The recommendation could not be read.');
    }
    this.render();
  }

  /** Rebuild the pane when its key changed, keeping focus on the same row. */
  private render(): void {
    const key = JSON.stringify([
      this.page === null ? null : renderKey(this.page),
      this.selected,
      this.opened?.revision ?? null,
      this.opened?.state ?? null,
      this.error,
    ]);
    if (key === this.shown) {
      return;
    }
    this.shown = key;
    const focus = focusedKey(this.element);
    const nodes: HTMLElement[] = [];
    if (this.error !== '') {
      nodes.push(element('p', 'notice', this.error));
    }
    if (this.page === null) {
      nodes.push(element('p', 'subtle', t('Loading recommendations…')));
    } else if (this.page.items.length === 0) {
      nodes.push(
        emptyState(
          t('No recommendations'),
          t('Proposals to link, merge or change tickets from the product owner and team lead appear here.'),
        ),
      );
    } else {
      nodes.push(element('p', 'subtle', countLabel(this.page.counts)));
      for (const group of laneGroups(this.page.items)) {
        nodes.push(this.lane(group.lane, group.items));
      }
      if (this.page.nextCursor !== null && this.extraPages < MAX_PAGES) {
        nodes.push(
          button(t('Show more recommendations'), {
            cssClass: 'secondary',
            key: 'recommendations:more',
            action: () => {
              this.extraPages += 1;
              void this.refresh();
            },
          }),
        );
      }
    }
    this.element.replaceChildren(...nodes);
    restoreFocus(this.element, focus);
  }

  /**
   * One lane with its rows.
   *
   * @param lane - Lane key.
   * @param items - Its rows.
   * @returns Lane section.
   */
  private lane(lane: keyof typeof LANE_LABELS, items: readonly RecommendationSummary[]): HTMLElement {
    const section = element('section', 'recommendation-lane');
    section.append(element('h3', '', t('{lane} ({count})', { lane: LANE_LABELS[lane], count: items.length })));
    const list = element('ul', 'recommendation-list');
    for (const item of items) {
      const row = element('li', item.isUnread ? 'recommendation unread' : 'recommendation');
      const open = button(`${kindLabel(item.kind)} · ${ticketText(item.tickets)} · ${item.action}`, {
        cssClass: 'recommendation-open',
        key: `recommendation:${item.id}`,
        action: () => {
          void this.open(item);
        },
      });
      open.setAttribute('aria-expanded', String(this.selected === item.id));
      row.append(open);
      if (item.isUnread) {
        row.append(tag(t('Unread'), 'tag-unread'));
      }
      if (this.selected === item.id) {
        row.append(this.detail(item));
      }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  /**
   * The opened row's evidence and before/after preview.
   *
   * @param item - Opened row.
   * @returns Detail block.
   */
  private detail(item: RecommendationSummary): HTMLElement {
    const detail = element('div', 'recommendation-detail');
    const evidence = element('ul', 'recommendation-evidence');
    for (const line of item.evidence) {
      evidence.append(element('li', '', line));
    }
    const preview = element('dl', 'recommendation-preview');
    preview.append(
      element('dt', 'subtle', t('Before')),
      element('dd', '', item.before),
      element('dt', 'subtle', t('After')),
      element('dd', '', item.after),
    );
    detail.append(element('h4', '', t('Evidence')), evidence, preview);
    if (this.opened?.id === item.id) {
      detail.append(recommendationContext(this.opened));
    }
    return detail;
  }
}

/**
 * Create the Recommendations pane.
 *
 * @param hooks - Shell routes.
 * @returns Pane handle.
 */
export function createRecommendationsView(hooks: RecommendationsHooks): RecommendationsHandle {
  return new RecommendationsView(hooks);
}
