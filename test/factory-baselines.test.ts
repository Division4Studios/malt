/**
 * Real project-library upgrades fence ownership and retain previous guidance.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BASELINE_NAMES } from '../src/factory/baselines.ts';
import { baselineSkill, installFactorySkills } from '../src/factory/skills.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('managed baseline upgrades retain old revisions and refuse to overwrite local edits', (t) => {
  const mesh = createProject(createCleanup(t));
  const bundle = path.join(mesh.root, 'fixture-bundle');
  for (const name of BASELINE_NAMES) {
    const file = path.join(bundle, name, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed baseline names under the disposable fixture project.
    mkdirSync(path.dirname(file), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture bundle file, not real distribution sources.
    writeFileSync(file, `Original ${name}`);
  }
  installFactorySkills(mesh, bundle);
  const original = baselineSkill(mesh, 'factory-development');
  assert.equal(original, 'Original factory-development');
  const upstream = path.join(bundle, 'factory-development', 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Modify only the disposable source bundle to model a software upgrade.
  writeFileSync(upstream, 'Updated development guidance');
  installFactorySkills(mesh, bundle);
  assert.equal(baselineSkill(mesh, 'factory-development'), 'Updated development guidance');
  const hash = createHash('sha256').update(original).digest('hex');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the known previous revision inside this fixture's private library.
  const archived = readFileSync(
    path.join(mesh.directory, 'skills', 'builtin-history', hash, 'factory-development', 'SKILL.md'),
    'utf8',
  );
  assert.equal(archived, original);
  const customized = path.join(mesh.directory, 'skills', 'builtin', 'factory-development', 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Simulate an operator edit in this disposable project's installed baseline.
  writeFileSync(customized, 'Operator-owned local instructions');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture upgrade content only.
  writeFileSync(upstream, 'Another upstream revision');
  installFactorySkills(mesh, bundle);
  installFactorySkills(mesh, bundle);
  assert.equal(baselineSkill(mesh, 'factory-development'), 'Operator-owned local instructions');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed project-local index contains explicit conflict information.
  const index = readFileSync(path.join(mesh.directory, 'skills', 'builtin-index.json'), 'utf8');
  assert.match(index, /"conflicts": \[\s*"factory-development"/v);
});
