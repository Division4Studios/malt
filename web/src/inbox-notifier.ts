/**
 * Opt-in browser notifications for new Inbox items. They are local-first:
 * the open or installed console raises them from its own snapshot stream
 * through the service worker, so nothing is sent to a push service and no
 * notification arrives while every console window is closed. A notification
 * appears only when the console is hidden, at most once per item, and
 * clicking it focuses the console on the Inbox.
 *
 * @file
 */
import { NOTIFY_ON, freshItems, notificationContent } from './inbox-model.js';
import { element } from './worker-ui.js';

import type { InboxItem } from './console-model.js';

/** Browser storage key for the operator's choice; a convenience, never required. */
const PREFERENCE_KEY = 'malt.inbox.notifications';
/** Message the service worker posts when a notification is clicked. */
export const OPEN_INBOX_MESSAGE = 'malt-open-inbox';

/**
 * Whether this browser can show notifications at all.
 *
 * @returns True when the Notification API exists.
 */
function isSupported(): boolean {
  return 'Notification' in globalThis;
}

/**
 * Read the stored opt-in.
 *
 * @returns True when the operator turned notifications on here.
 */
function isPreferenceOn(): boolean {
  try {
    return localStorage.getItem(PREFERENCE_KEY) === NOTIFY_ON;
  } catch {
    return false;
  }
}

/**
 * Store the opt-in when storage is available.
 *
 * @param isOn - Whether notifications are on.
 */
function writePreference(isOn: boolean): void {
  try {
    if (isOn) {
      localStorage.setItem(PREFERENCE_KEY, NOTIFY_ON);
    } else {
      localStorage.removeItem(PREFERENCE_KEY);
    }
  } catch {
    // Without storage the choice lasts for this page only.
  }
}

/** Notification toggle and delivery for one console. */
export class InboxNotifier {
  /** Toggle shown in the Inbox. */
  public readonly element = element('div', 'inbox-notify');
  /** Toggle button. */
  private readonly toggle = element('button', 'button secondary');
  /** Why notifications are off or unavailable. */
  private readonly hint = element('span', 'subtle');
  /** Whether the operator turned notifications on. */
  private isOn = isPreferenceOn();
  /** Items open at the previous snapshot; `null` until the first one. */
  private previous: ReadonlySet<string> | null = null;
  /** Routes the console to the Inbox. */
  private readonly openInbox: () => void;

  /**
   * Build the toggle and listen for notification clicks.
   *
   * @param openInbox - Routes the console to the Inbox.
   */
  public constructor(openInbox: () => void) {
    this.openInbox = openInbox;
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => {
      void this.change();
    });
    this.element.append(this.toggle, ' ', this.hint);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.origin === location.origin && event.data === OPEN_INBOX_MESSAGE) {
          openInbox();
        }
      });
    }
    this.paint();
  }

  /**
   * Notify about items that are new since the previous snapshot.
   *
   * @param open - Items open now.
   */
  public update(open: readonly InboxItem[]): void {
    const { fresh, seen } = freshItems(this.previous, open);
    this.previous = seen;
    if (
      !this.isOn ||
      !isSupported() ||
      Notification.permission !== 'granted' ||
      document.visibilityState !== 'hidden'
    ) {
      return;
    }
    for (const item of fresh) {
      void show(item, this.openInbox);
    }
  }

  /** Turn notifications on (asking the browser on this click) or off. */
  private async change(): Promise<void> {
    if (!isSupported()) {
      return;
    }
    if (this.isOn) {
      this.isOn = false;
    } else {
      const permission =
        Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      this.isOn = permission === 'granted';
    }
    writePreference(this.isOn);
    this.paint();
  }

  /** Show the toggle's current state. */
  private paint(): void {
    if (!isSupported()) {
      this.toggle.disabled = true;
      this.toggle.textContent = 'Notifications unavailable';
      this.hint.textContent = 'This browser cannot show notifications.';
      return;
    }
    const isBlocked = Notification.permission === 'denied';
    const isActive = this.isOn && Notification.permission === 'granted';
    this.toggle.disabled = isBlocked;
    this.toggle.setAttribute('aria-pressed', String(isActive));
    this.toggle.textContent = isActive ? 'Notifications on' : 'Notify me';
    this.hint.textContent = isBlocked
      ? 'Notifications are blocked in this browser’s site settings.'
      : 'While this console is open in the background, new decisions raise a notification.';
  }
}

/**
 * Raise one notification through the service worker, or directly without one.
 *
 * @param item - New open item.
 * @param openInbox - Routes the console to the Inbox when a direct notification is clicked.
 */
async function show(item: InboxItem, openInbox: () => void): Promise<void> {
  const content = notificationContent(item);
  const options = { body: content.body, tag: content.tag, data: { view: 'inbox' } };
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (registration === undefined) {
    const notification = new Notification(content.title, options);
    notification.addEventListener('click', () => {
      focus();
      openInbox();
    });
    return;
  }
  await registration.showNotification(content.title, options);
}
