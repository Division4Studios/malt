/** @file Native project-scoped model policy fields; the backend remains authoritative. */
import { data, records, text, displayText } from './api.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { OperatorEdit } from './recovery-ui.js';
import type { EditorDescription } from './worker-ui.js';

/** Three declared capability floors, independent of subscription entitlements. */
const TIERS = ['small', 'standard', 'advanced'];
/** Supported bounded requested efforts. */
const EFFORTS = ['low', 'medium', 'high'];
/** Maximum account-local model entries. */
const MAX_MODELS = 24;
/** Maximum provider/tier defaults. */
const MAX_DEFAULTS = 6;
/** Bounded policy-local entry identities. */
const ID_MAX = 64;
/** Bounded evidence notes. */
const NOTE_MAX = 2000;

/**
 * Prepare the exact-revision editor without mounting fields into a rejected dialog.
 *
 * @param body - Shared authenticated operator form.
 * @param policy - Current project's last observed policy.
 * @returns Explicit control and native field lifecycle.
 */
export function modelPolicyDialog(
  body: HTMLTextAreaElement,
  policy: Data,
): { description: EditorDescription; action: OperatorEdit } {
  let read: (() => Data) | null = null;
  return {
    description: {
      title: t('Model and effort policy'),
      explanation: t(
        'Pause and settle before saving. Use subscription-available models; declared capability and interface evidence are checked before dispatch.',
      ),
      initial: '',
      mount: () => {
        read = mountModelPolicy(body, policy);
      },
    },
    action: {
      operation: 'factory_model_policy',
      input: () => {
        if (read === null) {
          throw new Error(t('Open the policy editor before saving.'));
        }
        return read();
      },
    },
  };
}

/**
 * Label a native input without interpreting project text as markup.
 *
 * @param parent - Owning fieldset.
 * @param caption - Plain accessible label.
 * @param value - Existing plain field value.
 * @param maximum - Server-compatible text bound.
 * @returns Focusable bounded text control.
 */
function input(parent: HTMLElement, caption: string, value: string, maximum = 256): HTMLInputElement {
  const label = element('label', '', caption);
  const field = element('input');
  field.value = value;
  field.maxLength = maximum;
  label.append(field);
  parent.append(label);
  return field;
}

/**
 * Present a closed native choice list, preserving unknown values for correction.
 *
 * @param parent - Owning fieldset.
 * @param caption - Plain accessible label.
 * @param choices - Allowed interface choices.
 * @param value - Current saved value.
 * @returns Native selector.
 */
function select(parent: HTMLElement, caption: string, choices: readonly string[], value: string): HTMLSelectElement {
  const label = element('label', '', caption);
  const field = element('select');
  for (const choice of choices) {
    const option = element('option', '', choice === '' ? t('No effort override') : choice);
    option.value = choice;
    field.append(option);
  }
  field.value = value;
  label.append(field);
  parent.append(label);
  return field;
}

/**
 * Collect an exact model entry; support evidence is declared, never inferred.
 *
 * @param row - Removable entry fieldset.
 * @param entry - Saved server data, or empty for an explicit new entry.
 * @returns Current draft reader.
 */
function modelFields(row: HTMLFieldSetElement, entry: Data): () => Data {
  const id = input(row, t('Policy entry ID'), text(entry, 'id'), ID_MAX);
  const provider = select(row, t('Provider'), ['codex', 'claude'], displayText(text(entry, 'provider'), 'codex'));
  const model = input(row, t('Literal model identifier'), text(entry, 'model'));
  const capability = select(row, t('Declared capability'), TIERS, displayText(text(entry, 'capability'), 'standard'));
  const support = select(
    row,
    t('Verified effort interface'),
    ['unknown', 'none', 'codex-config', 'claude-effort'],
    displayText(text(entry, 'effortSupport'), 'unknown'),
  );
  const effortInputs = EFFORTS.map((effort) => {
    const label = element('label', '', t('Allow {effort} effort', { effort }));
    const field = element('input');
    field.type = 'checkbox';
    field.checked = Array.isArray(entry['efforts']) && entry['efforts'].includes(effort);
    label.prepend(field);
    row.append(label);
    return { effort, field };
  });
  const evidence = entry['evidence'] === null || entry['evidence'] === undefined ? {} : data(entry['evidence']);
  const source = input(row, t('Interface evidence source / notes'), text(evidence, 'source'), NOTE_MAX);
  const version = input(row, t('Exact verified CLI version'), text(evidence, 'version'));
  const observed = input(
    row,
    t('Evidence timestamp (Unix milliseconds)'),
    typeof evidence['observedAt'] === 'number' ? String(evidence['observedAt']) : '',
  );
  observed.type = 'number';
  observed.min = '1';
  observed.step = '1';
  const status = element('p', 'subtle');
  const refresh = (): void => {
    const isKnown = support.value !== 'unknown';
    const isExplicit = isKnown && support.value !== 'none';
    for (const { field } of effortInputs) {
      field.disabled = !isExplicit;
    }
    for (const field of [source, version, observed]) {
      field.required = isKnown;
    }
    status.textContent = t(
      isKnown
        ? 'Evidence must match the installed CLI. Saving does not certify model capability or available quota.'
        : 'Unknown support: this entry cannot launch an explicit-policy assignment.',
    );
  };
  support.addEventListener('change', refresh);
  refresh();
  row.append(status);
  for (const field of [id, model]) {
    field.required = true;
  }
  return () => {
    return {
      id: id.value.trim(),
      provider: provider.value,
      model: model.value.trim(),
      capability: capability.value,
      effortSupport: support.value,
      efforts: effortInputs.filter(({ field }) => !field.disabled && field.checked).map(({ effort }) => effort),
      evidence:
        support.value === 'unknown'
          ? null
          : { source: source.value.trim(), version: version.value.trim(), observedAt: Number(observed.value) },
    };
  };
}

/**
 * Mount bounded entry/default editors in the existing authenticated operator form.
 *
 * @param body - Existing editor textarea, hidden while native fields are active.
 * @param policy - Last observed policy; absent policy starts an explicitly empty draft.
 * @returns Exact-revision save input; stale errors never mutate these draft controls.
 */
export function mountModelPolicy(body: HTMLTextAreaElement, policy: Data): () => Data {
  const textarea = body;
  const panel = element('section', 'connection-fields');
  panel.dataset['editorFields'] = '';
  panel.dataset['modelPolicy'] = '';
  const revision = typeof policy['revision'] === 'number' ? policy['revision'] : null;
  const shownRevision = revision ?? t('none');
  panel.append(
    element(
      'p',
      'subtle',
      t('Editing revision {revision}. Save requires a paused, settled factory. Unknown quota stays unknown.', {
        revision: shownRevision,
      }),
    ),
  );
  const readers = new Map<HTMLFieldSetElement, () => Data>();
  const defaults = new Map<HTMLFieldSetElement, () => Data>();
  const modelsHost = element('section');
  const defaultsHost = element('section');
  const modelButton = element('button', 'button secondary', t('Add allowed model'));
  const defaultButton = element('button', 'button secondary', t('Add provider/tier default'));
  modelButton.type = 'button';
  defaultButton.type = 'button';
  const append = (kind: 'model' | 'default', value: Data): void => {
    const map = kind === 'model' ? readers : defaults;
    if (map.size >= (kind === 'model' ? MAX_MODELS : MAX_DEFAULTS)) {
      return;
    }
    const row = element('fieldset');
    row.append(element('legend', '', t(kind === 'model' ? 'Allowed model' : 'Provider/tier default')));
    if (kind === 'model') {
      map.set(row, modelFields(row, value));
    } else {
      const provider = select(
        row,
        t('Default provider'),
        ['codex', 'claude'],
        displayText(text(value, 'provider'), 'codex'),
      );
      const tier = select(row, t('Default capability floor'), TIERS, displayText(text(value, 'tier'), 'standard'));
      const entry = input(row, t('Allowed policy entry ID'), text(value, 'entryId'), ID_MAX);
      entry.required = true;
      const effort = select(row, t('Default requested effort'), ['', ...EFFORTS], text(value, 'effort'));
      map.set(row, () => {
        return {
          provider: provider.value,
          tier: tier.value,
          entryId: entry.value.trim(),
          effort: effort.value === '' ? null : effort.value,
        };
      });
    }
    const remove = element('button', 'button secondary', t('Remove this entry'));
    remove.type = 'button';
    remove.addEventListener('click', () => {
      map.delete(row);
      row.remove();
      modelButton.disabled = readers.size >= MAX_MODELS;
      defaultButton.disabled = defaults.size >= MAX_DEFAULTS;
      (kind === 'model' ? modelButton : defaultButton).focus();
    });
    row.append(remove);
    (kind === 'model' ? modelsHost : defaultsHost).append(row);
    modelButton.disabled = readers.size >= MAX_MODELS;
    defaultButton.disabled = defaults.size >= MAX_DEFAULTS;
  };
  const savedEntries = records(policy['entries']);
  for (const entry of savedEntries) {
    append('model', entry);
  }
  const savedDefaults = records(policy['defaults']);
  for (const choice of savedDefaults) {
    append('default', choice);
  }
  modelButton.addEventListener('click', () => {
    append('model', {});
    modelsHost.lastElementChild?.querySelector('input')?.focus();
  });
  defaultButton.addEventListener('click', () => {
    append('default', {});
    defaultsHost.lastElementChild?.querySelector('select')?.focus();
  });
  panel.append(
    element('h3', '', t('Allowed models')),
    modelsHost,
    modelButton,
    element('h3', '', t('Defaults')),
    defaultsHost,
    defaultButton,
  );
  textarea.before(panel);
  textarea.hidden = true;
  textarea.required = false;
  document.querySelector('#editor-label')?.setAttribute('hidden', '');
  return () => {
    return {
      expectedRevision: revision,
      policy: {
        revision: (revision ?? 0) + 1,
        entries: Array.from(readers.values(), (read) => read()),
        defaults: Array.from(defaults.values(), (read) => read()),
      },
    };
  };
}
