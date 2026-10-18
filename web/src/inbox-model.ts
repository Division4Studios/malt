/**
 * DOM-free Inbox rules: the answer an operator sends to an agent question,
 * which open items are new since the console last looked, and what a browser
 * notification about one says.
 *
 * @file
 */
import { t } from './i18n.js';

import type { InboxItem } from './console-model.js';

/** Longest written answer the broker accepts. */
export const ANSWER_MAX = 2000;
/** Longest notification body. */
const NOTIFICATION_BODY_MAX = 180;
/** Stored opt-in value. */
export const NOTIFY_ON = 'on';

/** Answer to send, or why it cannot be sent yet. */
export type AnswerInput =
  | {
      readonly ok: true;
      readonly input: { questionId: string; requestId: string; choice: string | null; text: string };
    }
  | { readonly ok: false; readonly error: string };

/**
 * Validate an answer before sending `factory_answer`.
 *
 * @param item - Open question.
 * @param requestId - Idempotency key generated when the dialog opened.
 * @param choice - Selected option, or `null`.
 * @param text - Written answer, possibly empty.
 * @returns Control input, or a message for the dialog.
 */
export function answerInput(item: InboxItem, requestId: string, choice: string | null, text: string): AnswerInput {
  if (item.kind !== 'question' || item.questionId === null) {
    return { ok: false, error: t('This item is not a question.') };
  }
  if (choice !== null && !item.choices.includes(choice)) {
    return { ok: false, error: t('Choose one of the offered options.') };
  }
  const written = text.trim();
  if (written.length > 0 && !item.allowText) {
    return { ok: false, error: t('This question accepts only one of its options.') };
  }
  if (choice === null && written.length === 0) {
    return { ok: false, error: t(item.allowText ? 'Choose an option or write an answer.' : 'Choose an option.') };
  }
  return written.length > ANSWER_MAX
    ? { ok: false, error: t('Keep the answer under {answerMax} characters.', { answerMax: ANSWER_MAX }) }
    : { ok: true, input: { questionId: item.questionId, requestId, choice, text: written } };
}

/**
 * Open items that need a reply and were not open at the previous look.
 *
 * @param previous - Item ids open at the previous snapshot, or `null` before the first one.
 * @param open - Items open now.
 * @returns New reply items, and the ids to remember for the next snapshot.
 */
export function freshItems(
  previous: ReadonlySet<string> | null,
  open: readonly InboxItem[],
): { readonly fresh: readonly InboxItem[]; readonly seen: ReadonlySet<string> } {
  const seen = new Set(open.map((item) => item.id));
  return {
    fresh: previous === null ? [] : open.filter((item) => item.lane === 'reply' && !previous.has(item.id)),
    seen,
  };
}

/**
 * What a browser notification about one item says.
 *
 * @param item - New open item.
 * @returns Title, body and a tag that keeps one notification per item.
 */
export function notificationContent(item: InboxItem): { title: string; body: string; tag: string } {
  const prefix = t(item.kind === 'question' ? 'Question' : 'Needs you');
  const detail =
    item.detail.length > NOTIFICATION_BODY_MAX ? `${item.detail.slice(0, NOTIFICATION_BODY_MAX - 1)}…` : item.detail;
  return { title: `${prefix}: ${item.title}`, body: detail, tag: `malt-inbox:${item.id}` };
}
