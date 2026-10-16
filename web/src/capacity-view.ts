/** @file Subscription-first native capacity panel, with explicit unknown observations. */
import { child, numericText, records, text, resourceSummary } from './api.js';
import { appendQuotaWindows, appendProcessUsage, quotaUsage } from './capacity-details.js';
import { element } from './worker-ui.js';

import type { Snapshot } from './api.js';
/** Percentage width limit for verified subscription telemetry. */
const PERCENT_MAX = 100;
/** Keep diagnostic token counts distinct from provider billing. */
const CAPACITY_NOTE =
  'Subscription quota and CPU/memory limits govern dispatch. Reported tokens do not use API credits.';

/**
 * Real provider usage with unknown quota represented explicitly.
 *
 * @param state - Factory and resource evidence.
 * @returns Provider and machine capacity panel contents.
 */
export function capacityView(state: Snapshot): HTMLElement {
  const body = element('div', 'panel-body');
  const capacities = records(state.factory['capacities']);
  const providers = child(child(state.factory, 'settings'), 'providers');
  body.append(element('h3', '', 'Subscription limits'));
  for (const capacity of capacities) {
    const item = element('div', 'capacity');
    const heading = element('div', 'capacity-head');
    const provider = text(capacity, 'provider');
    const isEnabled = child(providers, provider)['enabled'] === true;
    const percent = capacity['subscriptionUsedPercent'];
    heading.append(
      element('strong', '', provider.toUpperCase()),
      element('span', 'pill', isEnabled ? 'Enabled' : 'Disabled · not eligible for dispatch'),
    );
    item.append(heading);
    if (records(capacity['subscriptionWindows']).length === 0) {
      item.append(
        element('p', 'capacity-details', `Legacy summary only: ${quotaUsage(percent)} · window duration unavailable`),
      );
    }
    if (
      isEnabled &&
      typeof percent === 'number' &&
      Number.isFinite(percent) &&
      percent >= 0 &&
      percent <= PERCENT_MAX
    ) {
      const meter = element('meter');
      meter.min = 0;
      meter.max = PERCENT_MAX;
      meter.value = percent;
      meter.setAttribute('aria-label', `${provider} reported subscription usage`);
      item.append(meter);
    }
    appendQuotaWindows(item, capacity);
    item.append(
      element('p', 'subtle', 'Absolute allowance unavailable. Observations are not a guarantee of remaining capacity.'),
    );
    body.append(item);
  }
  if (capacities.length === 0) {
    body.append(element('p', 'subtle', 'Configure subscription providers and local resource limits in Project setup.'));
  }
  body.append(element('h3', '', 'Diagnostic usage'), element('p', 'subtle', CAPACITY_NOTE));
  for (const capacity of capacities) {
    body.append(
      element(
        'p',
        'capacity-details',
        `${text(capacity, 'provider').toUpperCase()}: ${numericText(capacity, 'usedTokens')} reported tokens · ${numericText(capacity, 'reservedTokens')} estimated tokens in flight`,
      ),
    );
  }
  const readings = element('p', 'subtle', resourceSummary(state.factory));
  readings.dataset['resourceMachine'] = 'true';
  body.append(
    element('h3', '', 'Local machine'),
    readings,
    element(
      'p',
      'subtle',
      'Idle roles consume no model processes. Admission and managed process ceilings protect local resources.',
    ),
  );
  appendProcessUsage(body, state.factory);
  return body;
}
