/** @file Broker-side preflight and the console's preflight and version routes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { preflight, preflightReportSchema } from '../src/factory/preflight.ts';
import { startWebConsole } from '../src/web/server.ts';

import { policySettings } from './fixtures/model-policy.ts';
import { brokerUrl, createCleanup, createProject } from './helpers.ts';

import type { DoctorProbes } from '../src/doctor.ts';

/**
 * Probes where only Git and the configured Claude executable answer.
 *
 * @param seen - Receives every executable that was run.
 * @returns Injected probes.
 */
function probes(seen: string[]): Partial<DoctorProbes> {
  return {
    run: async (file, args) => {
      await Promise.resolve();
      seen.push(file);
      if (file === 'git') {
        return { stdout: 'git version 2.47.0', stderr: '' };
      }
      if (file === '/opt/claude' && args[0] === '--version') {
        return { stdout: '2.1.0', stderr: '' };
      }
      if (file === '/opt/claude') {
        return {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
          stderr: '',
        };
      }
      throw new Error(`spawn ${file} ENOENT`);
    },
  };
}

await test('the broker-side preflight skips ports and checks the configured executables', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = {
    ...policySettings,
    providers: {
      claude: { ...policySettings.providers.claude, executable: '/opt/claude' },
      codex: { ...policySettings.providers.codex, executable: '/opt/codex' },
    },
  };
  const seen: string[] = [];
  const report = await preflight(settings, mesh, probes(seen));
  assert.ok(seen.includes('/opt/claude') && seen.includes('/opt/codex'));
  assert.ok(!seen.includes('claude'), 'Configured executables replace the default names.');
  assert.ok(report.checks.every((item) => !item.id.endsWith('-port')));
  assert.equal(report.checks.find((item) => item.id === 'claude')?.status, 'pass');
  assert.equal(report.checks.find((item) => item.id === 'codex')?.status, 'fix-it');
  assert.equal(report.checks.find((item) => item.id === 'writable')?.status, 'pass');
  assert.ok(report.ok);
  assert.ok(preflightReportSchema.safeParse(report).success);
});

await test('operators read the preflight through the broker and the paired console, with versions', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const connected = { ...mesh, url: brokerUrl(broker.port) };
  const direct = preflightReportSchema.parse(await rpc(connected, 'factory_preflight', {}));
  assert.ok(direct.checks.some((item) => item.id === 'git'));
  assert.ok(direct.checks.every((item) => item.status === 'pass' || item.fix !== null));

  const web = await startWebConsole(connected, 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  const headers = {
    Origin: web.url,
    Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    Connection: 'close',
  };
  const routed = await fetch(`${web.url}/api/preflight?project=home`, { headers });
  assert.equal(routed.status, 200);
  assert.ok(preflightReportSchema.safeParse(await routed.json()).success);
  const versions = await fetch(`${web.url}/api/version?project=home`, { headers });
  assert.equal(versions.status, 200);
  const body: unknown = await versions.json();
  assert.ok(typeof body === 'object' && body !== null && 'broker' in body && 'malt' in body);
  assert.equal(body.broker, '0.1.0');
  assert.match(String(body.malt), /^\d+\.\d+\.\d+/v);
  const unpaired = await fetch(`${web.url}/api/preflight?project=home`, { headers: { Origin: web.url } });
  assert.equal(unpaired.status, 401);
});
