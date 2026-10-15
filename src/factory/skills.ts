/**
 * Pinned lifecycle baseline installed project-locally and loaded per assignment.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { writeAtomic } from '../summary.ts';

import { refreshBaselines } from './baselines.ts';

import type { MeshConfig } from '../config.ts';
import type { ProjectLearning } from '../learning.ts';
import type { FactoryJob } from './schema.ts';

/** Source-distribution bundle independent of target cwd. */
const BUNDLE = path.resolve(import.meta.dirname, '..', '..', 'resources', 'factory-skills');
/** Role routing avoids loading unrelated skill instructions. */
const ROUTES = {
  plan: 'factory-product',
  refine: 'factory-product',
  develop: 'factory-development',
  review: 'factory-review',
  final: 'factory-release',
  verify: 'factory-release',
  learn: 'factory-learning',
  skill: 'factory-learning',
  triage: 'factory-product',
} as const;
/** Active review provenance must be validated before becoming instructions. */
const SKILL_TEXT_MAX = 32_000;
/** Active instruction envelope. */
const activeSkillSchema = z.object({
  name: z.string(),
  revision: z.string().regex(/^[\da-f]{64}$/v),
  state: z.literal('active'),
  skill: z.string().max(SKILL_TEXT_MAX),
});

/**
 * Install the reviewed immutable baseline and preserve project-custom skill files.
 *
 * @param mesh - Target project scope.
 * @param bundle - Reviewed distribution folder; substitutions are fixture-only.
 */
export function installFactorySkills(mesh: MeshConfig, bundle = BUNDLE): void {
  const target = path.join(mesh.directory, 'skills', 'builtin');
  const receipts = refreshBaselines(mesh, bundle);

  // eslint-disable-next-line n/no-sync -- Bootstrap installs the bounded local baseline before any assignment or scheduler turn can read it.
  cpSync(bundle, target, { recursive: true, force: false, errorOnExist: false });
  writeAtomic(
    path.join(mesh.directory, 'skills', 'builtin-index.json'),
    `${JSON.stringify({ version: 2, directory: 'builtin', shared: 'factory-session', assignments: ROUTES, ...receipts }, null, 2)}\n`,
  );
}

/**
 * Load only shared lifecycle and the assigned stage, not entire upstream snapshots.
 *
 * @param mesh - Target workspace.
 * @param kind - Bounded job stage.
 * @returns Tailored runtime skill instructions.
 */
export function assignmentSkills(mesh: MeshConfig, kind: FactoryJob['kind']): string {
  return ['factory-session', ROUTES[kind]].map((name) => baselineSkill(mesh, name)).join('\n\n');
}

/**
 * Read an allowlisted baseline for comparison with a proposed override.
 *
 * @param mesh - Selected project's installed baseline.
 * @param name - Fixed bundled skill name.
 * @returns Installed instructions, absent for custom skills.
 */
export function baselineSkill(mesh: MeshConfig, name: string): string | null {
  const names = new Set<string>(['factory-session', ...Object.values(ROUTES)]);
  return names.has(name)
    ? // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed baseline names are allowlisted above and resolved within the selected project.
      readFileSync(path.join(mesh.directory, 'skills', 'builtin', name, 'SKILL.md'), 'utf8')
    : null;
}

/**
 * Deliver only routed, independently adopted project skills to either provider.
 *
 * @param context - Project library and the durable pre-launch decision.
 * @returns Bounded instructions and exact revision evidence.
 */
export async function routedSkills(context: {
  mesh: MeshConfig;
  learning: ProjectLearning;
  job: FactoryJob;
}): Promise<{ content: string; revisions: { name: string; revision: string }[] }> {
  const names = context.job.routing?.skillNames ?? ['factory-session', ROUTES[context.job.kind]];
  const library = context.learning.skillLibrary();
  const loaded = await Promise.all(
    names.map(async (name) => {
      const override = library.find((entry) => entry.name === name);
      if (override?.state === 'archived') {
        return null;
      }
      if (override === undefined) {
        const skill = baselineSkill(context.mesh, name);
        if (skill !== null) {
          return { name, revision: createHash('sha256').update(skill).digest('hex'), skill };
        }
      }
      return activeSkillSchema.parse(
        await context.learning.execute('learning_read_skill', { name }, `factory-${context.job.role}`),
      );
    }),
  );
  const selected = loaded.filter((entry) => entry !== null);
  return {
    content: selected.map((skill) => skill.skill).join('\n\n'),
    revisions: selected.map((skill) => ({ name: skill.name, revision: skill.revision })),
  };
}
