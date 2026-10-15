/**
 * Operator explanations retain the distinction between tooling and code defects.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod/v3';

/** Compiled browser module, checked without installing browser dependencies. */
const moduleUrl = new URL(['..', 'web', 'dist', 'brand-ui.js'].join('/'), import.meta.url);
/** Runtime contract for native browser summary text. */
const summaryFunction = z.function().args(z.record(z.unknown())).returns(z.array(z.string()));
/** Runtime contract for the compiled module. */
const summaries = z
  .object({
    dispatchSummary: summaryFunction,
  })
  .parse(await import(moduleUrl.href));

await test('source-access blockers explain the harness problem instead of cutting a QA report mid-sentence', () => {
  const messages = summaries.dispatchSummary({
    active: true,
    tasks: [
      {
        issue: 13,
        phase: 'blocked',
        error: `QA-2: essential source remains inaccessible.\ntruncated:true ${'technical evidence '.repeat(100)}`,
      },
    ],
  });
  assert.ok(messages.some((message) => message.includes('not a confirmed code defect')));
  assert.ok(messages.some((message) => message.includes('rerun independent QA on the same commits')));
});
