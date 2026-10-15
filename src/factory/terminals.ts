/** @file Operator-only scratch terminals sharing broker-wide native resource admission. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod/v3';

import { log } from '../log.ts';
import { MeshError } from '../protocol.ts';

import { brokerAdmission } from './admission.ts';
import { providerPreflight } from './authentication.ts';
import { resourceBlocker, resourceProbe } from './resources.ts';
import { providerBlockers } from './scheduler.ts';
import { TerminalBuffer } from './terminal-buffer.ts';
import { MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS } from './terminal-frames.ts';
import { terminalLaunchSchema, terminalMcpServers } from './terminal-launch.ts';
import { TerminalLifetime, terminalClock } from './terminal-lifetime.ts';
import { startTerminalProcess } from './terminal-process.ts';
import { WorkspaceManager } from './workspaces.ts';

import type { MeshConfig } from '../config.ts';
import type { AdmissionPool } from './admission.ts';
import type { FactoryRepository } from './repository.ts';
import type { ResourceProbe } from './resources.ts';
import type { FactoryConfig, Provider } from './schema.ts';
import type { Frame } from './terminal-frames.ts';
import type { TerminalClock, TerminalTimeout } from './terminal-lifetime.ts';
import type { TerminalProcess } from './terminal-process.ts';
import type { TerminalSession } from './terminal-sessions.ts';

/** Output content is transient and byte-bounded, not persisted. */
const OUTPUT_BYTES = 262_144;
/** Keep edited scratch work available for inspection without unbounded worktree growth. */
const RETAINED_TREES = 3;
/** Only these inputs are accepted from an authorized operator. */
export const terminalStartSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    columns: z.number().int().min(MIN_COLUMNS).max(MAX_COLUMNS),
    rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
  })
  .strict();
/** Injectable native boundaries; fixtures never invoke paid providers. */
export interface TerminalOptions {
  /** Unpaid MCP name inspection; substitute explicitly in fixture tests. */
  readonly inspectMcp?: typeof terminalMcpServers;
  /** Timer substitution for deterministic timeout verification. */
  readonly clock?: TerminalClock;
  /** Broker-wide pool shared with managed assignments. */
  readonly pool?: AdmissionPool;
  /** Cached or sampled machine resources. */
  readonly resources?: ResourceProbe;
  /** Native host runner; fixture substitution is available only to in-process tests. */
  readonly spawn?: typeof startTerminalProcess;
  /** Unpaid subscription authentication preflight. */
  readonly preflight?: (settings: FactoryConfig, provider: Provider, cwd: string) => Promise<void>;
}
/** In-memory execution state; no terminal content is durable. */
interface LiveTerminal {
  /** Idle/absolute timers, disposed before process teardown. */
  readonly lifetime: TerminalLifetime;
  /** First requested terminal outcome survives late native results. */
  outcome: 'exited' | 'cancelled' | 'timed_out' | null;
  /** Owned process and descendant cleanup. */
  readonly process: TerminalProcess;
  /** Bounded, redacted transient replay. */
  readonly buffer: TerminalBuffer;
  /** Observed byte counters checkpointed at exit. */
  outputBytes: number;
  /** Actual CLI exit status, when reported. */
  exitCode: number | null;
  /** Fixed diagnostic category. */
  reason: string;
}

/**
 * Verify only the explicitly selected provider without any inference turn.
 *
 * @param settings - Verified native provider configuration.
 * @param provider - Operator selection.
 * @param cwd - Project root.
 */
async function preflight(settings: FactoryConfig, provider: Provider, cwd: string): Promise<void> {
  const selected = structuredClone(settings);
  selected.providers[provider === 'codex' ? 'claude' : 'codex'].enabled = false;
  await providerPreflight(selected, cwd);
}

/** A single broker-owned service, never an MCP tool or assignment result consumer. */
export class TerminalService {
  /** Runtime handles exist only for explicitly requested sessions. */
  private readonly live = new Map<string, LiveTerminal>();
  /** Reservations cover unpaid asynchronous preparation too. */
  private readonly preparing = new Map<string, PromiseWithResolvers<undefined>>();
  /** Fences asynchronous preflight/worktree results after pause or shutdown. */
  private generation = 0;
  /** Broker shutdown permanently closes this service instance. */
  private isStopped = false;
  /** Starts cannot race an in-progress pause/shutdown. */
  private isClosing = false;
  /** Verified project root and private state. */
  private readonly mesh: MeshConfig;
  /** Metadata ledger owner. */
  private readonly repository: FactoryRepository;
  /** Shared resource occupancy. */
  private readonly pool: AdmissionPool;
  /** Injectable native boundary functions. */
  private readonly options: Required<Omit<TerminalOptions, 'pool'>>;

  /**
   * Construct without starting a host, provider, shell or timer.
   *
   * @param mesh - Selected project.
   * @param repository - Its durable factory ledger.
   * @param options - Native adapters or deterministic fixture substitutes.
   */
  public constructor(mesh: MeshConfig, repository: FactoryRepository, options: TerminalOptions = {}) {
    this.mesh = mesh;
    this.repository = repository;
    this.pool = options.pool ?? brokerAdmission;
    this.options = {
      resources: options.resources ?? resourceProbe(),
      spawn: options.spawn ?? startTerminalProcess,
      preflight: options.preflight ?? preflight,
      clock: options.clock ?? terminalClock,
      inspectMcp: options.inspectMcp ?? terminalMcpServers,
    };
  }

  /**
   * Logical occupancy includes unpaid preparation; reading it starts nothing.
   *
   * @returns Number of live/preparing sessions.
   */
  public get size(): number {
    return this.live.size + this.preparing.size;
  }

  /**
   * Admit and start a new operator-requested scratch session.
   *
   * @param input - Provider and initial size, never a launch descriptor.
   * @returns Persisted starting metadata; running follows the native PID frame.
   * @throws {MeshError} For setup, admission or retention refusal.
   */
  public async start(input: z.input<typeof terminalStartSchema>): Promise<TerminalSession> {
    const { generation } = this;
    this.assertCurrent(generation);
    const request = terminalStartSchema.parse(input);
    const settings = this.repository.config();
    if (settings === null) {
      throw new MeshError('FACTORY_GATED', 'Configure the selected project first.');
    }
    terminalLaunchSchema.parse({
      ...request,
      file: settings.providers[request.provider].executable,
      cwd: this.mesh.root,
    });
    if (this.live.size + this.preparing.size >= settings.terminals.max) {
      throw new MeshError('FACTORY_GATED', 'Terminal session cap reached or terminals disabled.');
    }
    const policy = this.pool.policy(settings);
    const resource = resourceBlocker(policy, this.options.resources(), this.pool.size);
    const capacities = this.pool.capacities(
      ['codex', 'claude'].map((name) => this.repository.capacity(name === 'codex' ? 'codex' : 'claude', settings)),
      this.repository.store.now(),
    );
    const provider = providerBlockers({
      config: policy,
      capacities,
      jobs: this.pool.jobs(),
      now: this.repository.store.now(),
    })[request.provider];
    if (resource !== null || provider !== null) {
      throw new MeshError('FACTORY_GATED', resource ?? `Provider admission refused: ${provider ?? 'unavailable'}.`);
    }
    const id = randomUUID();
    const completion = Promise.withResolvers<undefined>();
    this.preparing.set(id, completion);
    this.pool.add({ id, provider: request.provider, state: 'running' }, settings);
    try {
      await this.options.preflight(settings, request.provider, this.mesh.root);
      this.assertCurrent(generation);
      const workspaces = new WorkspaceManager(this.mesh, settings);
      await workspaces.origin();
      await this.prune(workspaces);
      const base = await workspaces.base();
      const branch = `malt/terminal/${id}`;
      const worktree = await workspaces.create(`terminal-${id}`, base, branch, false);
      const mcpServers =
        request.provider === 'codex'
          ? await this.options.inspectMcp(settings.providers.codex.executable, worktree)
          : [];
      this.assertCurrent(generation);
      const session = this.repository.terminals.create({
        ...request,
        id,
        worktree,
        branch,
        base,
        baseBranch: settings.baseBranch,
      });
      this.repository.terminals.change(id, 'requested', 'starting');
      const buffer = new TerminalBuffer(OUTPUT_BYTES, process.env, [this.mesh.token]);
      const native = this.options.spawn({
        launch: { ...request, file: settings.providers[request.provider].executable, cwd: worktree, mcpServers },
        artifact: path.join(this.mesh.directory, 'terminals', id),
        memoryMb: settings.resources.jobMemoryMb,
        cpuPercent: settings.resources.jobCpuPercent,
        processLimit: settings.resources.jobProcessLimit,
        onFrame: (frame) => {
          this.frame(id, frame);
        },
      });
      const lifetime = new TerminalLifetime(
        settings.terminals,
        (reason) => {
          void this.expire(id, reason);
        },
        this.options.clock,
      );
      this.live.set(id, {
        process: native,
        buffer,
        lifetime,
        outcome: null,
        outputBytes: 0,
        exitCode: null,
        reason: '',
      });
      void this.watch(id, native);
      return this.repository.terminals.get(session.id) ?? session;
    } catch (error) {
      const session = this.repository.terminals.get(id);
      if (session?.state === 'starting') {
        this.repository.terminals.change(id, 'starting', 'failed', { reason: 'terminal preparation failed' });
      }
      this.pool.delete(id);
      throw error;
    } finally {
      this.preparing.delete(id);
      completion.resolve(undefined);
    }
  }

  /**
   * Close exactly one owned session; already-closed sessions are idempotent.
   *
   * @param id - Project-fenced session identity.
   * @param outcome - First operator/deadline cause, fenced against late native exits.
   * @param reason - Fixed diagnostic category, never terminal content.
   * @returns Final metadata after descendant cleanup.
   * @throws {MeshError} For an unknown or unowned live session.
   */
  public async close(
    id: string,
    outcome: 'exited' | 'cancelled' | 'timed_out' = 'exited',
    reason = 'operator closed',
  ): Promise<TerminalSession> {
    const session = this.repository.terminals.get(id);
    if (session === null) {
      throw new MeshError('NOT_FOUND', 'Terminal session not found in this project.');
    }
    const live = this.live.get(id);
    if (live === undefined) {
      return session;
    }
    if (session.state === 'starting' || session.state === 'running') {
      this.repository.terminals.change(id, session.state, 'closing');
      live.reason = reason;
      live.outcome = outcome;
    }
    live.lifetime.close();
    await live.process.stop();
    return this.repository.terminals.get(id) ?? session;
  }

  /**
   * Retain content in memory for authorized replay only.
   *
   * @param id - Project session identity.
   * @returns Transient buffer while the session is live.
   */
  public buffer(id: string): TerminalBuffer | null {
    return this.live.get(id)?.buffer ?? null;
  }

  /**
   * Cancel pending starts and stop all owned terminals before SQLite closes.
   *
   * @param reason - Fixed control category.
   * @param isPermanent - Broker shutdown fences all future starts.
   */
  public async closeAll(reason: string, isPermanent = false): Promise<void> {
    this.generation += 1;
    const { generation } = this;
    this.isClosing = true;
    this.isStopped ||= isPermanent;
    try {
      await Promise.all(this.live.keys().map(async (id) => this.close(id, 'cancelled', reason)));
      await Promise.allSettled(this.preparing.values().map(async (pending) => pending.promise));
    } finally {
      if (this.generation === generation) {
        this.isClosing = false;
      }
    }
  }

  /**
   * Accepted operator input touches idle time; output and resizes do not.
   *
   * @param id - Owned session.
   */
  public touch(id: string): void {
    this.live.get(id)?.lifetime.touch();
  }

  /**
   * Recover old metadata only after the owning supervisor acquires its lease.
   */
  public recover(): void {
    this.repository.terminals.recover(new Set(this.live.keys()));
  }

  /**
   * Fence late preparation after controls invalidate its generation.
   *
   * @param generation - Generation captured before any asynchronous work.
   * @throws {MeshError} When pause/shutdown invalidated this start.
   */
  private assertCurrent(generation: number): void {
    if (this.isStopped || this.isClosing || generation !== this.generation) {
      throw new MeshError('FACTORY_GATED', 'Terminal preparation was cancelled by operator control.');
    }
  }

  /**
   * Deadline failures are classified without logging terminal text.
   *
   * @param id - Owned session.
   * @param reason - First deadline category.
   */
  private async expire(id: string, reason: TerminalTimeout): Promise<void> {
    try {
      await this.close(id, 'timed_out', reason);
    } catch {
      log('warn', 'factory', 'terminal_timeout_failed');
    }
  }

  /**
   * Apply a validated host frame without importing it into delivery evidence.
   *
   * @param id - Owned runtime identity.
   * @param frame - Native protocol frame.
   */
  private frame(id: string, frame: Frame): void {
    const live = this.live.get(id);
    const session = this.repository.terminals.get(id);
    if (live === undefined || session === null) {
      return;
    }
    switch (frame.type) {
      case 'started': {
        if (session.state === 'starting') {
          this.repository.terminals.change(id, 'starting', 'running');
        }
        break;
      }
      case 'data': {
        live.outputBytes += frame.data.byteLength;
        live.buffer.write(frame.data);
        break;
      }
      case 'exit': {
        live.exitCode = frame.code;
        break;
      }
      case 'error': {
        live.reason = 'terminal host failed';
        void live.process.stop();
        break;
      }
      case 'input':
      case 'resize':
      case 'close': {
        live.reason = 'terminal protocol failed';
        void live.process.stop();
        break;
      }
    }
  }

  /**
   * Observe native cleanup without unhandled completion rejections.
   *
   * @param id - Owned session.
   * @param native - Contained process.
   */
  private async watch(id: string, native: TerminalProcess): Promise<void> {
    await native.closed;
    try {
      this.finish(id);
    } catch {
      log('warn', 'factory', 'terminal_checkpoint_failed');
    } finally {
      this.live.delete(id);
      this.pool.delete(id);
    }
  }

  /**
   * Checkpoint counters and release occupancy only after native cleanup.
   *
   * @param id - Owned runtime identity.
   */
  private finish(id: string): void {
    const live = this.live.get(id);
    const session = this.repository.terminals.get(id);
    if (live === undefined || session === null) {
      return;
    }
    live.buffer.finish();
    live.lifetime.close();
    const next = live.outcome ?? (live.exitCode === 0 ? 'exited' : 'failed');
    this.repository.terminals.change(id, session.state, next, {
      exitCode: live.exitCode,
      reason: live.reason === '' ? 'provider exited' : live.reason,
      outputBytes: live.outputBytes,
    });
  }

  /**
   * Preserve dirty/newer work, prune only clean owned scratch trees.
   *
   * @param workspaces - Selected repository's ownership manager.
   * @throws {MeshError} When every retained tree contains user edits.
   */
  private async prune(workspaces: WorkspaceManager): Promise<void> {
    const retained = workspaces.terminalTrees();
    if (retained.length < RETAINED_TREES) {
      return;
    }
    for (const record of retained) {
      if (this.live.has(record.id.slice('terminal-'.length))) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- Retire one oldest owned clean tree; never race destructive Git operations.
      const snapshot = await workspaces.snapshot(record.directory);
      if (snapshot.status !== '') {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- Archive source before removing the same verified owned tree.
      await workspaces.git(['update-ref', `refs/malt/archive/terminal-${record.id}`, snapshot.head]);
      // eslint-disable-next-line no-await-in-loop -- Removal rechecks the tree's actual status and ownership.
      if (await workspaces.remove(record.directory)) {
        return;
      }
    }
    throw new MeshError(
      'FACTORY_GATED',
      'Retained terminal worktrees contain edits; inspect them before starting another session.',
    );
  }
}
