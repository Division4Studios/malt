/**
 * Durable instruction dispatch and explicit agent receipts, separate from task authority.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { handoffSchema } from './handoffs.ts';

import type { Store } from '../store.ts';
import type { FactoryJob, AgentResult } from './schema.ts';

/** Focused instruction context, with durable identities for explicit receipts. */
const guidanceSchema = z.object({ id: z.string().uuid(), body: z.string(), createdAt: z.number() });
/** Timeline metadata does not infer a model acknowledgement from process start. */
const stateSchema = guidanceSchema.extend({
  role: z.string(),
  taskId: z.string().nullable(),
  deliveredAt: z.number().nullable(),
  acknowledgedAt: z.number().nullable(),
  appliedAt: z.number().nullable(),
  evidence: z.string().nullable(),
  jobId: z.string().nullable(),
  handoff: z.string().nullable(),
});
/** One instruction actually selected for an assignment. */
export type Instruction = z.output<typeof guidanceSchema>;

/**
 * Decode stored reporting provenance without inferring any from instruction prose.
 *
 * @param data - Stored JSON, absent for legacy and operator instructions.
 * @returns Validated provenance, or null when absent or unreadable.
 */
function parseHandoff(data: string | null): z.output<typeof handoffSchema> | null {
  if (data === null) {
    return null;
  }
  try {
    const parsed = handoffSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Project-local receipts survive provider replacement and broker restart. */
export class InstructionLedger {
  /** Sole project SQLite/transaction boundary. */
  private readonly store: Store;

  /**
   * Add receipts alongside existing user instruction history without rewriting it.
   *
   * @param store - Selected project's durable store.
   */
  public constructor(store: Store) {
    this.store = store;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS factory_instruction_scopes (instruction_id TEXT PRIMARY KEY REFERENCES factory_instructions(id), feature_id TEXT NOT NULL REFERENCES factory_features(id))',
    );
    store.db.exec(`CREATE TABLE IF NOT EXISTS factory_instruction_receipts (
      instruction_id TEXT NOT NULL REFERENCES factory_instructions(id), job_id TEXT NOT NULL REFERENCES factory_jobs(id),
      delivered_at INTEGER NOT NULL, acknowledged_at INTEGER, applied_at INTEGER, evidence TEXT,
      PRIMARY KEY(instruction_id,job_id));`);
  }

  /**
   * Bind recovery guidance to its actual objective inside the operator transaction.
   *
   * @param instructionId - Existing durable instruction.
   * @param featureId - Actual target objective.
   */
  public scope(instructionId: string, featureId: string): void {
    run(this.store.db, 'INSERT INTO factory_instruction_scopes VALUES(?,?)', instructionId, featureId);
  }

  /**
   * Select pending guidance first while retaining a small recent context window.
   *
   * @param role - Addressed logical role.
   * @param taskId - Optional current delivery.
   * @param featureId - Current objective; omitted callers see only shared guidance.
   * @returns Up to twenty relevant durable instructions.
   */
  public guidance(role: string, taskId: string | null, featureId: string | null = null): Instruction[] {
    return selectAll(
      this.store.db,
      guidanceSchema,
      `SELECT i.id,i.body,i.created_at AS createdAt
      FROM factory_instructions i LEFT JOIN factory_instruction_scopes s ON s.instruction_id=i.id WHERE i.role=? AND (i.task_id IS NULL OR i.task_id=?) AND (s.feature_id IS NULL OR s.feature_id=?)
      ORDER BY EXISTS(SELECT 1 FROM factory_instruction_receipts r WHERE r.instruction_id=i.id AND r.acknowledged_at IS NOT NULL), i.created_at DESC,i.rowid DESC LIMIT 20`,
      role,
      taskId,
      featureId,
    );
  }

  /**
   * Record inclusion in the actual sealed assignment before invoking its adapter.
   * Delivered means handed to that assignment, not proof that a model read it.
   *
   * @param job - Live, fenced assignment.
   * @param instructions - The exact selected context, not all project history.
   * @throws {MeshError} When dispatch no longer owns its durable claim.
   */
  public deliver(job: FactoryJob, instructions: readonly Instruction[]): void {
    if (instructions.length === 0) {
      return;
    }
    this.store.transaction(() => {
      this.assertClaim(job);
      for (const instruction of instructions) {
        run(
          this.store.db,
          `INSERT OR IGNORE INTO factory_instruction_receipts(instruction_id,job_id,delivered_at)
          SELECT id,?,? FROM factory_instructions WHERE id=? AND role=? AND (task_id IS NULL OR task_id=?) AND NOT EXISTS(SELECT 1 FROM factory_instruction_scopes s WHERE s.instruction_id=id AND s.feature_id IS NOT ?)`,
          job.id,
          this.store.now(),
          instruction.id,
          job.role,
          job.taskId,
          job.featureId,
        );
      }
      this.store.event('FACTORY_INSTRUCTIONS_DELIVERED', null, {
        jobId: job.id,
        role: job.role,
        instructionIds: instructions.map((instruction) => instruction.id),
      });
    });
  }

  /**
   * Validate explicit receipts before they can influence delivery completion.
   *
   * @param job - Current assignment identity.
   * @param receipts - Native structured model response.
   * @throws {MeshError} For unassigned instruction identities or stale claims.
   */
  public validate(job: FactoryJob, receipts: AgentResult['instructionReceipts']): void {
    this.assertClaim(job);
    for (const receipt of receipts) {
      const row = selectOne(
        this.store.db,
        z.object({ id: z.string() }),
        'SELECT instruction_id AS id FROM factory_instruction_receipts WHERE instruction_id=? AND job_id=?',
        receipt.id,
        job.id,
      );
      if (row === undefined) {
        throw new MeshError('FACTORY_GATED', 'The agent reported an instruction outside its sealed assignment.');
      }
    }
  }

  /**
   * Persist explicit acknowledgements and evidence-backed app reports.
   * These are model reports, not independent proof that an operator intent was met.
   *
   * @param job - Still-current assignment.
   * @param result - Validated native outcome and instruction reports.
   * @param canApply - Whether the supervisor accepted this exact stage/source.
   */
  public record(job: FactoryJob, result: AgentResult, canApply: boolean): void {
    if (result.instructionReceipts.length === 0) {
      return;
    }
    this.store.transaction(() => {
      this.validate(job, result.instructionReceipts);
      for (const receipt of result.instructionReceipts) {
        const now = this.store.now();
        const isApplied = canApply && result.outcome === 'success' && receipt.applied;
        run(
          this.store.db,
          `UPDATE factory_instruction_receipts SET acknowledged_at=COALESCE(acknowledged_at,?),
          applied_at=COALESCE(applied_at,?),evidence=? WHERE instruction_id=? AND job_id=?`,
          receipt.acknowledged ? now : null,
          isApplied ? now : null,
          receipt.evidence,
          receipt.id,
          job.id,
        );
        this.store.event('FACTORY_INSTRUCTION_RECEIPT', null, {
          instructionId: receipt.id,
          jobId: job.id,
          role: job.role,
          acknowledged: receipt.acknowledged,
          applied: isApplied,
          evidence: receipt.evidence,
          source: 'explicit agent report after stage validation',
        });
      }
    });
  }

  /**
   * Present bounded instruction history with factual dispatch/report states.
   *
   * @returns The fifty newest instructions, latest receipt evidence and any structured reporting provenance.
   */
  public recent(): unknown[] {
    return selectAll(
      this.store.db,
      stateSchema,
      `SELECT i.id,i.body,i.created_at AS createdAt,i.role,i.task_id AS taskId,
      r.delivered_at AS deliveredAt,r.acknowledged_at AS acknowledgedAt,r.applied_at AS appliedAt,r.evidence,r.job_id AS jobId,
      h.data AS handoff FROM factory_instructions i LEFT JOIN factory_handoffs h ON h.instruction_id=i.id LEFT JOIN factory_instruction_receipts r ON r.rowid=(SELECT rowid FROM factory_instruction_receipts
      WHERE instruction_id=i.id ORDER BY delivered_at DESC,rowid DESC LIMIT 1)
      ORDER BY i.created_at DESC,i.rowid DESC LIMIT 50`,
    ).map((instruction) => {
      let state = 'queued';
      if (instruction.appliedAt !== null) {
        state = 'applied';
      } else if (instruction.acknowledgedAt !== null) {
        state = 'acknowledged';
      } else if (instruction.deliveredAt !== null) {
        state = 'delivered';
      }
      return {
        ...instruction,
        handoff: parseHandoff(instruction.handoff),
        state,
        reportSource: 'agent report; independent delivery gates remain required',
      };
    });
  }

  /**
   * Fence late results independently of their caller transport.
   *
   * @param job - Original process token.
   * @throws {MeshError} When the assignment ended or was replaced.
   */
  private assertClaim(job: FactoryJob): void {
    const current = selectOne(
      this.store.db,
      z.object({ state: z.string(), data: z.string() }),
      'SELECT state,data FROM factory_jobs WHERE id=?',
      job.id,
    );
    const token = current === undefined ? null : z.object({ token: z.string() }).parse(JSON.parse(current.data)).token;
    if (current?.state !== 'running' || token !== job.token) {
      throw new MeshError('FACTORY_GATED', 'The instruction assignment is no longer current.');
    }
  }
}
