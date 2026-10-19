/**
 * The console shell's in-memory state, kept apart from `app.ts` so the shell stays one readable page.
 *
 * @file
 */
import type { Snapshot } from './api.js';
import type { View } from './navigation.js';
import type { OperatorEdit as Edit } from './recovery-ui.js';
import type { InstallEvent } from './worker-ui.js';

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
  /** Browser install capability. */
  installEvent: InstallEvent | null;
  /** Selected logical worker roles. */
  panes: string[];
  /** Preserve native controls and resized panes while semantic state is unchanged. */
  renderKey: string;
  /** Whether authenticated state is currently arriving. */
  isConnected: boolean;
  /** Consecutive native stream errors. */
  reconnects: number;
}
