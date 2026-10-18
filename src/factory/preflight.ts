/**
 * The doctor checks that mean something inside a running broker, for the
 * console's first-run onboarding. Ports are skipped (the broker and console
 * are already listening), provider checks use the project's configured
 * executables in the broker's own environment where managed jobs will run,
 * and nothing is inferred, created or changed.
 *
 * @file
 */
import { z } from 'zod/v3';

import { runDoctor } from '../doctor.ts';

import type { MeshConfig } from '../config.ts';
import type { DoctorProbes, DoctorReport } from '../doctor.ts';
import type { FactoryConfig } from './schema.ts';

/** One relayed check. */
const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'fail', 'fix-it']),
  detail: z.string(),
  fix: z.string().nullable(),
});
/** Validated preflight report as the web gateway relays it. */
export const preflightReportSchema = z.object({ ok: z.boolean(), checks: z.array(checkSchema) });
/** A relayed preflight report. */
export type PreflightReport = z.output<typeof preflightReportSchema>;

/**
 * Run the broker-side preflight.
 *
 * @param settings - Saved factory policy, whose provider executables are checked; null before setup.
 * @param mesh - Project the broker serves.
 * @param probes - Probe overrides for tests.
 * @returns Pass, fail or fix-it per check.
 */
export async function preflight(
  settings: FactoryConfig | null,
  mesh: MeshConfig,
  probes?: Partial<DoctorProbes>,
): Promise<DoctorReport> {
  return await runDoctor({
    project: mesh.root,
    skipPorts: true,
    ...(settings !== null && {
      executables: {
        claude: settings.providers.claude.executable,
        codex: settings.providers.codex.executable,
        copilot: settings.providers.copilot.executable,
      },
    }),
    ...(probes !== undefined && { probes }),
  });
}
