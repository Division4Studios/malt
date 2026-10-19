/**
 * Native `<dialog>` for answering an agent question in the Inbox: one radio
 * button per offered choice and, when the question allows it, a written
 * answer. One request id is generated per opening so a retried submission
 * stays idempotent on the server. Errors stay inside the dialog with the
 * operator's draft.
 *
 * @file
 */
import { button } from './console-dom.js';
import { t } from './i18n.js';
import { ANSWER_MAX, answerInput } from './inbox-model.js';
import { element } from './worker-ui.js';

import type { ControlSender } from './approval-dialog.js';
import type { InboxItem } from './console-model.js';

/** Question dialog bound to one view. */
export class QuestionDialog {
  /** Native modal dialog. */
  public readonly element = element('dialog', 'approval-dialog question-dialog');
  /** Sends the answer. */
  private readonly control: ControlSender;
  /** Called after the dialog closes with the focus key of the control that opened it. */
  private readonly closed: (returnKey: string) => void;
  /** Heading naming who asks. */
  private readonly heading = element('h2');
  /** The question itself. */
  private readonly question = element('p', 'question-text');
  /** Choice radio buttons. */
  private readonly choices = element('fieldset', 'question-choices');
  /** Label of the written answer. */
  private readonly textLabel = element('label', '', t('Your answer'));
  /** Written answer. */
  private readonly text = element('textarea');
  /** Validation or server error. */
  private readonly error = element('p', 'error');
  /** Polite progress line. */
  private readonly status = element('p', 'subtle');
  /** Submit button. */
  private readonly submit = element('button', 'button primary', t('Send answer'));
  /** Question being answered. */
  private item: InboxItem | null = null;
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
  public constructor(send: ControlSender, closed: (returnKey: string) => void) {
    this.control = send;
    this.closed = closed;
    const id = `question-dialog-${crypto.randomUUID()}`;
    this.heading.id = `${id}-title`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.question.id = `${id}-question`;
    this.element.setAttribute('aria-describedby', this.question.id);
    this.text.id = `${id}-text`;
    this.text.rows = 4;
    this.text.maxLength = ANSWER_MAX;
    this.textLabel.htmlFor = this.text.id;
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
    form.append(this.heading, this.question, this.choices, this.textLabel, this.text, this.error, this.status, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    this.element.append(form);
    this.element.addEventListener('close', () => {
      this.item = null;
      this.closed(this.returnKey);
    });
  }

  /**
   * The Answer… button that opens this dialog for one question.
   *
   * @param item - Open question the button answers.
   * @returns Native button carrying the item's focus key.
   */
  public button(item: InboxItem): HTMLButtonElement {
    const key = `${item.id}:answer`;
    return button(t('Answer…'), {
      cssClass: 'button primary',
      key,
      action: () => {
        this.open(item, key);
      },
    });
  }

  /**
   * Warn when the open question was answered elsewhere.
   *
   * @param open - Current open Inbox items.
   */
  public sync(open: readonly InboxItem[]): void {
    const { item } = this;
    if (item === null || this.isSending || open.some((candidate) => candidate.id === item.id)) {
      return;
    }
    this.status.textContent = t('This question is no longer open. It may have been answered elsewhere.');
    this.submit.disabled = true;
  }

  /**
   * Open the dialog for one question.
   *
   * @param item - Open question to answer, with its choices.
   * @param returnKey - Focus key of the opening control.
   */
  private open(item: InboxItem, returnKey: string): void {
    if (!this.element.isConnected) {
      document.body.append(this.element);
    }
    this.item = item;
    this.returnKey = returnKey;
    this.requestId = crypto.randomUUID();
    this.heading.textContent = item.title;
    this.question.textContent = item.detail;
    this.renderChoices(item);
    this.textLabel.hidden = !item.allowText;
    this.text.hidden = !item.allowText;
    this.textLabel.textContent = t(item.choices.length > 0 ? 'Add a note (optional)' : 'Your answer');
    this.text.value = '';
    this.error.textContent = '';
    this.status.textContent = '';
    this.submit.disabled = false;
    this.element.showModal();
    const first = this.choices.querySelector('input');
    (first ?? this.text).focus();
  }

  /**
   * Build one radio button per offered choice.
   *
   * @param item - Question being answered.
   */
  private renderChoices(item: InboxItem): void {
    const name = `${this.heading.id}-choice`;
    const legend = element('legend', '', t('Choose one'));
    const options = item.choices.map((choice, index) => {
      const label = element('label', 'question-choice');
      const input = element('input');
      input.type = 'radio';
      input.name = name;
      input.value = choice;
      input.id = `${name}-${String(index)}`;
      label.htmlFor = input.id;
      label.append(input, ' ', choice);
      return label;
    });
    this.choices.hidden = options.length === 0;
    this.choices.replaceChildren(legend, ...options);
  }

  /** Validate and send the answer once; keep the draft on failure. */
  private async send(): Promise<void> {
    const { item } = this;
    if (item === null || this.isSending) {
      return;
    }
    const checked = this.choices.querySelector<HTMLInputElement>('input:checked');
    const built = answerInput(item, this.requestId, checked?.value ?? null, item.allowText ? this.text.value : '');
    if (!built.ok) {
      this.error.textContent = built.error;
      return;
    }
    this.error.textContent = '';
    this.status.textContent = t('Sending…');
    this.isSending = true;
    this.submit.disabled = true;
    const sent = this.requestId;
    const outcome = await this.apply(built.input);
    this.isSending = false;
    if (sent !== this.requestId) {
      // The dialog was closed and reopened for another question while this answer was sending.
      return;
    }
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
   * @param input - Validated `factory_answer` input.
   * @returns `true` when applied, otherwise the message to show.
   */
  private async apply(input: unknown): Promise<true | string> {
    try {
      const isOutcome = await this.control('factory_answer', input);
      return isOutcome
        ? true
        : t(
            'The answer was not applied. Check that the console is connected and see its notice; your draft is kept so you can try again.',
          );
    } catch (error) {
      return error instanceof Error ? error.message : t('The answer could not be applied.');
    }
  }
}
