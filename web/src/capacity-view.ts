/** @file Subscription-first native capacity panel, with explicit unknown observations. */
import { appendAdmission } from './admission-ui.js';
import { child, numericText, records, text, resourceSummary } from './api.js';
import { appendQuotaWindows, appendProcessUsage, quotaUsage } from './capacity-details.js';
import { phrase, t } from './i18n.js';
import { element } from './worker-ui.js';

import type { Snapshot } from './api.js';
/** Percentage width limit for verified subscription telemetry. */
const PERCENT_MAX = 100;
/** Keep diagnostic token counts distinct from provider billing. */
const CAPACITY_NOTE = phrase(
  'Subscription quota and CPU/memory limits govern dispatch. Reported tokens do not use API credits.',
);

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
  body.append(element('h3', '', t('Subscription limits')));
  for (const capacity of capacities) {
    const item = element('div', 'capacity');
    const heading = element('div', 'capacity-head');
    const provider = text(capacity, 'provider');
    const isEnabled = child(providers, provider)['enabled'] === true;
    const percent = capacity['subscriptionUsedPercent'];
    heading.append(
      element('strong', '', provider.toUpperCase()),
      element('span', 'pill', t(isEnabled ? 'Enabled' : 'Disabled · not eligible for dispatch')),
    );
    item.append(heading);
    if (records(capacity['subscriptionWindows']).length === 0) {
      const usage = quotaUsage(percent);
      item.append(
        element('p', 'capacity-details', t('Legacy summary only: {usage} · window duration unavailable', { usage })),
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
      meter.setAttribute('aria-label', t('{provider} reported subscription usage', { provider }));
      item.append(meter);
    }
    appendQuotaWindows(item, capacity);
    item.append(
      element(
        'p',
        'subtle',
        t('Absolute allowance unavailable. Observations are not a guarantee of remaining capacity.'),
      ),
    );
    body.append(item);
  }
  if (capacities.length === 0) {
    body.append(
      element('p', 'subtle', t('Configure subscription providers and local resource limits in Project setup.')),
    );
  }
  body.append(element('h3', '', t('Diagnostic usage')), element('p', 'subtle', t(CAPACITY_NOTE)));
  for (const capacity of capacities) {
    const usage = t('{provider}: {used} reported tokens · {reserved} estimated tokens in flight', {
      provider: text(capacity, 'provider').toUpperCase(),
      used: numericText(capacity, 'usedTokens'),
      reserved: numericText(capacity, 'reservedTokens'),
    });
    body.append(element('p', 'capacity-details', usage));
  }
  const readings = element('p', 'subtle', resourceSummary(state.factory));
  readings.dataset['resourceMachine'] = 'true';
  body.append(
    element('h3', '', t('Local machine')),
    readings,
    element(
      'p',
      'subtle',
      t('Idle roles consume no model processes. Admission and managed process ceilings protect local resources.'),
    ),
  );
  appendProcessUsage(body, state.factory);
  appendAdmission(body, state.factory);
  return body;
}
