/**
 * Typed view of the compiled `inbox-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/inbox-model.js' {
  /** Inbox item fields the Inbox rules read. */
  interface InboxItem {
    /** Item id. */
    readonly id: string;
    /** Decision kind. */
    readonly kind: string;
    /** Lane. */
    readonly lane: 'reply' | 'notice';
    /** Headline. */
    readonly title: string;
    /** Context. */
    readonly detail: string;
    /** Agent question. */
    readonly questionId: string | null;
    /** Offered answers. */
    readonly choices: readonly string[];
    /** Whether a written answer is accepted. */
    readonly allowText: boolean;
  }
  /** Longest written answer. */
  export const ANSWER_MAX: number;

  /**
   * Validate an answer before sending it.
   *
   * @param item - Open question.
   * @param requestId - Idempotency key.
   * @param choice - Selected option.
   * @param text - Written answer.
   * @returns Control input, or a message.
   */
  export function answerInput(
    item: InboxItem,
    requestId: string,
    choice: string | null,
    text: string,
  ):
    | {
        readonly ok: true;
        readonly input: { questionId: string; requestId: string; choice: string | null; text: string };
      }
    | { readonly ok: false; readonly error: string };

  /**
   * New reply items since the previous snapshot.
   *
   * @param previous - Ids open at the previous snapshot.
   * @param open - Items open now.
   * @returns New items and the ids to remember.
   */
  export function freshItems(
    previous: ReadonlySet<string> | null,
    open: readonly InboxItem[],
  ): { readonly fresh: readonly InboxItem[]; readonly seen: ReadonlySet<string> };

  /** Message the service worker posts when a notification is clicked. */
  export const OPEN_INBOX_MESSAGE: string;

  /**
   * Read a notification click relayed by the service worker.
   *
   * @param message - Untrusted message data.
   * @returns Project to show, `null` for the selected one, or `undefined` for another message.
   */
  export function inboxRequest(message: unknown): string | null | undefined;

  /**
   * Notification text for one item.
   *
   * @param item - New open item.
   * @returns Title, body and tag.
   */
  export function notificationContent(item: InboxItem): { title: string; body: string; tag: string };
}
