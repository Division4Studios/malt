/** @file Shared synthetic model policy and taskless intent; never provider recommendations. */
import { factoryConfigSchema } from '../../src/factory/schema.ts';

import type { JobIntent } from '../../src/factory/scheduler.ts';
/** Model names and support evidence are synthetic account-local fixtures. */
export const policySettings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath, args: ['--version'] }],
  endToEndCommands: [{ file: process.execPath, args: ['--version'] }],
  providers: { codex: { executable: 'fixture' }, claude: { executable: 'fixture' } },
  modelPolicy: {
    revision: 1,
    entries: ['codex', 'claude'].map((provider) => {
      return {
        id: provider,
        provider,
        model: `fixture-${provider}`,
        capability: provider === 'codex' ? 'small' : 'advanced',
        effortSupport: provider === 'codex' ? 'codex-config' : 'claude-effort',
        efforts: ['low', 'medium', 'high'],
        evidence: { version: 'fixture-1', source: 'Fixture model capability evidence', observedAt: 1000 },
      };
    }),
    defaults: [
      { provider: 'codex', tier: 'small', entryId: 'codex', effort: 'low' },
      ...['small', 'standard', 'advanced'].map((tier) => {
        return {
          provider: 'claude',
          tier,
          entryId: 'claude',
          effort: 'low',
        };
      }),
    ],
  },
});
/** Taskless roles must resolve policy too, including planning and learning. */
export const policyIntent: JobIntent = {
  role: 'product-owner',
  kind: 'plan',
  taskId: null,
  featureId: null,
  head: null,
  base: null,
};
