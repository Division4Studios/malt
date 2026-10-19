/**
 * Typed view of the compiled `console-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/console-model.js' {
  /** Plain step state. */
  type StepState = 'done' | 'running' | 'ready' | 'needs_you' | 'waiting';
  /** Board column. */
  type Column = 'planning' | 'ready' | 'in_progress' | 'needs_you' | 'done';
  /** Validated pipeline step. */
  export interface Step {
    /** Step id. */
    readonly id: string;
    /** Human title. */
    readonly title: string;
    /** Execution layer. */
    readonly layer: number;
    /** Plain state. */
    readonly state: StepState;
    /** Seats that may perform it. */
    readonly roles: readonly string[];
    /** Latest result. */
    readonly result: {
      readonly outcome: string;
      readonly summary: string;
      readonly findings: readonly string[];
      readonly dispositions: readonly { id: string; decision: string; reason: string; evidence: string }[];
    } | null;
  }
  /** Validated delivery card. */
  export interface Delivery {
    /** Delivery id. */
    readonly taskId: string;
    /** Issue number. */
    readonly issue: number;
    /** Title. */
    readonly title: string;
    /** Board column. */
    readonly column: Column;
    /** Workflow identity. */
    readonly workflow: { readonly id: string; readonly name: string };
    /** Steps. */
    readonly steps: readonly Step[];
    /** Live attempt and its checkpoint liveness. */
    readonly running: {
      readonly jobId: string;
      readonly role: string;
      readonly step: string | null;
      readonly liveness: Liveness | null;
    } | null;
    /** Retry backoff of the latest failed step. */
    readonly retry: Retry | null;
    /** Current head. */
    readonly head: string | null;
    /** Pull request link. */
    readonly prUrl: string | null;
    /** Blocking dependency issues. */
    readonly waitingOn: readonly number[];
    /** Ledger phase. */
    readonly phase: string;
    /** Operator hold. */
    readonly held: { readonly at: number; readonly reason: string } | null;
    /** Recent CI-failure and merge-conflict repair rounds, oldest first. */
    readonly repairs: readonly {
      readonly kind: 'ci' | 'conflict';
      readonly at: number;
      readonly head: string;
      readonly summary: string;
      readonly findings: readonly string[];
    }[];
    /** Kept on the board after finishing. */
    readonly isKept: boolean;
  }
  /** Validated open Inbox item. */
  export interface InboxItem {
    /** Item id. */
    readonly id: string;
    /** Decision kind. */
    readonly kind: string;
    /** Lane: needs a reply, or a notice. */
    readonly lane: 'reply' | 'notice';
    /** Headline. */
    readonly title: string;
    /** Context for the operator. */
    readonly detail: string;
    /** Delivery concerned. */
    readonly taskId: string | null;
    /** Objective concerned. */
    readonly featureId: string | null;
    /** Step to decide. */
    readonly stepId: string | null;
    /** Bound head. */
    readonly head: string | null;
    /** Agent question, for questions. */
    readonly questionId: string | null;
    /** Offered answers. */
    readonly choices: readonly string[];
    /** Whether a written answer is accepted. */
    readonly allowText: boolean;
  }
  /** Validated console projection. */
  export interface ConsoleModel {
    /** Deliveries. */
    readonly deliveries: readonly Delivery[];
    /** Objectives. */
    readonly objectives: readonly {
      readonly featureId: string;
      readonly title: string;
      readonly column: Column;
      readonly steps: readonly Step[];
    }[];
    /** Open decisions. */
    readonly open: readonly InboxItem[];
    /** Archived total and the latest restorable deliveries. */
    readonly archived: {
      readonly total: number;
      readonly recent: readonly { readonly taskId: string; readonly issue: number; readonly title: string }[];
    };
    /** Answered decisions. */
    readonly answered: readonly {
      readonly id: string;
      readonly title: string;
      readonly note: string;
      readonly at: number;
    }[];
  }

  /**
   * Read the console projection from a snapshot.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Validated projection.
   */
  export function readConsole(snapshot: unknown): ConsoleModel;

  /**
   * Count decisions waiting on the human.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Open Inbox items.
   */
  export function inboxCount(snapshot: unknown): number;

  /**
   * Describe how long ago something happened.
   *
   * @param since - Event time.
   * @param now - Current time.
   * @returns Relative age text.
   */
  export function relativeAge(since: number, now: number): string;

  /**
   * Shorten a commit id.
   *
   * @param sha - Commit id.
   * @returns Short form.
   */
  export function shortSha(sha: string | null): string;

  /**
   * Bound an error to its leading lines.
   *
   * @param message - Full text.
   * @param lines - Lines kept.
   * @returns Leading lines.
   */
  export function excerpt(message: string, lines?: number): string;

  /**
   * Split a severity tag from a finding.
   *
   * @param finding - Finding text.
   * @returns Severity and remaining text.
   */
  export function findingSeverity(finding: string): { severity: string | null; text: string };

  /**
   * Group steps by execution layer.
   *
   * @param steps - Steps in workflow order.
   * @returns Ascending layers.
   */
  export function layerGroups(steps: readonly Step[]): { layer: number; steps: Step[] }[];

  /**
   * Turn steps into strip segments.
   *
   * @param steps - Steps in workflow order.
   * @returns Segments and caption.
   */
  export function stepStrip(steps: readonly Step[]): {
    segments: { id: string; state: StepState; label: string }[];
    caption: string;
  };

  /**
   * Describe the running step.
   *
   * @param delivery - Card whose live attempt is described.
   * @returns Role and step title, or null.
   */
  export function runningText(delivery: Delivery): string | null;

  /** A running attempt's liveness. */
  export interface Liveness {
    /** `progressing`, `idle`, `awaiting_input`, `stalled` or `ceiling`. */
    readonly state: string;
    /** Newest meaningful signal. */
    readonly lastSignal: string | null;
    /** When it last progressed. */
    readonly lastProgressAt: number;
    /** What it waits on. */
    readonly awaiting: string | null;
    /** Next checkpoint. */
    readonly nextCheckpointAt: number;
    /** Extensions granted. */
    readonly extensions: number;
  }

  /** A failed step's retry backoff. */
  export interface Retry {
    /** Failure class. */
    readonly failureClass: string;
    /** Consecutive failures. */
    readonly failures: number;
    /** When it may run again; null once exhausted. */
    readonly retryAt: number | null;
  }

  /**
   * Describe a running attempt's liveness.
   *
   * @param liveness - Latest record.
   * @param now - Current time.
   * @returns State, signal and next checkpoint.
   */
  export function livenessText(liveness: Liveness, now: number): string;

  /**
   * Describe a failed step's retry backoff.
   *
   * @param retry - Retry state.
   * @param now - Current time.
   * @returns Failures and when it retries, or that retries are exhausted.
   */
  export function retryText(retry: Retry, now: number): string;
}
