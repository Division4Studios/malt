/**
 * Shared dependencies for bounded factory execution and completion handlers.
 *
 * @file
 */

import type { MeshConfig } from '../config.ts';
import type { ProjectLearning } from '../learning.ts';
import type { ProcessRunner } from './processes.ts';
import type { AgentCompletion, AgentRunner } from './providers.ts';
import type { DeliveryRemote } from './remote.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryConfig } from './schema.ts';
import type { SourceSnapshot, WorkspaceManager } from './workspaces.ts';

/** Project-specific execution dependencies; never a global app-data context. */
export interface FactoryContext {
  /** Canonical target project. */
  readonly mesh: MeshConfig;
  /** Broker-home discovery configuration. */
  readonly home: string;
  /** Durable ledger. */
  readonly repository: FactoryRepository;
  /** Delivery gates and resource policy. */
  readonly settings: FactoryConfig;
  /** Verified startup versions; fixture mode exists only with an injected in-process agent. */
  readonly providerVersions?: Partial<Record<'codex' | 'claude', string>> | 'fixture';
  /** Target GitHub integration. */
  readonly remote: DeliveryRemote;
  /** Durable project learning. */
  readonly learning: ProjectLearning;
  /** Owned isolated worktrees. */
  readonly workspaces: WorkspaceManager;
  /** Provider process adapter. */
  readonly agent: AgentRunner;
  /** Validation command adapter. */
  readonly processes: ProcessRunner;
}
/** A completed bounded stage, possibly parked on a remote gate without inference. */
export interface ExecutedJob {
  /** Actual model outcome, absent when no model was invoked. */
  readonly completion: AgentCompletion | null;
  /** Owned source snapshot for QA/final stages. */
  readonly snapshot: SourceSnapshot | null;
  /** Executed check evidence supplied to the model. */
  readonly checks: readonly unknown[];
  /** Reason a non-paid gate parked this attempt. */
  readonly waiting: string | null;
}
