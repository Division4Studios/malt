/**
 * Native organization inspection backed by the persisted factory configuration.
 *
 * @file
 */
import { child, data, text } from './api.js';
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
