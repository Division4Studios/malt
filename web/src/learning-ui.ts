/**
 * Focused human learning comparisons and explicit source-maintenance handoffs.
 *
 * @file
 */
import { child, text } from './api.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Safe editor configuration; mutations remain owned by the main controller. */
export interface LearningDialog {
  /** Plain text and optional exact proposal comparison. */
  readonly description: { title: string; explanation: string; initial: string; evidence?: string };
  /** Explicit existing backend operation and input conversion. */
  readonly action: { operation: string; input: (body: string) => unknown };
}

/**
 * Present an exact immutable skill comparison without HTML rendering.
 *
 * @param proposal - Authenticated scoped comparison.
 * @param requestId - Exact proposal identity.
 * @param shouldApprove - Operator's selected decision.
 * @returns Native editor configuration with an explicit rationale.
 */
export function skillDialog(proposal: Data, requestId: string, shouldApprove: boolean): LearningDialog {
  const candidate = child(proposal, 'candidate');
  const review = child(candidate, 'review');
  return {
    description: {
      title: `${shouldApprove ? 'Approve' : 'Reject'} skill ${text(candidate, 'name')}`,
      explanation: t(
        'Compare the current and proposed instructions below. Enter your rationale. This decision applies only to this project and this exact revision.',
      ),
      initial: '',
      evidence: `CURRENT\n${text(proposal, 'current')}\n\nPROPOSED\n${text(candidate, 'skill')}\n\nREVIEW\n${JSON.stringify(review, null, 2)}`,
    },
    action: { operation: 'factory_skill_decide', input: (reason) => ({ requestId, approve: shouldApprove, reason }) },
  };
}

/**
 * Require the operator to select a separate source project explicitly.
 *
 * @param requestId - Previously approved exact proposal.
 * @returns Scoped handoff editor; never automatically deploys or enables work.
 */
export function maintenanceDialog(requestId: string): LearningDialog {
  return {
    description: {
      title: t('Queue a reusable factory improvement'),
      explanation: t(
        'Enter the absolute MALT source repository folder. This transfers the exact approved skill adaptation to its own product owner and lead, with normal implementation and review gates. No board, deployment or process restart is created by this control.',
      ),
      initial: '',
    },
    action: {
      operation: 'factory_export_maintenance',
      input: (workspace) => ({ requestId, workspace: workspace.trim() }),
    },
  };
}

/**
 * Render bounded reviewed source handoffs; all untrusted names remain plain text.
 *
 * @param requests - Actual project proposal history.
 * @param action - Explicit controller operation.
 * @returns Native keyboard-accessible source maintenance choices.
 */
export function maintenancePanel(requests: readonly Data[], action: (id: string) => void): HTMLElement {
  const body = document.createElement('div');
  body.classList.add('panel-body');
  const explanation = document.createElement('p');
  explanation.classList.add('subtle');
  explanation.textContent = t(
    'Approved lessons can become separately reviewed MALT source work. Its factory needs its own setup; this never hot-patches the running daemon.',
  );
  body.append(explanation);
  for (const request of requests) {
    if (text(request, 'status') !== 'approved') {
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('small-button');
    button.textContent = t('Queue source improvement: {name}', { name: text(request, 'name') });
    button.addEventListener('click', () => {
      action(text(request, 'id'));
    });
    body.append(button);
  }
  return body;
}

/**
 * Surface preserved local edits without replacing human-owned guidance.
 *
 * @param sources - Safe research panel.
 * @param learning - Authenticated project metadata.
 */
export function appendBaselineWarning(sources: HTMLElement, learning: Data): void {
  if (Array.isArray(learning['baselineConflicts']) && learning['baselineConflicts'].length > 0) {
    sources.append(
      element(
        'p',
        'error',
        t(
          'Local baseline edits were preserved. Inspect .malt/skills/builtin-index.json conflicts and submit a reviewed project override before replacing them.',
        ),
      ),
    );
  }
}
