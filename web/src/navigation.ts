/**
 * Four stable navigation groups with contextual, keyboard-native subviews.
 *
 * @file
 */
/** Existing views remain directly addressable without competing state. */
const GROUPS = {
  mission: ['overview', 'activity'],
  workflow: ['workflow', 'team', 'deliveries', 'pulls'],
  workers: ['workers'],
  project: ['setup', 'learning'],
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
  'overview' | 'team' | 'workflow' | 'deliveries' | 'pulls' | 'workers' | 'activity' | 'learning' | 'setup';

/** UI navigation descriptions. */
export const HEADINGS: Record<View, readonly [string, string]> = {
  overview: ['Team operations.', 'From intent to verified delivery. Every agent, every handoff, one local team.'],
  workflow: ['Workflow map.', 'Real message traffic. Actual ticket stages. Conditional next handoffs.'],
  team: ['Team constellation.', 'Independent roles. Bounded sessions. Shared project memory.'],
  deliveries: ['Delivery pipeline.', 'Small scopes, independent reviews, verified outcomes.'],
  pulls: ['Pull requests.', 'Local issues, reviewed diffs and protected merges. Nothing leaves this machine.'],
  workers: ['Worker workspaces.', 'Real captured output and durable instructions, side by side.'],
  activity: ['Activity stream.', 'The committed story of your software factory.'],
  learning: ['Learning library.', 'Evidence becomes better skills, checks, and decisions.'],
  setup: ['Project setup.', 'Connect the right repository. Set the gates. Protect local resources.'],
};

/**
 * Validate native navigation without casts or a nested conditional chain.
 *
 * @param value - Untrusted element dataset.
 * @returns Whether the value names a local view.
 */
export const isView = (value: string): value is View => Object.hasOwn(HEADINGS, value);
