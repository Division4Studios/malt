/**
 * Native operator configuration for organization and GitHub project setup.
 *
 * @file
 */
import { child, data, text, displayText } from './api.js';
import { element } from './worker-ui.js';

import type { Snapshot, Data } from './api.js';

/** Bound instruction excerpts; the editor retains full validated text. */
const EXCERPT = 400;

/**
 * Show reusable profiles separately from logical seats and live processes.
 *
 * @param state - Authenticated project snapshot.
 * @param edit - Opens the explicit durable backend configuration editor.
 * @returns Readable organization configuration and its actual handoff policy.
 */
export function organizationPanel(state: Snapshot, edit: () => void): HTMLElement {
  const section = element('section', 'panel-body');
  const organization = child(child(state.factory, 'settings'), 'organization');
  const types = child(organization, 'types');
  const members = child(organization, 'members');
  section.append(
    element('h2', '', 'Agent types & reporting hierarchy'),
    element(
      'p',
      'subtle',
      'Reusable types specialize the eight managed execution seats. Reporting handoffs are durable and delivered on the manager’s next relevant assignment. Mandatory QA and merge gates remain independent.',
    ),
  );
  const button = element('button', 'button secondary', 'Edit agent types & hierarchy');
  button.type = 'button';
  button.disabled = Object.keys(organization).length === 0;
  button.addEventListener('click', edit);
  section.append(button);
  if (button.disabled) {
    section.append(
      element('p', 'subtle', 'Configure the factory in Project setup to establish its managed organization.'),
    );
    return section;
  }
  for (const [name, value] of Object.entries(types)) {
    const profile = data(value);
    const card = element('article', 'scope-signal');
    const { skills } = profile;
    const priority = Array.isArray(skills)
      ? skills.filter((skill: unknown) => typeof skill === 'string').join(' → ')
      : '';
    card.append(
      element('h3', '', `${name} / ${text(profile, 'label')}`),
      element(
        'p',
        'subtle',
        `Capability floor: ${text(profile, 'minimumTier')} · prioritized skills: ${priority === '' ? 'stage baseline only' : priority}`,
      ),
      element('p', '', text(profile, 'instructions').slice(0, EXCERPT)),
    );
    section.append(card);
  }
  const list = element('ul');
  for (const [role, value] of Object.entries(members)) {
    const member = data(value);
    const manager = text(member, 'reportsTo');
    list.append(
      element('li', '', `${role} / ${text(member, 'type')} → ${manager === '' ? 'operator (root)' : manager}`),
    );
  }
  section.append(element('h3', '', 'Reporting handoffs'), list);
  return section;
}

/**
 * Describe a reviewable organization edit using the authenticated editor.
 *
 * @param settings - Current selected project's factory policy.
 * @returns Editor contents and durable backend operation.
 */
export function organizationDialog(settings: Data): {
  description: { title: string; explanation: string; initial: string };
  action: { operation: string; input: (body: string) => unknown };
} {
  return {
    description: {
      title: 'Agent types & reporting hierarchy',
      explanation:
        'Pause managed work before saving. Edit types, prioritized skills, capability floors and member reporting links. Every seat must reference an existing type; cycles and unknown roles are rejected.',
      initial: JSON.stringify(child(settings, 'organization'), null, 2),
    },
    action: { operation: 'factory_setup', input: (body) => ({ ...settings, organization: data(JSON.parse(body)) }) },
  };
}

/** Operator guidance for a rejected Project link; never echoes the entered value. */
const invalidProjectUrl =
  'Paste an existing https://github.com/users/OWNER/projects/NUMBER or /orgs/OWNER/projects/NUMBER URL.';

/**
 * Convert explicit GitHub fields into a repository-scoped connection request.
 *
 * @param repository - Canonical owner/repository entered by the operator.
 * @param projectUrl - Existing user or organization Project URL.
 * @param statusFieldName - Exact existing workflow field name.
 * @returns Existing Project request; never implicit Project creation.
 * @throws {Error} For invalid host, path, credentials or field selection.
 */
export function githubConnectionInput(repository: string, projectUrl: string, statusFieldName: string): Data {
  if (!/^https:\/\/github\.com\//iv.test(projectUrl.trim())) {
    throw new Error(invalidProjectUrl);
  }
  const repositoryName = repository.trim();
  const field = statusFieldName.trim();
  let url: URL;
  try {
    url = new URL(projectUrl.trim());
  } catch {
    throw new Error(invalidProjectUrl);
  }
  const match = /^\/(?:orgs|users)\/(?<owner>[\w\-]+)\/projects\/(?<number>\d+)\/?$/v.exec(url.pathname);
  if (
    match === null ||
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port !== '' ||
    [url.username, url.password, url.search, url.hash].some((value) => value !== '')
  ) {
    throw new Error(invalidProjectUrl);
  }
  const owner = match.groups?.['owner'] ?? '';
  const number = Number(match.groups?.['number']);
  if (field === '' || number < 1 || !Number.isSafeInteger(number) || !/^[\w\-.]+\/[\w\-.]+$/v.test(repositoryName)) {
    throw new Error('Use owner/repository, a positive Project number and the exact existing workflow field name.');
  }
  return { repository: repositoryName, owner, projectNumber: number, statusFieldName: field };
}

/**
 * Describe the existing-project connection form.
 *
 * @returns Plain operator editor metadata.
 */
export function githubConnectionDescription(): ReturnType<typeof organizationDialog>['description'] {
  return {
    title: 'Connect GitHub Project',
    explanation:
      'Review the saved connection for this repository. This connects an existing Project; it does not create a board.',
    initial: '',
  };
}

/**
 * Restore the generic editor before opening another explicit operator control.
 *
 * @param body - Fixed operator editor textarea.
 */
export function resetConnectionFields(body: HTMLTextAreaElement): void {
  const textarea = body;
  document.querySelector('[data-github-connection]')?.remove();
  textarea.hidden = false;
  textarea.required = true;
  const label = document.querySelector('#editor-label');
  if (label instanceof HTMLElement) {
    label.hidden = false;
  }
}

/**
 * Present saved repository, Project URL and workflow field as native controls.
 *
 * @param body - Existing authenticated editor's textarea, replaced visually.
 * @param connection - Saved selected-project metadata, never credentials.
 * @returns Read the operator's current fields for the existing broker control.
 */
export function mountConnectionFields(body: HTMLTextAreaElement, connection: Data): () => Data {
  const textarea = body;
  const panel = element('section', 'connection-fields');
  panel.dataset['githubConnection'] = '';
  const inputs = [
    ['Repository', 'github-repository', text(connection, 'repository'), 'Division4Studios/malt'],
    [
      'GitHub Project URL',
      'github-project-url',
      text(child(connection, 'project'), 'url'),
      'https://github.com/users/Division4Studios/projects/10',
    ],
    [
      'Workflow status field',
      'github-status-field',
      displayText(text(child(connection, 'statusField'), 'name'), 'Status'),
      'Status',
    ],
  ].map(([labelText = '', id = '', value = '', placeholder = '']) => {
    const input = element('input');
    input.id = id;
    input.value = value;
    input.placeholder = placeholder;
    input.required = true;
    input.maxLength = 500;
    input.autocomplete = 'off';
    const label = element('label', '', labelText);
    label.htmlFor = input.id;
    panel.append(label, input);
    return input;
  });
  panel.append(
    element(
      'p',
      'subtle',
      'Paste the Project link; its owner and number are derived automatically. Use Status to match the existing board. GitHub CLI verifies repository access, Project permission and all workflow options before saving. Saved views are not changed.',
    ),
  );
  textarea.before(panel);
  textarea.hidden = true;
  textarea.required = false;
  const editorLabel = document.querySelector('#editor-label');
  if (editorLabel instanceof HTMLElement) {
    editorLabel.hidden = true;
  }
  return () => githubConnectionInput(inputs[0]?.value ?? '', inputs[1]?.value ?? '', inputs[2]?.value ?? '');
}

/**
 * Describe a project policy edit without putting backend execution in the UI.
 *
 * @param settings - Saved selected-project settings.
 * @returns Explicit editor data and existing backend operation.
 */
export function factoryPolicyDialog(settings: Data): ReturnType<typeof organizationDialog> {
  const defaults = {
    testCommands: [{ file: 'npm', args: ['test'] }],
    endToEndCommands: [{ file: 'npm', args: ['run', 'test:e2e'] }],
    prepareCommands: [{ file: 'npm', args: ['ci', '--ignore-scripts'] }],
  };
  return {
    description: {
      title: 'Configure factory policy',
      explanation:
        'Use this project’s actual commands and executable paths. Pause before updating an active factory. Authentication stays with the native CLI.',
      initial: JSON.stringify(Object.keys(settings).length === 0 ? defaults : settings, null, 2),
    },
    action: { operation: 'factory_setup', input: (body) => data(JSON.parse(body)) },
  };
}
