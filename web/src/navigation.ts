/**
 * Stable navigation groups with contextual, keyboard-native subviews.
 *
 * @file
 */
import { phrase, translated } from './i18n.js';

/** Existing views remain directly addressable without competing state. */
const GROUPS = {
  mission: ['overview', 'activity'],
  inbox: ['inbox'],
  board: ['board', 'objective', 'automations', 'delivery', 'deliveries'],
  workflow: ['workflow', 'team', 'workflows', 'roles'],
  workers: ['sessions', 'workers'],
  costs: ['costs'],
  project: ['setup', 'settings', 'learning', 'secrets', 'capabilities', 'onboarding'],
};

/**
 * Bind native buttons once; the main controller validates and owns navigation.
 *
 * @param select - Controller route callback.
 */
export function bindNavigation(select: (view: string) => void): void {
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    item.addEventListener('click', () => {
      const { view } = item.dataset;
      if (view !== undefined) {
        select(view);
      }
    });
  }
}

/**
 * Highlight the selected group and reveal only its related subviews.
 *
 * @param view - Current controller-owned route.
 */
export function updateNavigation(view: string): void {
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const isSelected = item.dataset['view'] === view;
    item.classList.toggle('active', isSelected);
    item.setAttribute('aria-current', isSelected ? 'page' : 'false');
  }
  for (const [group, views] of Object.entries(GROUPS)) {
    const isSelected = views.includes(view);
    const button = document.querySelector<HTMLButtonElement>(`[data-group="${CSS.escape(group)}"]`);
    button?.classList.toggle('active', isSelected);
    button?.setAttribute('aria-current', isSelected ? 'true' : 'false');
    for (const section of document.querySelectorAll<HTMLElement>(`[data-navigation="${CSS.escape(group)}"]`)) {
      section.hidden = !isSelected;
    }
  }
}

/** View routes remain local UI state, not a competing delivery ledger. */
export type View =
  | 'overview'
  | 'inbox'
  | 'board'
  | 'automations'
  | 'roles'
  | 'secrets'
  | 'capabilities'
  | 'delivery'
  | 'objective'
  | 'workflows'
  | 'team'
  | 'workflow'
  | 'deliveries'
  | 'workers'
  | 'sessions'
  | 'costs'
  | 'activity'
  | 'learning'
  | 'setup'
  | 'settings'
  | 'onboarding';

/** UI navigation descriptions. */
export const HEADINGS: Record<View, readonly [string, string]> = translated({
  overview: [
    phrase('Team operations.'),
    phrase('From intent to verified delivery. Every agent, every handoff, one local team.'),
  ],
  inbox: [phrase('Inbox.'), phrase('Every decision waiting on you, oldest first, with what you already answered.')],
  board: [
    phrase('Delivery board.'),
    phrase('Each delivery placed by what it needs next, with its whole pipeline at a glance.'),
  ],
  automations: [
    phrase('Schedules and triggers.'),
    phrase('Objectives filed on a cron schedule or by a local script, through the same review gates.'),
  ],
  delivery: [phrase('Delivery.'), phrase('Its pipeline, findings, rulings and source, step by step.')],
  objective: [
    phrase('Objectives.'),
    phrase('What done means for each objective, who checked it, and everything that happened.'),
  ],
  workflows: [
    phrase('Workflow library.'),
    phrase('How objectives become verified deliveries: steps, seats, gates and reviews.'),
  ],
  workflow: [phrase('Workflow map.'), phrase('Real message traffic. Actual ticket stages. Conditional next handoffs.')],
  team: [phrase('Team constellation.'), phrase('Independent roles. Bounded sessions. Shared project memory.')],
  deliveries: [phrase('Pipeline list.'), phrase('Small scopes, independent reviews, verified outcomes.')],
  workers: [phrase('Worker workspaces.'), phrase('Real captured output and durable instructions, side by side.')],
  sessions: [
    phrase('Attempts and transcripts.'),
    phrase('Every bounded attempt: what it read, ran, changed and cost.'),
  ],
  costs: [phrase('Costs.'), phrase('Spend and tokens from recorded usage, by role, model and delivery.')],
  activity: [phrase('Activity stream.'), phrase('The committed story of your software factory.')],
  learning: [phrase('Learning library.'), phrase('Evidence becomes better skills, checks, and decisions.')],
  setup: [phrase('Project setup.'), phrase('Connect the right repository. Set the gates. Protect local resources.')],
  settings: [
    phrase('Settings.'),
    phrase('Appearance, provider health and build facts, with every setting one step away.'),
  ],
  onboarding: [
    phrase('Get started.'),
    phrase('From an empty project to the first role at work, with the reason if it cannot start.'),
  ],
  roles: [
    phrase('Roles.'),
    phrase('What each seat is: its instructions, provider, model, skills, tools and local MCP servers.'),
  ],
  secrets: [phrase('Secrets.'), phrase('Local encrypted keys and tokens, granted to the role types that need them.')],
  capabilities: [
    phrase('Capabilities.'),
    phrase('What humans and approved roles may do through connectors, beside what the provider supports.'),
  ],
});

/**
 * Validate native navigation without casts or a nested conditional chain.
 *
 * @param value - Untrusted element dataset.
 * @returns Whether the value names a local view.
 */
export const isView = (value: string): value is View => Object.hasOwn(HEADINGS, value);
