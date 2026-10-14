/**
 * Large atomic plans retain genuine prerequisite edges and bounded output.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePlan } from '../src/factory/scheduler.ts';
import { AGENT_OUTPUT_SCHEMA, factoryConfigSchema, resultSchema } from '../src/factory/schema.ts';

await test('a 25-child feature preserves independent slices and real chains without the former 20-child limit', () => {
  const deliveries = Array.from({ length: 25 }, (_, index) => {
    return {
      key: `slice-${index}`,
      title: `Observable delivery ${index}`,
      description: 'One independently verifiable behavior, including its regression checks.',
      acceptanceCriteria: ['This behavior works without enabling unfinished parts of the feature.'],
      dependencies: index === 0 || index % 2 === 0 ? [] : [`slice-${index - 1}`],
    };
  });
  const result = resultSchema.parse({
    outcome: 'success',
    summary: 'Large feature with bounded, separately reviewable deliveries.',
    findings: [],
    deliveries,
  });
  assert.doesNotThrow(() => {
    validatePlan(result);
  });
  assert.equal(result.deliveries.length, 25);
  assert.deepEqual(result.deliveries[2]?.dependencies, []);
  assert.deepEqual(result.deliveries[3]?.dependencies, ['slice-2']);
  assert.throws(() => {
    validatePlan(resultSchema.parse({ ...result, deliveries: [deliveries[1]] }));
  }, /unknown scope/v);
  assert.throws(() => {
    validatePlan(
      resultSchema.parse({
        ...result,
        deliveries: [{ ...deliveries[0], dependencies: ['slice-1'] }, deliveries[1]],
      }),
    );
  }, /cycle/v);
  assert.equal(
    resultSchema.safeParse({ ...result, deliveries: Array.from({ length: 101 }, () => deliveries[0]) }).success,
    false,
  );
  assert.equal(AGENT_OUTPUT_SCHEMA.properties.deliveries.maxItems, 100);
});

await test('new projects enforce a 500-line ceiling while explicit existing project limits are preserved', () => {
  const config = {
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  };
  assert.equal(factoryConfigSchema.parse(config).maxDiffLines, 500);
  assert.equal(factoryConfigSchema.parse({ ...config, maxDiffLines: 700 }).maxDiffLines, 700);
});
