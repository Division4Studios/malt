/** @file Colocated native startup keeps terminal authority exclusively in process memory. */
import { startBroker } from '../broker.ts';
import { saveBrokerDiscovery } from '../config.ts';

import { startWebConsole } from './server.ts';

import type { WebConsole } from './server.ts';
import type { MeshConfig } from '../config.ts';

/**
 * Own the broker and paired console together, or attach a console without terminal authority.
 *
 * @param config - Explicit target project.
 * @param port - Validated local console port.
 * @param shouldOwnBroker - Explicit native startup choice.
 * @returns Console with ordered, idempotent owned shutdown.
 * @throws {Error} If the broker/UI bind or discovery write fails.
 */
export async function startNativeConsole(
  config: MeshConfig,
  port: number,
  shouldOwnBroker: boolean,
): Promise<WebConsole> {
  if (!shouldOwnBroker) {
    return startWebConsole(config, port);
  }
  const broker = await startBroker(config);
  try {
    const url = new URL(config.url);
    url.port = String(broker.port);
    const selected = { ...config, url: url.origin };
    saveBrokerDiscovery(selected);
    const ui = await startWebConsole(selected, port, undefined, {
      terminal: broker.operatorTerminalControl,
      recommendation: broker.operatorRecommendationControl,
    });
    let closing: Promise<void> | undefined;
    return {
      ...ui,
      close: async () => {
        closing ??= (async (): Promise<void> => {
          try {
            await ui.close();
          } finally {
            await broker.close();
          }
        })();
        await closing;
      },
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}
