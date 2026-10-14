/**
 * Preserve project-scoped native queue interactions across snapshot replacement.
 *
 * @file
 */
/** Native queue state isolated to one selected project. */
export class QueueState {
  /** Scope prevents identical feature IDs from leaking between projects. */
  private project = '';
  /** Retain both open and closed choices, including while another view is selected. */
  private readonly details = new Map<string, boolean>();

  /**
   * Replace a view while restoring only the selected project's queue state.
   *
   * @param target - Existing content container.
   * @param next - Newly rendered view.
   * @param project - Selected project identifier.
   */
  public replace(target: HTMLElement, next: HTMLElement, project: string): void {
    const isSameProject = project === this.project;
    let focus = '';
    if (isSameProject) {
      for (const detail of target.querySelectorAll<HTMLDetailsElement>('details[data-queue-key]')) {
        this.details.set(detail.dataset['queueKey'] ?? '', detail.open);
      }
      const active = target.ownerDocument.activeElement;
      if (active instanceof HTMLElement && target.contains(active)) {
        focus = active.dataset['queueFocus'] ?? '';
      }
    } else {
      this.details.clear();
      this.project = project;
    }
    for (const detail of next.querySelectorAll<HTMLDetailsElement>('details[data-queue-key]')) {
      detail.open = this.details.get(detail.dataset['queueKey'] ?? '') ?? false;
    }
    target.replaceChildren(next);
    if (focus === '') {
      return;
    }
    const control = target.querySelector<HTMLElement>(`[data-queue-focus="${CSS.escape(focus)}"]`);
    control?.focus({ preventScroll: true });
  }
}
