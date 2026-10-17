/**
 * Controller for local pull requests: selection, on-demand diffs and explicit
 * ledger mutations through the existing single-flight operator control.
 *
 * @file
 */
import { data, number, records, request, scoped, text } from './api.js';
import { detailView } from './pulls-ui.js';

import type { Data } from './api.js';
import type { PullActions, PullSelection } from './pulls-ui.js';
import type { OperatorEdit } from './recovery-ui.js';

/** Editor description passed to the shared native dialog. */
interface EditorDescription {
  /** Dialog title. */
  readonly title: string;
  /** Plain explanation. */
  readonly explanation: string;
  /** Initial body. */
  readonly initial: string;
}

/** Controller collaborators owned by the main app. */
export interface PullDependencies {
  /** Current public project identifier. */
  readonly project: () => string;
  /** Single-flight operator control. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
  /** Shared native editor dialog. */
  readonly editor: (description: EditorDescription, action: OperatorEdit) => void;
  /** Re-render the current view. */
  readonly render: () => void;
}

/** A parsed ticket entered as plain text. */
interface TicketText {
  /** First nonempty line. */
  readonly title: string;
  /** Remaining prose. */
  readonly description: string;
  /** Lines beginning with "- ". */
  readonly acceptanceCriteria: string[];
}

/** Longest an open pull request's review evidence is shown before it is re-read. */
const EVIDENCE_REFRESH_MS = 15_000;

/** Editor guidance shared by feature and delivery dialogs. */
const TICKET_FORMAT =
  'First line: title. Following lines: the observable outcome and boundaries. Each line starting with "- " is one acceptance criterion.';

/**
 * Parse a plain-text ticket.
 *
 * @param body - Operator text.
 * @returns Title, description and criteria.
 * @throws {Error} When the title or criteria are missing.
 */
export function parseTicket(body: string): TicketText {
  const lines = body.split('\n').map((line) => line.trim());
  const title = lines.find((line) => line !== '') ?? '';
  if (title === '') {
    throw new Error('Enter a title on the first line.');
  }
  const rest = lines.slice(lines.indexOf(title) + 1);
  const acceptanceCriteria = rest.filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());
  if (acceptanceCriteria.length === 0) {
    throw new Error('Add at least one acceptance criterion on a line starting with "- ".');
  }
  const description = rest
    .filter((line) => !line.startsWith('- '))
    .join('\n')
    .trim();
  return { title, description: description === '' ? title : description, acceptanceCriteria };
}

/** Local delivery view controller. */
export class PullController {
  /** Current selection rendered by the view. */
  public selection: PullSelection = { number: null, detail: null, error: '' };
  /** View callbacks. */
  public readonly actions: PullActions;
  /** App collaborators. */
  private readonly dependencies: PullDependencies;
  /** Rendered detail pane for the current selection, kept across live refreshes. */
  private rendered: { readonly selection: PullSelection; readonly node: HTMLElement } | null = null;
  /** Project whose ledger the current selection belongs to. */
  private observedProject: string | null = null;
  /** Pull request whose detail is being read, so refreshes never overlap. */
  private loading: number | null = null;
  /** When the selected detail was last read. */
  private loadedAt = 0;

  /**
   * Bind controller callbacks.
   *
   * @param dependencies - App collaborators.
   */
  public constructor(dependencies: PullDependencies) {
    this.dependencies = dependencies;
    const { control, editor } = dependencies;
    const local = (input: unknown): void => {
      void control('factory_local', input);
    };
    this.actions = {
      select: (pull) => {
        this.selection = { number: pull, detail: null, error: '' };
        dependencies.render();
        void this.load(pull);
      },
      sync: () => {
        local({ action: 'sync' });
      },
      move: (issue, status) => {
        local({ action: 'set_status', number: issue, status });
      },
      comment: (target) => {
        editor(
          { title: `Comment on #${String(target)}`, explanation: 'Saved to the local delivery record.', initial: '' },
          { operation: 'factory_local', input: (body) => ({ action: 'comment', number: target, body }) },
        );
      },
      createFeature: () => {
        const requestId = `feature-${crypto.randomUUID()}`;
        editor(
          { title: 'New local feature', explanation: TICKET_FORMAT, initial: '' },
          {
            operation: 'factory_local',
            input: (body) => ({ action: 'create_issue', requestId, kind: 'feature', ...parseTicket(body) }),
          },
        );
      },
      createDelivery: (parent) => {
        const requestId = `delivery-${crypto.randomUUID()}`;
        editor(
          {
            title: `New Ready delivery under #${String(parent)}`,
            explanation: `${TICKET_FORMAT} The factory imports it as soon as it is Ready.`,
            initial: '',
          },
          {
            operation: 'factory_local',
            input: (body) => {
              return {
                action: 'create_issue',
                requestId,
                kind: 'delivery',
                parent,
                status: 'Ready',
                ...parseTicket(body),
              };
            },
          },
        );
      },
    };
  }

  /**
   * Return the selected pull request's pane, rebuilding only when the selection changed.
   * Reusing the node preserves expanded files, revealed lines and scroll position.
   *
   * @returns Detail pane.
   */
  public detail(): HTMLElement {
    if (this.rendered?.selection !== this.selection) {
      this.rendered = { selection: this.selection, node: detailView(this.selection, this.actions) };
    }
    return this.rendered.node;
  }

  /**
   * Apply a new snapshot: forget another project's selection, and reload the
   * selected detail when its record changed. Pushes to an open pull request's
   * branch and base advances change the hub without touching the ledger, so an
   * open pull request is also re-read once its evidence is older than the bound.
   *
   * @param local - Latest ledger summary.
   */
  public observe(local: Data | null): void {
    const project = this.dependencies.project();
    if (this.observedProject !== project) {
      this.observedProject = project;
      this.selection = { number: null, detail: null, error: '' };
      return;
    }
    const { number: selected, detail } = this.selection;
    if (selected === null || detail === null || local === null) {
      return;
    }
    const current = records(local['pulls']).find((pull) => number(pull, 'number') === selected);
    if (current === undefined) {
      return;
    }
    const loaded = data(detail['pull']);
    const isChanged = number(current, 'updatedAt') !== number(loaded, 'updatedAt');
    const isStale = text(current, 'state') === 'OPEN' && Date.now() - this.loadedAt >= EVIDENCE_REFRESH_MS;
    if (isChanged || isStale) {
      void this.load(selected);
    }
  }

  /**
   * Fetch one pull request's detail and diff.
   *
   * @param pull - Pull-request number.
   */
  private async load(pull: number): Promise<void> {
    if (this.loading === pull) {
      return;
    }
    this.loading = pull;
    const project = this.dependencies.project();
    const isCurrent = (): boolean => this.selection.number === pull && this.dependencies.project() === project;
    try {
      const detail = data(await request(`${scoped(project, '/api/local-pull')}&number=${String(pull)}`));
      this.loadedAt = Date.now();
      // Unchanged evidence keeps the rendered pane, with its expanded files and revealed lines.
      if (isCurrent() && JSON.stringify(detail) !== JSON.stringify(this.selection.detail)) {
        this.selection = { number: pull, detail, error: '' };
      }
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : 'Could not load this pull request.';
        this.selection = { number: pull, detail: null, error: message };
      }
    } finally {
      this.loading = null;
    }
    this.dependencies.render();
  }
}
