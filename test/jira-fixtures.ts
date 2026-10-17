/** @file A stateful fixture Jira site and write context shared by the creation and breakdown tests. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod/v3';

import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { JiraFetch } from '../src/jira/client.ts';
import type { CreationLedger } from '../src/jira/creation.ts';
import type { JiraWriteContext } from '../src/jira/writes.ts';
import type { TestContext } from 'node:test';

/** The project operator. */
export const OPERATOR = { kind: 'human', id: 'project-operator' } as const;

/** The create request body the fixture reads. */
const issueBodySchema = z.object({ fields: z.object({ summary: z.string(), description: z.unknown() }) });

/** A fixture Jira that keeps created issues and can lose responses. */
export interface FakeJira {
  /** Created issues. */
  readonly issues: { id: string; key: string; description: unknown; summary: string }[];
  /** Number of create calls whose response is lost after Jira created the issue. */
  dropNextResponses: number;
  /** Searches made. */
  readonly searches: URLSearchParams[];
  /** Transport. */
  readonly fetch: JiraFetch;
}

/**
 * A stateful fixture Jira site.
 *
 * @returns The fixture.
 */
export function fakeJira(): FakeJira {
  const jira: FakeJira = {
    issues: [],
    dropNextResponses: 0,
    searches: [],
    fetch: async (raw, init) => {
      await Promise.resolve();
      const url = new URL(raw);
      let body: unknown = {};
      if (init.method === 'POST' && url.pathname === '/rest/api/3/issue') {
        const { fields } = issueBodySchema.parse(JSON.parse(init.body ?? '{}'));
        const issue = { id: String(10_000 + jira.issues.length), key: `PROJ-${String(jira.issues.length + 2)}` };
        jira.issues.push({ ...issue, description: fields.description, summary: fields.summary });
        if (jira.dropNextResponses > 0) {
          jira.dropNextResponses -= 1;
          throw new Error('socket hang up');
        }
        body = issue;
      } else if (url.pathname === '/rest/api/3/search/jql') {
        jira.searches.push(url.searchParams);
        body = { issues: jira.issues.map(({ id, key, description }) => ({ id, key, fields: { description } })) };
      }
      const text = JSON.stringify(body);
      return {
        status: init.method === 'POST' ? 201 : 200,
        headers: { get: () => null },
        text: async () => {
          await Promise.resolve();
          return text;
        },
      };
    },
  };
  return jira;
}

/**
 * Write context and ledger for a project whose policy lets the operator create children and comment.
 *
 * @param t - Owns cleanup.
 * @param jira - Fixture site.
 * @returns Context and ledger.
 */
export function setup(t: TestContext, jira: FakeJira): { context: JiraWriteContext; ledger: CreationLedger } {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  const gate = new CapabilityPolicyStore(store, config);
  gate.set(OPERATOR, 'issue-create', { mode: 'human-only', roles: [] });
  gate.set(OPERATOR, 'relationships', { mode: 'human-only', roles: [] });
  gate.set(OPERATOR, 'comment', { mode: 'human-only', roles: [] });
  const directory = mkdtempSync(path.join(tmpdir(), 'malt-jira-'));
  defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    context: {
      transport: {
        site: { origin: 'https://example.atlassian.net', deployment: 'cloud' },
        credential: { email: 'robot@example.com', token: 'token' },
        fetch: jira.fetch,
      },
      gate,
      principal: OPERATOR,
    },
    ledger: { directory, projectId: 'project-1', now: () => Date.now() },
  };
}
