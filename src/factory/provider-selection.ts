/** @file Literal native model/effort arguments from one frozen assignment selection. */
import { MeshError } from '../protocol.ts';

import { modelSelectionSchema } from './model-policy.ts';

import type { FactoryConfig, FactoryJob, Provider } from './schema.ts';

/**
 * Native effort override for one CLI family.
 *
 * @param provider - Actual native CLI family.
 * @param effort - Selected supported effort.
 * @returns Literal effort arguments.
 */
function effortArguments(provider: Provider, effort: string): string[] {
  if (provider === 'codex') {
    return ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`];
  }
  return [provider === 'copilot' ? '--reasoning-effort' : '--effort', effort];
}

/**
 * Construct native arguments without shell interpolation or mutable defaults.
 *
 * @param provider - Actual native CLI family.
 * @param model - Explicit model, or an intentionally unknown legacy CLI default.
 * @param effort - Selected supported effort, or verified lack of effort control.
 * @returns Exact argument vector; null effort emits no effort override.
 */
function argumentsFor(provider: Provider, model: string | undefined, effort: string | null): string[] {
  const args = model === undefined ? [] : ['--model', model];
  if (effort !== null) {
    args.push(...effortArguments(provider, effort));
  }
  return args;
}

/**
 * Validate a frozen selection before an adapter can start paid inference.
 * Policy declarations require model-specific evidence; unknown support fails closed.
 * Legacy records preserve their previous behavior, explicitly separate from policy.
 *
 * @param job - Immutable assignment and selected provider.
 * @param settings - Used only for records predating frozen model routing.
 * @returns Literal provider-native selection arguments.
 * @throws {MeshError} For missing, inconsistent or unsupported explicit selections.
 */
export function nativeModelArguments(job: FactoryJob, settings: FactoryConfig): string[] {
  const frozen = job.routing?.selection;
  if (frozen === undefined) {
    if (settings.modelPolicy !== undefined) {
      throw new MeshError(
        'FACTORY_GATED',
        'Explicit policy requires a frozen validated model selection before inference.',
      );
    }
    return legacyArguments(job, settings);
  }
  const { entry, effort } = modelSelectionSchema.parse(frozen);
  if (entry.provider !== job.provider || entry.model !== job.routing?.model || effort !== job.routing.effort) {
    throw new MeshError('FACTORY_GATED', 'Frozen provider/model/effort selection contradicts this assignment.');
  }
  if (entry.effortSupport === 'unknown' || entry.evidence === null) {
    throw new MeshError(
      'FACTORY_GATED',
      'Model-specific effort support is unknown; record supported interface evidence before inference.',
    );
  }
  const isAllowed = effort === null ? entry.effortSupport === 'none' : entry.efforts.includes(effort);
  if (!isAllowed) {
    throw new MeshError('FACTORY_GATED', 'Frozen effort is not allowed by the selected model capability contract.');
  }
  return argumentsFor(job.provider, entry.model, effort);
}

/**
 * Restore pre-policy routing without adopting mutable defaults for routed jobs.
 *
 * @param job - Historical assignment.
 * @param settings - Legacy model configuration.
 * @returns Backward-compatible literal arguments.
 */
function legacyArguments(job: FactoryJob, settings: FactoryConfig): string[] {
  const model = job.routing === undefined ? settings.providers[job.provider].model : (job.routing.model ?? undefined);
  return argumentsFor(job.provider, model, job.routing?.effort ?? 'medium');
}
