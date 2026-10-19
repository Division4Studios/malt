/**
 * The console shell's in-memory state, kept apart from `app.ts` so the shell stays one readable page.
 *
 * @file
 */
import type { Snapshot } from './api.js';
import type { View } from './navigation.js';
import type { OperatorEdit as Edit } from './recovery-ui.js';

/** Application state contains no credential material. */
export interface ShellState {
  /** Last observed backend snapshot. */
  current: Snapshot | null;
  /** Selected public project identifier. */
  project: string;
  /** Local navigation route. */
  view: View;
  /** Authenticated observation stream. */
  stream: EventSource | null;
  /** Current explicit operator control. */
  edit: Edit | null;
  /** Project captured when the operator opened the current draft. */
  editProject: string | null;
  /** Selected logical worker roles. */
  panes: string[];
  /** Preserve native controls and resized panes while semantic state is unchanged. */
  renderKey: string;
  /** Whether authenticated state is currently arriving. */
  isConnected: boolean;
  /** Consecutive native stream errors. */
  reconnects: number;
}

/**
 * The shell's state before the first snapshot: the home project's overview.
 *
 * @returns Fresh state.
 */
export function initialShellState(): ShellState {
  return {
    current: null,
    project: 'home',
    view: 'overview',
    stream: null,
    edit: null,
    editProject: null,
    panes: ['developer-1', 'qa-1'],
    renderKey: '',
    isConnected: false,
    reconnects: 0,
  };
}
