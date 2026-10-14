/**
 * Four stable navigation groups with contextual, keyboard-native subviews.
 *
 * @file
 */
/** Existing views remain directly addressable without competing state. */
const GROUPS = {
  mission: ['overview', 'activity'],
  workflow: ['workflow', 'team', 'deliveries'],
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
