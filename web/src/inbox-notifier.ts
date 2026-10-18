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
import { t } from './i18n.js';
import { NOTIFY_ON, freshItems, inboxRequest, notificationContent } from './inbox-model.js';
import { element } from './worker-ui.js';

import type { InboxItem } from './console-model.js';

/** Browser storage key for the operator's choice; a convenience, never required. */
const PREFERENCE_KEY = 'malt.inbox.notifications';

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
  /** Routes the console to a project's Inbox (`null` keeps the selected project). */
  private readonly openInbox: (project: string | null) => void;
  /** Selected project, which a notification remembers. */
  private readonly project: () => string;

  /**
   * Build the toggle and listen for notification clicks.
   *
   * @param openInbox - Routes the console to a project's Inbox.
   * @param project - Selected project id.
   */
  public constructor(openInbox: (project: string | null) => void, project: () => string) {
    this.openInbox = openInbox;
    this.project = project;
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => {
      void this.change();
    });
    this.element.append(this.toggle, ' ', this.hint);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const requested = event.origin === location.origin ? inboxRequest(event.data) : undefined;
        if (requested !== undefined) {
          openInbox(requested);
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
    const project = this.project();
    for (const item of fresh) {
      void show(item, project, this.openInbox);
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
      this.toggle.textContent = t('Notifications unavailable');
      this.hint.textContent = t('This browser cannot show notifications.');
      return;
    }
    const isBlocked = Notification.permission === 'denied';
    const isActive = this.isOn && Notification.permission === 'granted';
    this.toggle.disabled = isBlocked;
    this.toggle.setAttribute('aria-pressed', String(isActive));
    this.toggle.textContent = t(isActive ? 'Notifications on' : 'Notify me');
    this.hint.textContent = t(
      isBlocked
        ? 'Notifications are blocked in this browser’s site settings.'
        : 'While this console is open in the background, new decisions raise a notification.',
    );
  }
}

/**
 * Raise one notification through the service worker, or directly without one.
 *
 * @param item - New open item.
 * @param project - Project the item belongs to; a click shows that project's Inbox.
 * @param openInbox - Routes the console to the Inbox when a direct notification is clicked.
 */
async function show(item: InboxItem, project: string, openInbox: (project: string) => void): Promise<void> {
  const content = notificationContent(item);
  const options = { body: content.body, tag: content.tag, data: { view: 'inbox', project } };
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (registration === undefined) {
    const notification = new Notification(content.title, options);
    notification.addEventListener('click', () => {
      focus();
      openInbox(project);
    });
    return;
  }
  await registration.showNotification(content.title, options);
}
