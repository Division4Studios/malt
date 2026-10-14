/**
 * Explicitly invoked bounded native subscription smoke; never part of scheduler tests.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { startBroker } from '../src/broker.ts';
import { loadConfig, saveBrokerDiscovery } from '../src/config.ts';
import { providerPreflight } from '../src/factory/authentication.ts';
import { runProcess } from '../src/factory/processes.ts';
import { runAgent } from '../src/factory/providers.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { writeAtomic } from '../src/summary.ts';

import type { MeshConfig } from '../src/config.ts';
import type { Provider } from '../src/factory/schema.ts';

/** Deliberately short native test deadline. */
const SMOKE_TIMEOUT_MS = 60_000;

/**
 * Require an explicit provider selection because this test consumes subscription usage.
 *
 * @param value - CLI provider option.
 * @returns Supported native provider family.
 * @throws {Error} For an omitted or unsupported choice.
 */
function providerChoice(value: string | undefined): Provider {
  if (value !== 'codex' && value !== 'claude') {
    throw new Error('Select --provider codex or --provider claude. This bounded test uses that subscription.');
  }
  return value;
}

/**
 * Test one real CLI interface without GitHub mutations, tools or delivery work.
 *
 * @throws {Error} When subscription readiness or structured execution fails.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { provider: { type: 'string' }, executable: { type: 'string' }, model: { type: 'string' } },
  });
  const provider = providerChoice(values.provider);
  const root = path.join(process.cwd(), '.malt', 'validation', `subscription-${provider}-${randomUUID()}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- All smoke state remains in this source project's ignored validation directory.
  await mkdir(root, { recursive: true });
  const initial = loadConfig(root, { create: true });
  const broker = await startBroker(initial, { port: 0 });
  try {
    const mesh = { ...initial, url: `http://127.0.0.1:${String(broker.port)}` };
    saveBrokerDiscovery(mesh);
    await exerciseNative(mesh, { provider, executable: values.executable, model: values.model });
  } finally {
    await broker.close();
  }
}

/**
 * Execute the explicit smoke against one authenticated native provider.
 *
 * @param mesh - Isolated broker/project scope.
 * @param values - Explicit provider, executable and optional model selection.
 * @throws {Error} When readiness or structured native execution fails.
 */
async function exerciseNative(
  mesh: MeshConfig,
  values: { provider: Provider; executable: string | undefined; model: string | undefined },
): Promise<void> {
  const { provider } = values;
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath, args: ['--version'] }],
    endToEndCommands: [{ file: process.execPath, args: ['--version'] }],
    jobTimeoutMs: SMOKE_TIMEOUT_MS,
    providers: {
      codex: {
        enabled: provider === 'codex',
        executable: provider === 'codex' ? (values.executable ?? 'codex') : 'codex',
        ...(values.model !== undefined && { model: values.model }),
      },
      claude: {
        enabled: provider === 'claude',
        executable: provider === 'claude' ? (values.executable ?? 'claude') : 'claude',
        ...(values.model !== undefined && { model: values.model }),
      },
    },
  });
  const readiness = await providerPreflight(settings, mesh.root);
  const artifact = path.join(mesh.directory, 'factory', 'jobs', randomUUID());
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The bounded test owns this private artifact directory.
  await mkdir(artifact, { recursive: true });
  const startedAt = Date.now();
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'product-owner',
    provider,
    kind: 'plan',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt,
    finishedAt: null,
    expiresAt: startedAt + SMOKE_TIMEOUT_MS,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact,
  });
  const controller = new AbortController();
  const completion = await runAgent(
    {
      job,
      mesh,
      home: mesh.root,
      settings,
      cwd: mesh.root,
      prompt:
        'This is a bounded native subscription interface smoke, not a delivery assignment. Do not call tools, modify files, access GitHub, or continue working. Return only the required structured object: outcome success; summary "Native subscription smoke completed."; findings, deliveries, skillActions and instructionReceipts all empty arrays.',
      signal: controller.signal,
      onSpawn: () => {
        /* The owned process runner retains and cleans its handles. */
      },
    },
    runProcess,
  );
  writeAtomic(
    path.join(artifact, 'smoke-result.json'),
    `${JSON.stringify({ readiness, completion, finishedAt: Date.now() }, null, 2)}\n`,
  );
  if (completion.result?.outcome !== 'success') {
    throw new Error(
      `Native ${provider} did not return a valid bounded result. Inspect ${artifact}; no GitHub work was performed.`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ provider, readiness, usageTokens: completion.usageTokens, artifact, result: 'PASS', boundary: 'real native subscription CLI only; no live delivery or GitHub mutation' })}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${Error.isError(error) ? error.message : 'Native subscription smoke failed.'}\n`);
  process.exitCode = 1;
}
