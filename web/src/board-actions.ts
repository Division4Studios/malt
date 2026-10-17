/**
 * Board bulk actions: hold or resume every unfinished delivery the filters
 * show, archive every finished delivery, and restore recently archived ones.
 * Bulk changes ask for confirmation in a native in-app dialog and name how
 * many deliveries they touch; a running attempt is never interrupted.
 *
 * @file
 */
import { bulkTargets } from './board-model.js';
import { button } from './console-dom.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';
import { isConfirmed } from './workflow-dom.js';

import type { ControlSender } from './approval-dialog.js';
import type { BoardGroups } from './board-model.js';
import type { ConsoleModel } from './console-model.js';

/**
 * A count with its noun.
 *
 * @param count - How many deliveries.
 * @returns For example "1 delivery" or "3 deliveries".
 */
function deliveries(count: number): string {
  return `${String(count)} deliver${count === 1 ? 'y' : 'ies'}`;
}

/** The bulk action bar and archived list under the board filters. */
export class BoardActions {
  /** Stable root. */
  public readonly element = element('div', 'board-actions');
  /** Holds the unfinished deliveries shown. */
  private readonly hold: HTMLButtonElement;
  /** Resumes the held deliveries shown. */
  private readonly resume: HTMLButtonElement;
  /** Archives every finished delivery. */
  private readonly archive: HTMLButtonElement;
  /** Recently archived deliveries with restore buttons. */
  private readonly archived = element('details', 'board-archived');
  /** Operator control path. */
  private readonly control: ControlSender;
  /** Current targets. */
  private targets: { hold: string[]; resume: string[] } = { hold: [], resume: [] };

  /**
   * Build the controls once.
   *
   * @param control - Operator control path.
   */
  public constructor(control: ControlSender) {
    this.control = control;
    this.hold = button(t('Hold shown'), {
      cssClass: 'button secondary',
      key: 'bulk-hold',
      action: () => {
        void this.bulkHold(true);
      },
    });
    this.resume = button(t('Resume shown'), {
      cssClass: 'button secondary',
      key: 'bulk-resume',
      action: () => {
        void this.bulkHold(false);
      },
    });
    this.archive = button(t('Archive finished'), {
      cssClass: 'button ghost',
      key: 'bulk-archive',
      action: () => {
        void this.archiveFinished();
      },
    });
    this.element.append(this.hold, this.resume, this.archive, this.archived);
  }

  /**
   * Reflect the cards shown and the archived list.
   *
   * @param groups - Cards the filters show.
   * @param model - Latest console projection.
   */
  public update(groups: BoardGroups, model: ConsoleModel): void {
    this.targets = bulkTargets(groups);
    this.hold.textContent = t('Hold {value} shown', { value: deliveries(this.targets.hold.length) });
    this.hold.disabled = this.targets.hold.length === 0;
    this.resume.textContent = t('Resume {value} shown', { value: deliveries(this.targets.resume.length) });
    this.resume.disabled = this.targets.resume.length === 0;
    this.archive.disabled = model.deliveries.every((delivery) => delivery.phase !== 'done');
    this.archived.hidden = model.archived.total === 0;
    const summary = element('summary', '', t('Archived ({total})', { total: model.archived.total }));
    const list = element('ul', 'board-archived-list');
    list.append(
      ...model.archived.recent.map((entry) => {
        const item = element('li');
        const restore = button(t('Restore'), {
          cssClass: 'button ghost',
          key: `restore-${entry.taskId}`,
          action: () => {
            void this.control('factory_archive', { taskIds: [entry.taskId], archive: false });
          },
        });
        item.append(element('span', '', `#${String(entry.issue)} ${entry.title}`), restore);
        return item;
      }),
    );
    const wasFocused = this.archived.contains(document.activeElement);
    this.archived.replaceChildren(summary, list);
    if (wasFocused) {
      // A restored row leaves the list; keep focus in the archive controls rather than the page body.
      (list.querySelector('button') ?? (this.archived.hidden ? this.archive : summary)).focus();
    }
  }

  /**
   * Hold or resume the deliveries shown after confirmation.
   *
   * @param isHold - Hold when true, resume when false.
   */
  private async bulkHold(isHold: boolean): Promise<void> {
    const taskIds = isHold ? this.targets.hold : this.targets.resume;
    const isSure = await isConfirmed(this.element, {
      title: t(isHold ? 'Hold {value}?' : 'Resume {value}?', { value: deliveries(taskIds.length) }),
      message: t(
        isHold
          ? 'No new attempt starts on them until you resume. Attempts already running finish normally.'
          : 'They become eligible for new attempts as soon as capacity allows.',
      ),
      confirm: t(isHold ? 'Hold' : 'Resume'),
      cancel: t('Cancel'),
    });
    if (isSure) {
      await this.control('factory_hold', { taskIds, hold: isHold });
    }
  }

  /** Archive every finished delivery after confirmation. */
  private async archiveFinished(): Promise<void> {
    const isSure = await isConfirmed(this.element, {
      title: t('Archive every finished delivery?'),
      message: t(
        'Finished deliveries leave the board; their history, branches and evidence are kept, and you can restore any of them here.',
      ),
      confirm: t('Archive'),
      cancel: t('Cancel'),
    });
    if (isSure) {
      await this.control('factory_archive', { all: true, archive: true });
    }
  }
}
