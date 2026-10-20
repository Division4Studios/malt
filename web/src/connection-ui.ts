/**
 * Connections view under Project: the work tracker and source control as two
 * separate sections. Each shows its saved selection, verification state, last
 * check, credential presence, link and per-step errors, and offers choices
 * only from read-only discovery: GitHub Projects and their Status field, or a
 * Jira Cloud project checked against its site; a GitHub repository, or the
 * local delivery hub when the factory delivers on this machine. Saving goes
 * through `github_section_save` and verifying through `github_verify`. The
 * root is stable, and drafts survive snapshot pushes, so typing is never
 * interrupted and focus is kept. No credential value is ever shown or typed
 * here: a Jira token is only named by its environment variable.
 *
 * @file
 */
import { request, scoped } from './api.js';
import { CAPABILITY_MODES, modeLabel } from './capability-model.js';
import {
  credentialLabel,
  readConnection,
  sectionSave,
  sectionStateLabel,
  sourceProviders,
  trackerProviders,
} from './connection-model.js';
import { button, externalLink, focusedKey, restoreFocus, tag } from './console-dom.js';
import { discoveryRoute, readDiscovery, sourceSaveInput, trackerSaveInput } from './discovery-model.js';
import { t } from './i18n.js';
import {
  jiraDiscoverInput,
  jiraForm,
  jiraFormProblem,
  jiraModeLabel,
  jiraSaveInput,
  jiraStateLabel,
  readJiraAccess,
  readJiraDiscovery,
} from './jira-model.js';
import { element } from './worker-ui.js';

import type { OperatorControl } from './api.js';
import type {
  ConnectionView,
  JiraSettings,
  SectionSave,
  SectionState,
  SectionView,
  TrackerProvider,
} from './connection-model.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { DiscoveryChoices } from './discovery-model.js';
import type { JiraAccess, JiraFindings } from './jira-model.js';

/** Callbacks supplied by the console shell. */
export interface ConnectionHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** Operator control path. */
  readonly control: OperatorControl;
  /** Route the console to another view. */
  readonly select: (view: string) => void;
}

/** Badge colour for each section state. */
const STATE_CLASSES: Readonly<Record<SectionState, string>> = {
  none: '',
  saved: 'state-info',
  verified: 'state-ok',
  degraded: 'state-warn',
  failed: 'state-bad',
  external: 'state-warn',
};

/** Discovery and choices for the GitHub tracker. */
interface GitHubTrackerDraft {
  /** Latest discovery. */
  choices: DiscoveryChoices | null;
  /** Chosen Project node ID. */
  projectId: string;
  /** Chosen Status field ID. */
  fieldId: string;
}

/** Discovery and choices for the GitHub source. */
interface SourceDraft {
  /** Latest discovery. */
  choices: DiscoveryChoices | null;
  /** Chosen repository node ID. */
  repositoryId: string;
}

/** The Jira form and what discovery found. */
interface JiraDraft {
  /** Operator's values. */
  form: JiraSettings;
  /** Latest discovery. */
  findings: JiraFindings | null;
  /** Admin summary of Jira reads and writes. */
  access: JiraAccess | null;
}

/**
 * A select whose options are discovery results, with a leading prompt.
 *
 * @param label - Accessible name.
 * @param key - Focus key.
 * @param options - Value and label pairs.
 * @param selection - Current choice, and what to call with a new one.
 * @param selection.value - Current choice.
 * @param selection.change - Called with the new value.
 * @returns Label wrapping the select.
 */
function choice(
  label: string,
  key: string,
  options: readonly (readonly [string, string])[],
  selection: { readonly value: string; readonly change: (value: string) => void },
): HTMLLabelElement {
  const { value, change } = selection;
  const select = element('select');
  select.dataset['focusKey'] = key;
  const prompt = element('option', '', t('Choose…'));
  prompt.value = '';
  select.append(prompt);
  for (const [optionValue, optionLabel] of options) {
    const option = element('option', '', optionLabel);
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => {
    change(select.value);
  });
  const node = element('label', 'connection-field');
  node.append(element('span', 'connection-field-label', label), select);
  return node;
}

/**
 * A labelled text input that reports each edit.
 *
 * @param label - Visible label.
 * @param key - Focus key and input name.
 * @param binding - Current value, and what to call with each edit.
 * @param binding.value - Current value.
 * @param binding.input - Called with the new value.
 * @param hint - Help text.
 * @returns Label wrapping the input.
 */
function textField(
  label: string,
  key: string,
  binding: { readonly value: string; readonly input: (value: string) => void },
  hint = '',
): HTMLLabelElement {
  const { value, input } = binding;
  const field = element('input');
  field.type = key === 'jira-email' ? 'email' : 'text';
  field.value = value;
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.maxLength = 500;
  field.dataset['focusKey'] = key;
  field.addEventListener('input', () => {
    input(field.value);
  });
  const node = element('label', 'connection-field');
  node.append(element('span', 'connection-field-label', label), field);
  if (hint !== '') {
    node.append(element('span', 'connection-hint', hint));
  }
  return node;
}

/**
 * The state, last check and credential line of a saved section.
 *
 * @param section - Saved section.
 * @param linkLabel - Label of the link to it.
 * @returns Facts block.
 */
function sectionFacts(section: SectionView, linkLabel: string): HTMLElement {
  const facts = element('div', 'connection-facts');
  const line = element('p', 'connection-state');
  line.append(tag(sectionStateLabel(section.state), STATE_CLASSES[section.state]));
  if (section.checkedAt !== '') {
    line.append(element('span', 'subtle', t('Last checked {time}', { time: section.checkedAt })));
  }
  if (section.state !== 'none') {
    line.append(element('span', 'subtle', credentialLabel(section.credential)));
  }
  facts.append(line);
  if (section.selection !== '') {
    facts.append(element('p', '', section.selection));
  }
  if (section.url !== '') {
    facts.append(externalLink(section.url, linkLabel));
  }
  if (section.errors.length > 0) {
    const errors = element('ul', 'connection-errors');
    for (const error of section.errors) {
      errors.append(element('li', '', t('{step}: {message}', { step: error.step, message: error.message })));
    }
    facts.append(errors);
  }
  return facts;
}

/** The Connections view with its drafts. */
class ConnectionPanel {
  /** Stable root. */
  public readonly root = element('section', 'connection-view');
  /** Progress and problems of the last action. */
  private readonly status = element('p', 'connection-status');
  /** Work tracker section. */
  private readonly tracker = element('section', 'connection-section');
  /** Source control section. */
  private readonly source = element('section', 'connection-section');
  /** Verify control area. */
  private readonly actions = element('div', 'connection-actions');
  /** Latest saved connection. */
  private view: ConnectionView | null = null;
  /** The saved connection last drawn, so an unchanged push does not redraw a form being typed in. */
  private drawn = '';
  /** Project the drafts belong to. */
  private scope: string | null = null;
  /** Tracker provider the operator is looking at. */
  private provider: TrackerProvider = 'github-projects';
  /** GitHub tracker draft. */
  private githubTracker: GitHubTrackerDraft = { choices: null, projectId: '', fieldId: '' };
  /** GitHub source draft. */
  private githubSource: SourceDraft = { choices: null, repositoryId: '' };
  /** Jira draft. */
  private jira: JiraDraft = { form: jiraForm(null), findings: null, access: null };
  /** Whether a read or control is in flight. */
  private isBusy = false;
  /** Shell callbacks. */
  private readonly hooks: ConnectionHooks;

  /**
   * Build the view once.
   *
   * @param hooks - Project selection, the operator control path and routing.
   */
  public constructor(hooks: ConnectionHooks) {
    this.hooks = hooks;
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.tracker.setAttribute('aria-labelledby', 'connection-tracker-heading');
    this.source.setAttribute('aria-labelledby', 'connection-source-heading');
    this.root.append(this.status, this.tracker, this.source, this.actions);
  }

  /**
   * Apply the latest snapshot, keeping this project's drafts.
   *
   * @param snapshot - Validated live snapshot.
   */
  public update(snapshot: unknown): void {
    const project = this.hooks.project();
    const view = readConnection(snapshot);
    if (project !== this.scope) {
      // Drafts belong to one project; another project starts from its own saved connection.
      this.scope = project;
      this.drawn = '';
      this.githubTracker = { choices: null, projectId: '', fieldId: '' };
      this.githubSource = { choices: null, repositoryId: '' };
      this.status.textContent = '';
      this.provider = view.trackerProvider ?? 'github-projects';
      this.jira = { form: jiraForm(view.jira), findings: null, access: null };
    }
    this.view = view;
    const signature = JSON.stringify(view);
    if (signature === this.drawn) {
      return;
    }

    this.drawn = signature;
    this.render();
  }

  /** Redraw both sections from the saved connection and the drafts, keeping focus. */
  private render(): void {
    const key = focusedKey(this.root);
    const { view } = this;
    if (view === null) {
      return;
    }
    this.tracker.replaceChildren(...this.trackerSection(view));
    this.source.replaceChildren(...this.sourceSection(view));
    const verify = button(t('Verify connection'), {
      cssClass: 'button',
      key: 'connection-verify',
      action: () => {
        void this.verify();
      },
    });
    verify.disabled = view.isUnsaved || this.isBusy;
    this.actions.replaceChildren(
      verify,
      element(
        'p',
        'subtle',
        t('Verification reads each saved section again and records its state. It never creates or changes anything.'),
      ),
    );
    restoreFocus(this.root, key);
  }

  /**
   * The work tracker section's content.
   *
   * @param view - Saved connection.
   * @returns Child nodes.
   */
  private trackerSection(view: ConnectionView): HTMLElement[] {
    const heading = element('h2', '', t('Work tracker'));
    heading.id = 'connection-tracker-heading';
    return [
      heading,
      element('p', 'subtle', t('Where objectives become issues and move through delivery stages.')),
      sectionFacts(view.tracker, t(view.trackerProvider === 'jira' ? 'Open Jira project' : 'Open GitHub Project')),
      this.providerChoice(),
      ...(this.provider === 'jira' ? this.jiraForm(view) : this.githubTrackerForm(view)),
    ];
  }

  /**
   * The tracker provider radio group.
   *
   * @returns Fieldset.
   */
  private providerChoice(): HTMLFieldSetElement {
    const fieldset = element('fieldset', 'connection-providers');
    fieldset.append(element('legend', '', t('Tracker provider')));
    for (const option of trackerProviders()) {
      const radio = element('input');
      radio.type = 'radio';
      radio.name = 'connection-tracker-provider';
      radio.value = option.id;
      radio.checked = option.id === this.provider;
      radio.dataset['focusKey'] = `connection-provider:${option.id}`;
      radio.addEventListener('change', () => {
        if (!radio.checked) {
          return;
        }

        this.provider = option.id;
        this.render();
      });
      const label = element('label', 'connection-choice');
      label.append(radio, element('span', '', option.label));
      fieldset.append(label);
    }
    return fieldset;
  }

  /**
   * GitHub Project discovery and choices.
   *
   * @param view - Saved connection.
   * @returns Child nodes.
   */
  private githubTrackerForm(view: ConnectionView): HTMLElement[] {
    const draft = this.githubTracker;
    const discover = button(t(draft.choices === null ? 'Discover Projects' : 'Discover again'), {
      cssClass: 'button secondary',
      key: 'connection-tracker-discover',
      action: () => {
        void this.discoverTracker(draft.choices?.owner ?? view.owner, 0);
      },
    });
    discover.disabled = this.isBusy;
    const nodes: HTMLElement[] = [discover];
    const { choices } = draft;
    if (choices === null) {
      return nodes;
    }
    const fields =
      draft.projectId === ''
        ? []
        : [
            choice(
              t('Workflow status field'),
              'connection-field',
              choices.fields.map((field) => [field.id, field.name]),
              {
                value: draft.fieldId,
                change: (fieldId) => {
                  this.githubTracker = { ...draft, fieldId };
                  this.render();
                },
              },
            ),
          ];
    nodes.push(
      ...this.discoveryErrors(choices),
      choice(
        t('Project owner'),
        'connection-owner',
        choices.owners.map((owner) => [owner, owner]),
        {
          value: choices.owner,
          change: (owner) => {
            void this.discoverTracker(owner, 0);
          },
        },
      ),
      choice(
        t('GitHub Project'),
        'connection-project',
        choices.projects.map((project) => [project.id, `#${String(project.number)} ${project.title}`]),
        {
          value: draft.projectId,
          change: (projectId) => {
            const project = choices.projects.find((candidate) => candidate.id === projectId);
            this.githubTracker = { ...draft, projectId, fieldId: '' };
            void this.discoverTracker(choices.owner, project?.number ?? 0);
          },
        },
      ),
      ...fields,
      this.saveControl('tracker', trackerSaveInput(choices, draft.projectId, draft.fieldId), view),
    );
    return nodes;
  }

  /**
   * The Jira Cloud form, findings and admin summary.
   *
   * @param view - Saved connection.
   * @returns Child nodes.
   */
  private jiraForm(view: ConnectionView): HTMLElement[] {
    const { form } = this.jira;
    const edit = (change: Partial<JiraSettings>): void => {
      // Typing keeps the form drawn; a changed value means earlier findings no longer describe it.
      this.jira = { ...this.jira, form: { ...this.jira.form, ...change }, findings: null };
    };
    const fields = element('div', 'connection-fields');
    fields.append(
      textField(t('Jira Cloud site'), 'jira-site', {
        value: form.site,
        input: (site) => {
          edit({ site });
        },
      }),
      textField(t('Project key'), 'jira-key', {
        value: form.projectKey,
        input: (projectKey) => {
          edit({ projectKey });
        },
      }),
      textField(t('Account email'), 'jira-email', {
        value: form.email,
        input: (email) => {
          edit({ email });
        },
      }),
      textField(
        t('Token environment variable'),
        'jira-token-variable',
        {
          value: form.tokenVariable,
          input: (tokenVariable) => {
            edit({ tokenVariable });
          },
        },
        t(
          "Only the variable's name. Set the API token in the environment of the process that runs MALT; it is never typed or shown here.",
        ),
      ),
    );
    const check = button(t('Check Jira project'), {
      cssClass: 'button secondary',
      key: 'jira-check',
      action: () => {
        void this.discoverJira();
      },
    });
    check.disabled = this.isBusy;
    const nodes: HTMLElement[] = [
      element(
        'p',
        'subtle',
        t(
          'MALT can check and save a Jira project as the work tracker. The factory does not deliver through Jira yet, so deliveries still use GitHub or the local hub.',
        ),
      ),
      fields,
      check,
    ];
    const { findings } = this.jira;
    if (findings !== null) {
      nodes.push(this.jiraFindings(findings));
    }
    if (this.jira.access !== null) {
      nodes.push(this.jiraAccess(this.jira.access));
    }
    nodes.push(this.saveControl('tracker', jiraSaveInput(form, findings), view));
    return nodes;
  }

  /**
   * What Jira discovery found.
   *
   * @param findings - Latest discovery.
   * @returns Findings block.
   */
  private jiraFindings(findings: JiraFindings): HTMLElement {
    const block = element('div', 'connection-findings');
    const cssClass = findings.state === 'verified' ? 'state-ok' : 'state-warn';
    block.append(element('h3', '', t('What Jira reported')));
    const state = element('p', 'connection-state');
    state.append(tag(jiraStateLabel(findings.state), findings.state === 'unsupported' ? 'state-bad' : cssClass));
    if (findings.account !== '') {
      state.append(element('span', 'subtle', t('Signed in as {account}', { account: findings.account })));
    }
    block.append(state);
    if (findings.project !== null) {
      block.append(
        element(
          'p',
          '',
          t('{key} · {name} · {count} issue types', {
            key: findings.project.key,
            name: findings.project.name,
            count: findings.issueTypes,
          }),
        ),
      );
    }
    if (findings.missing.length > 0) {
      block.append(element('h4', '', t('Missing Jira permissions')));
      const list = element('ul', 'connection-errors');
      for (const entry of findings.missing) {
        list.append(element('li', '', t('{permission}: {action}', entry)));
      }
      block.append(list);
    }
    const other = findings.problems.filter((problem) => problem.scope !== 'permissions');
    if (other.length > 0) {
      const list = element('ul', 'connection-errors');
      for (const problem of other) {
        list.append(element('li', '', t('{step}: {message}', { step: problem.scope, message: problem.message })));
      }
      block.append(list);
    }
    return block;
  }

  /**
   * The admin summary shown before any Jira write is enabled.
   *
   * @param access - Reads, writes and the current mode.
   * @returns Summary block.
   */
  private jiraAccess(access: JiraAccess): HTMLElement {
    const block = element('div', 'connection-findings');
    block.append(
      element('h3', '', t('What MALT reads and may change in Jira')),
      element('p', '', jiraModeLabel(access.mode)),
      element('h4', '', t('Always read')),
    );
    const reads = element('ul');
    for (const read of access.reads) {
      reads.append(element('li', '', read));
    }
    const table = element('table', 'capability-table');
    const head = element('tr');
    for (const label of [t('Capability'), t('What it changes'), t('Mode')]) {
      const cell = element('th', '', label);
      cell.scope = 'col';
      head.append(cell);
    }
    table.append(element('caption', 'subtle', t('Jira writes and their current policy')), head);
    for (const write of access.writes) {
      const row = element('tr');
      const name = element('th', '', write.capability);
      name.scope = 'row';
      const mode = CAPABILITY_MODES.find((candidate) => candidate === write.mode);
      row.append(
        name,
        element('td', '', write.change),
        element('td', '', mode === undefined ? write.mode : modeLabel(mode)),
      );
      table.append(row);
    }
    const open = button(t('Change on Capabilities'), {
      cssClass: 'button secondary',
      key: 'jira-capabilities',
      action: () => {
        this.hooks.select('capabilities');
      },
    });
    block.append(reads, element('h4', '', t('May change, when enabled')), table, open);
    return block;
  }

  /**
   * The source control section's content.
   *
   * @param view - Saved connection.
   * @returns Child nodes.
   */
  private sourceSection(view: ConnectionView): HTMLElement[] {
    const heading = element('h2', '', t('Source control'));
    heading.id = 'connection-source-heading';
    const provider = sourceProviders().find((option) => option.id === view.sourceProvider);
    const nodes: HTMLElement[] = [
      heading,
      element('p', 'subtle', t('Where branches, pull requests and merges happen.')),
      element('p', '', t('Provider: {provider}', { provider: provider?.label ?? '' })),
    ];
    const setup = button(t('Open Setup & capacity'), {
      cssClass: 'button secondary',
      key: 'connection-setup',
      action: () => {
        this.hooks.select('setup');
      },
    });
    if (view.hub === null) {
      nodes.push(
        sectionFacts(view.source, t('Open repository')),
        ...this.githubSourceForm(view),
        element(
          'p',
          'subtle',
          t(
            'To keep issues, pull requests and merges on this machine, set "delivery": "local" in the factory configuration.',
          ),
        ),
        setup,
      );
      return nodes;
    }
    const { hub } = view;
    // The saved GitHub repository stays available for switching back to GitHub delivery.
    nodes.push(
      element(
        'p',
        '',
        t('Base branch {base} · remote {remote} · {issues} issues · {pulls} pull requests', {
          base: hub.base,
          remote: hub.remote,
          issues: hub.issues,
          pulls: hub.pulls,
        }),
      ),
      element(
        'p',
        'subtle',
        t(
          'The factory delivers through the protected hub on this machine, so nothing leaves it. To deliver through GitHub instead, set "delivery": "github" in the factory configuration.',
        ),
      ),
      setup,
      element('h3', '', t('GitHub repository for GitHub delivery')),
      sectionFacts(view.source, t('Open repository')),
      ...this.githubSourceForm(view),
    );
    return nodes;
  }

  /**
   * GitHub repository discovery and choice.
   *
   * @param view - Saved connection.
   * @returns Child nodes.
   */
  private githubSourceForm(view: ConnectionView): HTMLElement[] {
    const draft = this.githubSource;
    const discover = button(t(draft.choices === null ? 'Discover repositories' : 'Discover again'), {
      cssClass: 'button secondary',
      key: 'connection-source-discover',
      action: () => {
        void this.discoverSource();
      },
    });
    discover.disabled = this.isBusy;
    const { choices } = draft;
    if (choices === null) {
      return [discover];
    }
    return [
      discover,
      ...this.discoveryErrors(choices),
      choice(
        t('Repository'),
        'connection-repository',
        choices.repositories.map((repository) => [repository.id, repository.name]),
        {
          value: draft.repositoryId,
          change: (repositoryId) => {
            this.githubSource = { ...draft, repositoryId };
            this.render();
          },
        },
      ),
      this.saveControl('source', sourceSaveInput(choices, draft.repositoryId), view),
    ];
  }

  /**
   * Per-step discovery errors.
   *
   * @param choices - Latest discovery.
   * @returns Error list, or nothing.
   */
  private discoveryErrors(choices: DiscoveryChoices): HTMLElement[] {
    if (choices.errors.length === 0) {
      return [];
    }
    const list = element('ul', 'connection-errors');
    for (const error of choices.errors) {
      list.append(element('li', '', t('{step}: {message}', { step: error.step, message: error.message })));
    }
    return [list];
  }

  /**
   * A section's Save control. A first save carries both sections, so it is
   * enabled only once the other section has a choice too. The save is built
   * again on click, because typing into the Jira form does not redraw it.
   *
   * @param section - Section this control saves.
   * @param save - This section's save, or `null` until its choices are complete.
   * @param view - Saved connection.
   * @returns Save button and its hint.
   */
  private saveControl(section: 'tracker' | 'source', save: SectionSave | null, view: ConnectionView): HTMLElement {
    const label = t(section === 'tracker' ? 'Save work tracker' : 'Save source control');
    const node = element('div', 'connection-save');
    const control = button(view.isUnsaved ? t('Save both sections') : label, {
      cssClass: 'button',
      key: `connection-save:${section}`,
      action: () => {
        const current = this.chosenSave(section, view.isUnsaved);
        if (current === null) {
          this.status.textContent = t('Choose from discovery again before saving; the choices changed.');
          return;
        }
        void this.save(current);
      },
    });
    control.disabled = save === null || this.chosenSave(section, view.isUnsaved) === null || this.isBusy;
    node.append(control);
    if (view.isUnsaved) {
      node.append(
        element('p', 'subtle', t('The first save needs both sections: choose a tracker and a repository first.')),
      );
    }
    return node;
  }

  /**
   * The save the drafts describe now.
   *
   * @param section - Section whose Save was used.
   * @param isFirst - Whether nothing is saved yet, so both sections are needed.
   * @returns Save, or `null` while a needed choice is missing.
   */
  private chosenSave(section: 'tracker' | 'source', isFirst: boolean): SectionSave | null {
    const tracker = this.pendingTracker();
    const source = this.pendingSource();
    if (isFirst) {
      return tracker === null || source === null ? null : sectionSave(tracker, source);
    }
    return section === 'tracker' ? tracker : source;
  }

  /**
   * The tracker save the drafts describe, for a first save from the source section.
   *
   * @returns Save, or `null` when the tracker choices are incomplete.
   */
  private pendingTracker(): SectionSave | null {
    if (this.provider === 'jira') {
      return jiraSaveInput(this.jira.form, this.jira.findings);
    }
    const { choices, projectId, fieldId } = this.githubTracker;
    return choices === null ? null : trackerSaveInput(choices, projectId, fieldId);
  }

  /**
   * The source save the drafts describe, for a first save from the tracker section.
   *
   * @returns Save, or `null` when no repository is chosen.
   */
  private pendingSource(): SectionSave | null {
    const { choices, repositoryId } = this.githubSource;
    return choices === null ? null : sourceSaveInput(choices, repositoryId);
  }

  /**
   * Run one read or control with the view marked busy.
   *
   * @param message - Progress text announced while it runs.
   * @param work - The read or control; resolves with the text to announce after.
   */
  private async run(message: string, work: () => Promise<string>): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const project = this.scope;
    this.isBusy = true;
    this.status.textContent = message;
    this.render();
    let outcome: string;
    try {
      outcome = await work();
    } catch (error) {
      outcome = t('Not done: {error}', { error: error instanceof Error ? error.message : t('unknown error') });
    }
    this.isBusy = false;
    if (project !== this.hooks.project()) {
      return;
    }
    this.status.textContent = outcome;
    this.render();
  }

  /**
   * Discover an owner's Projects, or one Project's fields.
   *
   * @param owner - Owner to list, or empty for the signed-in account.
   * @param projectNumber - Project to inspect, or zero.
   */
  private async discoverTracker(owner: string, projectNumber: number): Promise<void> {
    const project = this.hooks.project();
    await this.run(t('Discovering GitHub Projects…'), async () => {
      const choices = readDiscovery(await request(discoveryRoute(project, { repository: '', owner, projectNumber })));
      const projectId = projectNumber === 0 ? '' : this.githubTracker.projectId;
      this.githubTracker = { choices, projectId, fieldId: '' };
      return t(choices.errors.length === 0 ? 'Discovery finished.' : 'Discovery finished with problems.');
    });
  }

  /** Discover the repositories the signed-in account can reach. */
  private async discoverSource(): Promise<void> {
    const project = this.hooks.project();
    await this.run(t('Discovering repositories…'), async () => {
      const choices = readDiscovery(
        await request(discoveryRoute(project, { repository: '', owner: '', projectNumber: 0 })),
      );
      this.githubSource = { choices, repositoryId: '' };
      return t(choices.errors.length === 0 ? 'Discovery finished.' : 'Discovery finished with problems.');
    });
  }

  /** Check the Jira form against the site, then read the admin summary. */
  private async discoverJira(): Promise<void> {
    const problem = jiraFormProblem(this.jira.form);
    if (problem !== null) {
      this.status.textContent = problem;
      return;
    }
    const project = this.hooks.project();
    await this.run(t('Checking the Jira project…'), async () => {
      const { operation, input } = jiraDiscoverInput(this.jira.form);
      const answer: { findings: JiraFindings | null } = { findings: null };
      const isDone = await this.hooks.control(operation, input, (result) => {
        answer.findings = readJiraDiscovery(result);
      });
      const access = readJiraAccess(await request(scoped(project, '/api/capabilities')));
      this.jira = { ...this.jira, findings: answer.findings, access };
      return t(isDone && answer.findings !== null ? 'Jira answered.' : 'The check did not run. The notice says why.');
    });
  }

  /**
   * Save one or both sections.
   *
   * @param control - Section save.
   */
  private async save(control: SectionSave): Promise<void> {
    await this.run(t('Saving…'), async () => {
      const isSaved = await this.hooks.control(control.operation, control.input);
      if (isSaved) {
        this.githubTracker = { choices: null, projectId: '', fieldId: '' };
        this.githubSource = { choices: null, repositoryId: '' };
        // The next push redraws with the saved section, which stays unverified until checked.
        this.drawn = '';
      }
      return t(isSaved ? 'Saved. Verify the connection to check it.' : 'Not saved. The notice says why.');
    });
  }

  /** Verify both saved sections. */
  private async verify(): Promise<void> {
    await this.run(t('Verifying…'), async () => {
      const isDone = await this.hooks.control('github_verify', {});
      this.drawn = '';
      return t(isDone ? 'Verified. Each section shows its state.' : 'Not verified. The notice says why.');
    });
  }
}

/**
 * Create the Connections view.
 *
 * @param hooks - Project selection, the operator control path and routing.
 * @returns Stable root and its snapshot update.
 */
export function createConnectionView(hooks: ConnectionHooks): ConsoleViewHandle {
  const view = new ConnectionPanel(hooks);
  return {
    element: view.root,
    update: (snapshot) => {
      view.update(snapshot);
    },
  };
}
