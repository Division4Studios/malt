/**
 * Stable navigation groups with contextual, keyboard-native subviews.
 *
 * @file
 */
import { phrase, translated } from './i18n.js';

/** Existing views remain directly addressable without competing state. */
const GROUPS = {
  mission: ['overview', 'manager', 'activity'],
  inbox: ['inbox'],
  board: ['board', 'objective', 'automations', 'delivery', 'deliveries'],
  workflow: ['workflow', 'team', 'workflows', 'roles', 'pulls'],
  workers: ['sessions', 'workers'],
  costs: ['costs'],
  project: ['setup', 'connections', 'settings', 'recommendations', 'learning', 'secrets', 'capabilities', 'onboarding'],
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
  | 'manager'
  | 'inbox'
  | 'board'
  | 'automations'
  | 'roles'
  | 'secrets'
  | 'capabilities'
  | 'connections'
  | 'delivery'
  | 'objective'
  | 'workflows'
  | 'team'
  | 'workflow'
  | 'deliveries'
  | 'pulls'
  | 'workers'
  | 'sessions'
  | 'costs'
  | 'activity'
  | 'learning'
  | 'setup'
  | 'settings'
  | 'recommendations'
  | 'onboarding';

/** UI navigation descriptions. */
export const HEADINGS: Record<View, readonly [string, string]> = translated({
  overview: [
    phrase('Team operations.'),
    phrase('From intent to verified delivery. Every agent, every handoff, one local team.'),
  ],
  manager: [
    phrase('Delivery manager.'),
    phrase('One persistent session runs the mission with you. Every role reports here.'),
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
  pulls: [
    phrase('Pull requests.'),
    phrase('Local issues, reviewed diffs and protected merges. Nothing leaves this machine.'),
  ],
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
  recommendations: [
    phrase('Recommendations.'),
    phrase('Ticket proposals from the product owner and team lead, by state, with their evidence.'),
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
  connections: [
    phrase('Connections.'),
    phrase('The work tracker and source control, each discovered, saved and verified on its own.'),
  ],
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

/** Rail labels per group, exactly as the console shell shows them. */
const GROUP_LABELS: Readonly<Record<string, string>> = translated({
  mission: phrase('Mission'),
  inbox: phrase('Inbox'),
  board: phrase('Board'),
  workflow: phrase('Workflow'),
  workers: phrase('Sessions'),
  costs: phrase('Costs'),
  project: phrase('Project'),
});
/** Section labels per view; one-view groups and opened details have none. */
const VIEW_LABELS: Readonly<Partial<Record<View, string>>> = translated({
  overview: phrase('Overview'),
  manager: phrase('Manager'),
  activity: phrase('Activity'),
  workflow: phrase('Live map'),
  team: phrase('Team & organization'),
  workflows: phrase('Workflow library'),
  roles: phrase('Roles'),
  pulls: phrase('Pull requests'),
  board: phrase('Board'),
  objective: phrase('Objectives'),
  automations: phrase('Schedules & triggers'),
  deliveries: phrase('Pipeline list'),
  sessions: phrase('Attempts & transcripts'),
  workers: phrase('Workers & terminals'),
  setup: phrase('Setup & capacity'),
  connections: phrase('Connections'),
  settings: phrase('Settings'),
  recommendations: phrase('Recommendations'),
  learning: phrase('Learning & skills'),
  secrets: phrase('Secrets'),
  capabilities: phrase('Capabilities'),
  onboarding: phrase('Get started'),
});

/**
 * Where a view sits in the navigation, in the current language.
 *
 * @param view - Console view.
 * @returns `Group → Section`, or the group alone when the section has no label of its own.
 */
export function viewPath(view: View): string {
  const [group = ''] = Object.entries(GROUPS).find(([, views]) => views.includes(view)) ?? [];
  const groupLabel = GROUP_LABELS[group] ?? '';
  const section = VIEW_LABELS[view];
  return section === undefined || section === groupLabel ? groupLabel : `${groupLabel} → ${section}`;
}
