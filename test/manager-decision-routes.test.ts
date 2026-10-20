/**
 * The manager's "Resolve in …" hints name real console locations: every
 * decision route's view exists, its path is the one the console navigation
 * shows (the shell's own buttons in `web/index.html`), and the web renders it
 * from the same labels in the selected language. Imports compiled browser
 * modules, so a bare `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DECISION_ROUTES, MANAGER_VIEW, missionBrief } from '../src/factory/manager-brief.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';
import { useLocale } from '../web/dist/i18n.js';
import { HEADINGS, isView, viewPath } from '../web/dist/navigation.js';

import { createCleanup, createProject } from './helpers.ts';

/** The console shell, whose buttons are the real navigation. */
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's console shell.
const SHELL = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
/** Rail buttons: group, the view they open and their label. */
const RAIL = /<button data-group="(?<group>\w+)" data-view="(?<view>\w+)"[^>]*>(?<body>[\s\S]*?)<\/button>/gv;
/** Section navigation of one group. */
const SECTIONS = /<div data-navigation="(?<group>\w+)"[^>]*>(?<body>[\s\S]*?)<\/div>/gv;
/** Section buttons inside a group's navigation. */
const SECTION_BUTTONS = /<button data-view="(?<view>\w+)"[^>]*>(?<body>[^<]*)<\/button/gv;

/**
 * Visible text of a button body, without its glyph and badge spans.
 *
 * @param body - Markup inside a button.
 * @returns Trimmed label.
 */
function label(body: string): string {
  return body
    .replaceAll(/<span[^>]*>[^<]*<\/span>/gv, '')
    .replaceAll('&amp;', '&')
    .trim();
}

/**
 * One named group of a match.
 *
 * @param match - Regular-expression match.
 * @param name - Group name.
 * @returns Captured text, or empty.
 */
function named(match: RegExpMatchArray, name: 'body' | 'group' | 'view'): string {
  return match.groups?.[name] ?? '';
}

/**
 * The navigation path of every view the shell has a button for, read from the shell markup.
 *
 * @returns Path per view, `Group → Section` or the group alone.
 */
function shellPaths(): Map<string, string> {
  const groups = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const rail of SHELL.matchAll(RAIL)) {
    groups.set(named(rail, 'group'), label(named(rail, 'body')));
    paths.set(named(rail, 'view'), label(named(rail, 'body')));
  }
  for (const section of SHELL.matchAll(SECTIONS)) {
    const groupLabel = groups.get(named(section, 'group')) ?? '';
    for (const button of named(section, 'body').matchAll(SECTION_BUTTONS)) {
      const sectionLabel = label(named(button, 'body'));
      paths.set(named(button, 'view'), sectionLabel === groupLabel ? groupLabel : `${groupLabel} → ${sectionLabel}`);
    }
  }
  return paths;
}

await test('navigation paths are exactly the buttons the console shell shows', () => {
  useLocale('en');
  const paths = shellPaths();
  assert.ok(paths.size > 20, 'the shell navigation was read');
  for (const [view, path] of paths) {
    assert.ok(isView(view), view);
    assert.equal(viewPath(view), path, view);
  }
  for (const view of Object.keys(HEADINGS)) {
    assert.ok(isView(view));
    assert.ok(viewPath(view) !== '', `${view} belongs to a navigation group`);
  }
});

await test('every manager decision hint names a real console location', () => {
  useLocale('en');
  const paths = shellPaths();
  for (const [kind, route] of Object.entries(DECISION_ROUTES)) {
    assert.ok(isView(route.view), `${kind}: ${route.view} is a console view`);
    assert.equal(paths.get(route.view), route.location, `${kind}: the shell has a button at ${route.location}`);
    assert.equal(viewPath(route.view), route.location, `${kind}: the console renders the same location`);
  }
  assert.ok(isView(MANAGER_VIEW) && paths.has(MANAGER_VIEW));
  useLocale('zh-CN');
  assert.equal(viewPath(DECISION_ROUTES.skill.view), '项目 → 学习与技能', 'hints follow the language');
  useLocale('en');
});

await test('the brief tells the operator where a blocked delivery is resolved', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  repository.addTask(
    taskSchema.parse({
      id: randomUUID(),
      featureId: null,
      issue: 5,
      parentIssue: 1,
      key: 'blocked',
      title: 'Blocked work',
      description: 'Stopped.',
      acceptanceCriteria: ['Done.'],
      dependencies: [],
      phase: 'blocked',
      developer: null,
      branch: null,
      worktree: null,
      head: null,
      base: null,
      pr: null,
      prUrl: null,
      merge: null,
      reviews: [],
      feedback: [],
      attempts: 1,
      version: 0,
      error: 'Tests failed.',
      updatedAt: 1,
    }),
  );
  const [decision] = missionBrief(repository, [], Date.now()).decisions;
  assert.equal(decision?.kind, 'blocked_delivery');
  assert.equal(decision.resolveView, 'inbox');
  assert.ok(decision.resolveWith.startsWith(`${DECISION_ROUTES.blocked_delivery.location}: `));
  assert.doesNotMatch(decision.resolveWith, /Deliveries/v, 'no page by that name exists');
});
