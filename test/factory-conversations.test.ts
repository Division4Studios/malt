/**
 * Operator conversation previews are actual scoped messages, redacted without acknowledging inboxes.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { run } from '../src/database.ts';
import { FactoryRepository } from '../src/factory/repository.ts';

import { createCleanup, createProject, brokerUrl } from './helpers.ts';

/** Minimal safe public conversation DTO. */
const message = z.object({
  body: z.string(),
  sender_name: z.string(),
  recipient_name: z.string(),
  acknowledged_at: z.number().nullable(),
});
/** Additive public handoff projection, validated through actual broker RPC. */
const handoff = z.object({
  kind: z.enum(['manager_report', 'peer_message']),
  sender: z.string().nullable(),
  recipient: z.string(),
  hasOriginEvidence: z.boolean(),
  body: z.string(),
  verifiedDelivery: z.literal(false),
});
const state = z.object({ conversations: z.array(message), handoffs: z.array(handoff) });

await test('actual peer conversations remain durable and inspection never acknowledges a worker inbox', async (t) => {
  const defer = createCleanup(t);
  const project = createProject(defer);
  const broker = await startBroker(project, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...project, url: brokerUrl(broker.port) };
  const development = new AgentClient(mesh, {
    name: 'factory-developer-1',
    role: 'developer-1',
    runtime: 'factory-managed',
  });
  const qa = new AgentClient(mesh, { name: 'factory-qa-1', role: 'qa-1', runtime: 'factory-managed' });
  await development.connect();
  await qa.connect();
  defer(async () => development.close());
  defer(async () => qa.close());
  await qa.call('send_message', {
    to: 'factory-developer-1',
    body: `<script>hostile()</script> Reproduce this defect; never publish ${mesh.token}.`,
  });
  const repository = new FactoryRepository(broker.store);
  const instruction = repository.instruct('team-lead', null, 'A retained legacy manager report.');
  run(broker.store.db, 'INSERT INTO factory_handoffs VALUES(?,?,?)', instruction, randomUUID(), '{}');
  const observed = state.parse(await rpc(mesh, 'factory_status', {}));
  const report = observed.handoffs.find((entry) => entry.kind === 'manager_report');
  assert.ok(report !== undefined);
  assert.equal(report.sender, null);
  assert.equal(report.recipient, 'team-lead');
  assert.equal(report.hasOriginEvidence, false);
  assert.ok(observed.handoffs.some((entry) => entry.kind === 'peer_message' && entry.sender === 'factory-qa-1'));
  assert.ok(!JSON.stringify(observed.handoffs).includes(mesh.token));
  const latest = observed.conversations.at(-1);
  assert.ok(latest !== undefined);
  assert.equal(latest.sender_name, 'factory-qa-1');
  assert.equal(latest.recipient_name, 'factory-developer-1');
  assert.match(latest.body, /<script>hostile\(\)<\/script>/v);
  assert.ok(!latest.body.includes(mesh.token));
  assert.match(latest.body, /\[REDACTED\]/v);
  assert.equal(latest.acknowledged_at, null);
  assert.equal((await development.call('get_messages', {})).messages[0]?.acknowledged_at, null);
});
