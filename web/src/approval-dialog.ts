/**
 * Native `<dialog>` for approving or rejecting a step, shared by the Inbox and
 * delivery views. One request id is generated per opening so a retried
 * submission of the same decision stays idempotent on the server. Errors stay
 * inside the dialog together with the operator's note.
 *
 * @file
 */
import { NOTE_MAX, approvalInput, isPending } from './approval-model.js';
import { button } from './console-dom.js';
import { shortSha } from './console-model.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';

import type { ApprovalTarget } from './approval-model.js';
import type { InboxItem } from './console-model.js';

/** Sends one operator control; resolves `false` (or rejects) when it was not applied. */
export type ControlSender = (operation: string, input: unknown) => Promise<boolean>;

/**
 * Append one term and description to a description list.
 *
 * @param list - Description list to extend.
 * @param term - Visible term.
 * @param value - Untrusted description, rendered as text.
 */
function describe(list: HTMLDListElement, term: string, value: string): void {
  list.append(element('dt', '', term), element('dd', '', value));
}

/** Approval dialog bound to one view. */
export class ApprovalDialog {
  /** Native modal dialog. */
  public readonly element = element('dialog', 'approval-dialog');
  /** Sends the decision; resolves `true` once applied. */
  private readonly control: (operation: string, input: unknown) => Promise<unknown>;
  /** Called after the dialog closes with the focus key of the control that opened it. */
  private readonly closed: (returnKey: string) => void;
  /** Heading naming the decision. */
  private readonly heading = element('h2');
  /** Step, subject and bound head. */
  private readonly context = element('dl', 'approval-context');
  /** Label of the note field. */
  private readonly noteLabel = element('label');
  /** Operator note. */
  private readonly note = element('textarea');
  /** Validation or server error. */
  private readonly error = element('p', 'error');
  /** Polite progress line. */
  private readonly status = element('p', 'subtle');
  /** Submit button. */
  private readonly submit = element('button', 'button primary');
  /** Decision being made. */
  private target: ApprovalTarget | null = null;
  /** Whether the dialog approves rather than rejects. */
  private isApproval = true;
  /** Idempotency key for this opening. */
  private requestId = '';
  /** Focus key of the control that opened the dialog. */
  private returnKey = '';
  /** Whether a submission is in flight. */
  private isSending = false;

  /**
   * Build the dialog once; it is attached to the document on first use.
   *
   * @param send - Operator control sender.
   * @param closed - Restores focus after the dialog closes.
   */
  public constructor(
    send: (operation: string, input: unknown) => Promise<unknown>,
    closed: (returnKey: string) => void,
  ) {
    this.control = send;
    this.closed = closed;
    const id = `approval-dialog-${crypto.randomUUID()}`;
    this.heading.id = `${id}-title`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.note.id = `${id}-note`;
    this.note.rows = 4;
    this.note.maxLength = NOTE_MAX;
    this.noteLabel.htmlFor = this.note.id;
    this.error.setAttribute('role', 'alert');
    this.status.setAttribute('aria-live', 'polite');
    this.submit.type = 'submit';
    const cancel = element('button', 'button ghost', t('Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.element.close();
    });
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, this.submit);
    const form = element('form');
    form.append(this.heading, this.context, this.noteLabel, this.note, this.error, this.status, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    this.element.append(form);
    this.element.addEventListener('close', () => {
      this.target = null;
      this.closed(this.returnKey);
    });
  }

  /**
   * Open the dialog for one decision.
   *
   * @param target - What is decided.
   * @param isApproval - Whether the operator chose to approve.
   * @param returnKey - Focus key of the opening control.
   */
  public open(target: ApprovalTarget, isApproval: boolean, returnKey: string): void {
    if (!this.element.isConnected) {
      document.body.append(this.element);
    }
    this.target = target;
    this.isApproval = isApproval;
    this.returnKey = returnKey;
    this.requestId = crypto.randomUUID();
    this.heading.textContent = t(isApproval ? 'Approve {stepTitle}' : 'Reject {stepTitle}', {
      stepTitle: target.stepTitle,
    });
    this.context.replaceChildren();
    describe(this.context, t('Step'), target.stepTitle);
    describe(this.context, t(target.scope === 'delivery' ? 'Delivery' : 'Objective'), target.subject);
    if (target.scope === 'delivery') {
      describe(this.context, t('Bound head'), shortSha(target.head));
    }
    this.noteLabel.textContent = t(isApproval ? 'Note (optional)' : 'What must change (required)');
    this.note.required = !isApproval;
    this.note.value = '';
    this.error.textContent = '';
    this.status.textContent = '';
    this.submit.textContent = t(isApproval ? 'Approve' : 'Reject');
    this.submit.disabled = false;
    this.element.showModal();
    this.note.focus();
  }

  /**
   * Build the Approve and Reject… buttons that open this dialog.
   *
   * @param target - What the buttons decide.
   * @param keyPrefix - Focus-key prefix unique to the decision within its view.
   * @returns Approve and reject buttons.
   */
  public buttons(target: ApprovalTarget, keyPrefix: string): HTMLButtonElement[] {
    const approve = `${keyPrefix}:approve`;
    const reject = `${keyPrefix}:reject`;
    return [
      button(t('Approve'), {
        cssClass: 'button primary',
        key: approve,
        action: () => {
          this.open(target, true, approve);
        },
      }),
      button(t('Reject…'), {
        cssClass: 'button secondary',
        key: reject,
        action: () => {
          this.open(target, false, reject);
        },
      }),
    ];
  }

  /**
   * Warn when the open decision was answered elsewhere or is no longer waiting.
   *
   * @param open - Current open Inbox items.
   */
  public sync(open: readonly InboxItem[]): void {
    if (this.target === null || this.isSending || isPending(this.target, open)) {
      return;
    }
    this.status.textContent = t('This decision is no longer waiting. It may have been answered elsewhere.');
    this.submit.disabled = true;
  }

  /** Validate and send the decision once; keep the note on failure. */
  private async send(): Promise<void> {
    const { target } = this;
    if (target === null || this.isSending) {
      return;
    }
    const built = approvalInput(target, { requestId: this.requestId, approve: this.isApproval, note: this.note.value });
    if ('error' in built) {
      this.error.textContent = built.error;
      this.note.focus();
      return;
    }
    this.error.textContent = '';
    this.status.textContent = t('Sending…');
    this.isSending = true;
    this.submit.disabled = true;
    const outcome = await this.apply(built.input);
    this.isSending = false;
    if (outcome === true) {
      this.element.close();
      return;
    }
    this.status.textContent = '';
    this.submit.disabled = false;
    this.error.textContent = outcome;
  }

  /**
   * Send the control and translate its outcome.
   *
   * @param input - Validated `factory_approve` input.
   * @returns `true` when applied, otherwise the message to show.
   */
  private async apply(input: unknown): Promise<true | string> {
    try {
      const outcome = await this.control('factory_approve', input);
      return outcome === true
        ? true
        : t(
            'The decision was not applied. Check that the console is connected and see its notice; your note is kept so you can try again.',
          );
    } catch (error) {
      return error instanceof Error ? error.message : t('The decision could not be applied.');
    }
  }
}
