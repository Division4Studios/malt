/**
 * The Connections view (#84): separate Work tracker and Source control
 * sections rendered from the saved connection, choices only from discovery,
 * loading, success and failure states, Jira findings with the admin summary
 * (#330), the local hub as a source, accessible names, kept focus, and no
 * credential in the DOM or browser storage.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConnectionView } from '../web/dist/connection-ui.js';

import { fake, installDom } from './dom-shim.ts';

import type { FakeElement } from './dom-shim.ts';
import type { TestContext } from 'node:test';

/** A fixture value standing in for a credential; it must never be rendered or stored. */
const SECRET = ['fixture', 'credential', 'value'].join('-');

/** One recorded operator control. */
interface Sent {
  /** Operation. */
  readonly operation: string;
  /** Input. */
  readonly input: unknown;
}

/** A saved GitHub tracker, verified, and a GitHub source saved but never checked. */
const SAVED = {
  local: null,
  github: {
    credentials: { tracker: 'present', source: 'present', token: SECRET },
    connectionV2: {
      version: 2,
      tracker: {
        provider: 'github-projects',
        owner: 'example',
        projectId: 'PVT_10',
        projectNumber: 10,
        url: 'https://github.com/users/example/projects/10',
        workflowField: { id: 'F_1', name: 'Status' },
        verification: { state: 'verified', checkedAt: '2026-10-17T00:00:00.000Z', errors: [] },
      },
      source: {
        provider: 'github',
        repository: 'example/app',
        verification: {
          state: 'failed',
          checkedAt: '2026-10-17T00:00:00.000Z',
          errors: [{ step: 'repository', message: 'Grant repository access to the gh session.' }],
        },
      },
    },
  },
};

/** Discovery of the owner's Projects, then of one Project's fields. */
const DISCOVERY = {
  login: 'example',
  owner: 'example',
  repositories: [{ id: 'R_1', nameWithOwner: 'example/app', url: 'https://github.com/example/app' }],
  projects: [{ id: 'PVT_11', number: 11, title: 'Next', url: 'https://github.com/users/example/projects/11' }],
  fields: [{ id: 'F_2', name: 'Stage' }],
  errors: [],
};

/** A Jira project reachable with one permission missing. */
const JIRA_DISCOVERY = {
  state: 'degraded',
  site: 'https://example.atlassian.net',
  caller: { displayName: 'MALT robot' },
  project: { id: '10000', key: 'PROJ', name: 'Project', url: 'https://example.atlassian.net/browse/PROJ' },
  issueTypes: [{ id: '1' }],
  missing: [{ permission: 'LINK_ISSUES', action: 'Grant "Link Issues" to the account.' }],
  problems: [{ scope: 'permissions', message: 'Missing LINK_ISSUES.' }],
};

/** The capability view with its Jira admin summary. */
const CAPABILITIES = {
  capabilities: [],
  jira: {
    mode: 'read-only',
    roles: [],
    reads: ['The site and its deployment type.'],
    writes: [{ capability: 'comment', change: 'Comment progress on issues.', mode: 'disabled', roles: [] }],
  },
};

/** Event-loop turns a view's read, control and redraw take to finish. */
const TURNS = 5;

/**
 * Let pending promise chains finish.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < TURNS; turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Fire one listener of a node.
 *
 * @param node - Target.
 * @param type - Event type.
 */
function fire(node: FakeElement, type: string): void {
  const [handler] = node.listeners.get(type) ?? [];
  assert.ok(typeof handler === 'function', `${node.tagName} handles ${type}`);
  Reflect.apply(handler, node, []);
}

/**
 * Find a button by its text.
 *
 * @param root - View root.
 * @param label - The button's visible text.
 * @returns The first button with that text.
 */
function buttonNamed(root: FakeElement, label: string): FakeElement {
  const found = root.querySelectorAll('button').find((node) => node.textContent === label);
  assert.ok(found !== undefined, `a "${label}" button`);
  return found;
}

/**
 * Find the control inside the label with the given text.
 *
 * @param root - View root.
 * @param label - Text of the label wrapping the control.
 * @param tag - `select` or `input`.
 * @returns The control inside that label.
 */
function control(root: FakeElement, label: string, tag: 'select' | 'input'): FakeElement {
  const wrapper = root
    .querySelectorAll('label')
    .find((node) => node.children.some((part) => part.tagName === 'SPAN' && part.textContent === label));
  const found = wrapper?.querySelector(tag);
  assert.ok(found !== undefined && found !== null, `a ${tag} labelled "${label}"`);
  return found;
}

/**
 * Choose a value in a select and fire its change.
 *
 * @param select - Select control.
 * @param value - Option value.
 */
function choose(select: FakeElement, value: string): void {
  Reflect.set(select, 'value', value);
  fire(select, 'change');
}

/**
 * Stub browser storage and fail the test on any write.
 *
 * @param t - Owns the stubs.
 * @returns Every key written.
 */
function watchStorage(t: TestContext): string[] {
  const written: string[] = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    const storage = {
      getItem: () => null,
      setItem: (key: string, value: string) => {
        written.push(`${name}:${key}=${value}`);
      },
      removeItem: () => {
        /* Nothing is stored. */
      },
    };
    Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
    t.after(() => {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, previous);
      }
    });
  }
  return written;
}

/**
 * Serve fixture routes from a stubbed `fetch`.
 *
 * @param t - Owns the mock.
 * @param answer - Answer for a route, or an error to reject with.
 * @param gate - Optional promise that holds every answer until it resolves.
 * @returns Requested routes.
 */
function serve(t: TestContext, answer: (route: string) => unknown, gate?: Promise<unknown>): string[] {
  const routes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (route: string) => {
    routes.push(route);
    await (gate ?? Promise.resolve());
    const body = answer(route);
    if (Error.isError(body)) {
      throw body;
    }
    return Response.json(body);
  });
  return routes;
}

/**
 * Create the view against a recording control.
 *
 * @param t - Owns the DOM.
 * @param results - Results the control hands back per operation.
 * @param scope - Selected project, and an optional gate that holds each control's answer.
 * @param scope.project - Currently selected project.
 * @param scope.gate - Resolves when the held answers may arrive.
 * @returns View root, update and sent controls.
 */
function mount(
  t: TestContext,
  results: Readonly<Record<string, unknown>> = {},
  scope: { readonly project: () => string; readonly gate?: Promise<unknown> } = { project: () => 'home' },
): { root: FakeElement; update: (snapshot: unknown) => void; sent: Sent[]; selected: string[] } {
  const dom = installDom(t);
  const sent: Sent[] = [];
  const selected: string[] = [];
  const view = createConnectionView({
    project: scope.project,
    control: async (operation, input, onResult) => {
      sent.push({ operation, input });
      // A test may hold every control's answer until it releases the gate.
      await (scope.gate ?? Promise.resolve());
      onResult?.(results[operation] ?? {});
      return true;
    },
    select: (name) => {
      selected.push(name);
    },
  });
  const root = fake(view.element);
  dom.body.append(root);
  return { root, update: view.update, sent, selected };
}

await test('each section shows its saved state, last check, link and step errors, with accessible structure', (t) => {
  const written = watchStorage(t);
  const { root, update } = mount(t);
  update(SAVED);
  const text = root.textContent;
  assert.match(text, /Work tracker/v);
  assert.match(text, /Source control/v);
  assert.match(text, /Verified/v);
  assert.match(text, /Verification failed/v);
  assert.match(text, /repository: Grant repository access to the gh session\./v);
  assert.match(text, /example · Project 10 · Status/v);
  const sections = root.querySelectorAll('section').filter((node) => node.attributes.has('aria-labelledby'));
  assert.equal(sections.length, 2, 'two separately labelled sections');
  for (const section of sections) {
    const heading = section.querySelector('h2');
    assert.equal(Reflect.get(heading ?? {}, 'id'), section.getAttribute('aria-labelledby'));
  }
  assert.equal(root.querySelector('fieldset')?.querySelector('legend')?.textContent, 'Tracker provider');
  assert.ok(root.querySelector('[role]')?.getAttribute('aria-live') === 'polite', 'progress is announced');
  const links = root.querySelectorAll('a').map((node): unknown => Reflect.get(node, 'href'));
  assert.ok(links.includes('https://github.com/users/example/projects/10'));
  assert.equal(text.includes(SECRET), false, 'no credential value in the DOM');
  assert.deepEqual(written, [], 'nothing goes to browser storage');
});

await test('a saved but unverified section reads apart from a verified one, and nothing saved offers no placeholders', (t) => {
  const { root, update } = mount(t);
  update({ local: null, github: { connectionV2: null } });
  assert.match(root.textContent, /Not saved/v);
  assert.equal(root.textContent.includes('Project 1'), false, 'no placeholder Project');
  assert.equal(Reflect.get(buttonNamed(root, 'Verify connection'), 'disabled'), true, 'nothing to verify yet');
  const unverified = structuredClone(SAVED);
  unverified.github.connectionV2.tracker.verification = { state: 'saved', checkedAt: '', errors: [] };
  update(unverified);
  assert.match(root.textContent, /Saved, not yet verified/v);
});

await test('GitHub choices come from discovery while it loads, and only a discovered choice is saved', async (t) => {
  const routes = serve(t, () => DISCOVERY);
  const { root, update, sent } = mount(t);
  update(SAVED);
  const discover = buttonNamed(root, 'Discover Projects');
  discover.focus();
  fire(discover, 'click');
  assert.match(root.textContent, /Discovering GitHub Projects…/v, 'loading is shown');
  await settle();
  assert.deepEqual(routes, ['/api/github-discovery?project=home&owner=example']);
  assert.match(root.textContent, /Discovery finished\./v);
  choose(control(root, 'GitHub Project', 'select'), 'PVT_11');
  await settle();
  assert.equal(routes[1], '/api/github-discovery?project=home&owner=example&projectNumber=11');
  choose(control(root, 'Workflow status field', 'select'), 'F_2');
  const save = buttonNamed(root, 'Save work tracker');
  assert.equal(Reflect.get(save, 'disabled'), false);
  fire(save, 'click');
  await settle();
  assert.deepEqual(sent, [
    {
      operation: 'github_section_save',
      input: {
        tracker: {
          owner: 'example',
          projectId: 'PVT_11',
          projectNumber: 11,
          url: 'https://github.com/users/example/projects/11',
          workflowField: { id: 'F_2', name: 'Stage' },
        },
      },
    },
  ]);
  assert.match(root.textContent, /Saved\. Verify the connection to check it\./v);
});

await test('a failed discovery says why, keeps the saved view, and an unchanged push keeps focus', async (t) => {
  serve(t, () => new Error('broker offline'));
  const { root, update } = mount(t);
  update(SAVED);
  const discover = buttonNamed(root, 'Discover repositories');
  discover.focus();
  fire(discover, 'click');
  await settle();
  assert.match(root.textContent, /Not done: broker offline/v);
  assert.match(root.textContent, /example\/app/v, 'the saved source is still shown');
  update(SAVED);
  const active: unknown = Reflect.get(Reflect.get(globalThis, 'document') ?? {}, 'activeElement');
  assert.equal(fake(active).dataset['focusKey'], 'connection-source-discover', 'focus stays on the control');
});

await test('Jira is checked against its site, shows what is missing and the admin summary, and saves the found project', async (t) => {
  const written = watchStorage(t);
  serve(t, () => CAPABILITIES);
  const { root, update, sent, selected } = mount(t, { jira_discover: JIRA_DISCOVERY });
  update(SAVED);
  const jira = root.querySelectorAll('input').find((node) => Reflect.get(node, 'value') === 'jira');
  assert.ok(jira !== undefined);
  Reflect.set(jira, 'checked', true);
  fire(jira, 'change');
  assert.match(root.textContent, /The factory does not deliver through Jira yet/v);
  for (const [label, value] of [
    ['Jira Cloud site', 'https://example.atlassian.net'],
    ['Project key', 'PROJ'],
    ['Account email', 'robot@example.com'],
  ] as const) {
    const input = control(root, label, 'input');
    Reflect.set(input, 'value', value);
    fire(input, 'input');
  }
  const variable = control(root, 'Token environment variable', 'input');
  assert.equal(Reflect.get(variable, 'value'), 'JIRA_API_TOKEN', 'only a variable name is asked for');
  fire(buttonNamed(root, 'Check Jira project'), 'click');
  await settle();
  assert.deepEqual(sent[0], {
    operation: 'jira_discover',
    input: {
      site: 'https://example.atlassian.net',
      projectKey: 'PROJ',
      email: 'robot@example.com',
      tokenVariable: 'JIRA_API_TOKEN',
    },
  });
  const text = root.textContent;
  assert.match(text, /Reachable, with problems to fix/v);
  assert.match(text, /LINK_ISSUES: Grant "Link Issues" to the account\./v);
  assert.match(text, /What MALT reads and may change in Jira/v);
  assert.match(text, /Read only: MALT changes nothing in Jira/v);
  assert.match(text, /Comment progress on issues\./v);
  assert.match(text, /Disabled/v, 'each write shows its current policy before it is enabled');
  fire(buttonNamed(root, 'Change on Capabilities'), 'click');
  assert.deepEqual(selected, ['capabilities']);
  fire(buttonNamed(root, 'Save work tracker'), 'click');
  await settle();
  assert.deepEqual(sent[1], {
    operation: 'github_section_save',
    input: {
      jiraTracker: {
        site: 'https://example.atlassian.net',
        projectKey: 'PROJ',
        projectId: '10000',
        email: 'robot@example.com',
        tokenVariable: 'JIRA_API_TOKEN',
      },
    },
  });
  assert.equal(root.textContent.includes(SECRET), false);
  assert.deepEqual(written, []);
});

await test('an invalid Jira form is explained without being sent', (t) => {
  const { root, update, sent } = mount(t);
  update(SAVED);
  const jira = root.querySelectorAll('input').find((node) => Reflect.get(node, 'value') === 'jira');
  assert.ok(jira !== undefined);
  Reflect.set(jira, 'checked', true);
  fire(jira, 'change');
  fire(buttonNamed(root, 'Check Jira project'), 'click');
  assert.match(root.textContent, /Enter a Jira Cloud site/v);
  assert.deepEqual(sent, []);
});

await test('with local delivery the source section shows the hub, and a first save needs both sections', async (t) => {
  serve(t, () => DISCOVERY);
  const { root, update, selected, sent } = mount(t);
  update({ local: { base: 'main', remote: 'malt-hub', issues: [{}], pulls: [] }, github: { connectionV2: null } });
  assert.match(root.textContent, /Provider: Local delivery hub/v);
  assert.match(root.textContent, /Base branch main · remote malt-hub · 1 issues · 0 pull requests/v);
  fire(buttonNamed(root, 'Open Setup & capacity'), 'click');
  assert.deepEqual(selected, ['setup']);
  fire(buttonNamed(root, 'Discover Projects'), 'click');
  await settle();
  choose(control(root, 'GitHub Project', 'select'), 'PVT_11');
  await settle();
  choose(control(root, 'Workflow status field', 'select'), 'F_2');
  const trackerSave = root.querySelectorAll('button').find((node) => node.textContent === 'Save both sections');
  assert.equal(Reflect.get(trackerSave ?? {}, 'disabled'), true, 'a first save waits for a repository choice too');
  assert.match(root.textContent, /The first save needs both sections/v);
  fire(buttonNamed(root, 'Discover repositories'), 'click');
  await settle();
  choose(control(root, 'Repository', 'select'), 'R_1');
  const saves = root.querySelectorAll('button').filter((node) => node.textContent === 'Save both sections');
  assert.equal(saves.length, 2);
  assert.ok(
    saves.every((node) => Reflect.get(node, 'disabled') === false),
    'both choices made, either save sends both',
  );
  fire(saves[1] ?? saves[0] ?? root, 'click');
  await settle();
  assert.ok(Reflect.get(sent[0]?.input ?? {}, 'tracker') !== undefined, 'the tracker is saved with the source');
  assert.deepEqual(Reflect.get(sent[0]?.input ?? {}, 'source'), { repository: 'example/app', repositoryId: 'R_1' });
});

/** A second project's saved connection, with its own repository. */
const OTHER = structuredClone(SAVED);
OTHER.github.connectionV2.source.repository = 'other/service';

await test('a discovery answer that arrives after a project switch never fills the new project', async (t) => {
  for (const [label, select] of [
    ['Discover repositories', 'Repository'],
    ['Discover Projects', 'GitHub Project'],
  ] as const) {
    const gate = Promise.withResolvers<undefined>();
    serve(t, () => DISCOVERY, gate.promise);
    let project = 'a';
    const { root, update } = mount(t, {}, { project: () => project });
    update(SAVED);
    fire(buttonNamed(root, label), 'click');
    project = 'b';
    update(OTHER);
    assert.equal(Reflect.get(buttonNamed(root, label), 'disabled'), false, 'project b is not left busy');
    gate.resolve(undefined);
    await settle();
    // A later push that changes the snapshot redraws from project b's own drafts.
    const changed = structuredClone(OTHER);
    changed.github.connectionV2.source.verification.checkedAt = '2026-10-19T00:00:00.000Z';
    update(changed);
    assert.deepEqual(root.querySelectorAll('select'), [], `${label}: no ${select} choice from project a in project b`);
    assert.doesNotMatch(root.textContent, /Discovery finished/v);
    t.mock.restoreAll();
  }
});

await test('Jira findings for values edited during the check are dropped, so they are never saved', async (t) => {
  const gate = Promise.withResolvers<undefined>();
  serve(t, () => CAPABILITIES);
  const { root, update, sent } = mount(
    t,
    { jira_discover: JIRA_DISCOVERY },
    { project: () => 'home', gate: gate.promise },
  );
  update(SAVED);
  const jira = root.querySelectorAll('input').find((node) => Reflect.get(node, 'value') === 'jira');
  assert.ok(jira !== undefined);
  Reflect.set(jira, 'checked', true);
  fire(jira, 'change');
  for (const [label, value] of [
    ['Jira Cloud site', 'https://example.atlassian.net'],
    ['Project key', 'PROJ'],
    ['Account email', 'robot@example.com'],
  ] as const) {
    const input = control(root, label, 'input');
    Reflect.set(input, 'value', value);
    fire(input, 'input');
  }
  fire(buttonNamed(root, 'Check Jira project'), 'click');
  await settle();
  // The operator edits the key while Jira is still answering for PROJ.
  const key = control(root, 'Project key', 'input');
  Reflect.set(key, 'value', 'OTHER');
  fire(key, 'input');
  gate.resolve(undefined);
  await settle();
  assert.match(root.textContent, /The form changed while Jira was checked/v);
  assert.doesNotMatch(root.textContent, /What Jira reported/v, 'the stale findings are not shown');
  const save = buttonNamed(root, 'Save work tracker');
  assert.equal(Reflect.get(save, 'disabled'), true);
  fire(save, 'click');
  await settle();
  assert.deepEqual(
    sent.map((entry) => entry.operation),
    ['jira_discover'],
    'the project checked for PROJ is never saved with the edited form',
  );
});

await test("a save answered after a project switch leaves the new project's drafts alone", async (t) => {
  const gate = Promise.withResolvers<undefined>();
  serve(t, () => DISCOVERY);
  let project = 'a';
  const { root, update, sent } = mount(t, {}, { project: () => project, gate: gate.promise });
  update(SAVED);
  fire(buttonNamed(root, 'Discover repositories'), 'click');
  await settle();
  choose(control(root, 'Repository', 'select'), 'R_1');
  fire(buttonNamed(root, 'Save source control'), 'click');
  project = 'b';
  update(OTHER);
  fire(buttonNamed(root, 'Discover repositories'), 'click');
  await settle();
  gate.resolve(undefined);
  await settle();
  assert.equal(sent.length, 1, 'only project a saved');
  assert.ok(control(root, 'Repository', 'select'), "project b's discovery is kept");
  assert.doesNotMatch(root.textContent, /Saved\. Verify the connection/v, "a's outcome is not announced in b");
});
