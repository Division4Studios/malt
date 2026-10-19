/**
 * Container entry point: one supervisor and operator boundary in the same filesystem namespace.
 *
 * @file
 */
import { z } from 'zod/v3';

import { startBroker } from './broker.ts';
import { loadConfig, saveBrokerDiscovery } from './config.ts';
import { log } from './log.ts';
import { startWebConsole } from './web/server.ts';

import type { WebConsole } from './web/server.ts';

/** Fixed internal operator listener; publication is separately configured. */
const CONSOLE_PORT = 4318;
/** Highest TCP port. */
const MAX_PORT = 65_535;

/** Published UI port is validated independently of the internal fixed listener. */
const publicPort = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PORT)
  .parse(process.env['AGENTMESH_UI_PORT'] ?? '4318');
/** Both services address the container's actual project-local store. */
const config = { ...loadConfig('/data', { create: true }), url: 'http://127.0.0.1:4317' };
/** Only Compose's explicitly loopback-published ports expose these container listeners. */
const broker = await startBroker(config, { host: '0.0.0.0', port: 4317 });
try {
  saveBrokerDiscovery(config);
} catch (error) {
  await broker.close();
  throw error;
}
/** The console rejects nonloopback browser Host/Origin even with this explicit internal bind. */
let ui: WebConsole;
try {
  ui = await startWebConsole(
    config,
    CONSOLE_PORT,
    { host: '0.0.0.0', publicPort },
    { terminal: broker.operatorTerminalControl, recommendation: broker.operatorRecommendationControl },
  );
} catch (error) {
  await broker.close();
  throw error;
}
process.stdout.write(`${JSON.stringify({ category: 'console', url: ui.url, pairingCode: ui.pairingCode })}\n`);
// Compose detaches stdout; one log record keeps the code findable in `docker compose logs broker`.
log('info', 'console', 'pairing_code', { url: ui.url, pairingCode: ui.pairingCode });
/** Shared shutdown is idempotent and stops only processes owned by this factory. */
const shutdown: { promise?: Promise<void> } = {};
/** Close streaming first, then drain managed assignments and SQLite. */
async function stop(): Promise<void> {
  try {
    shutdown.promise ??= (async (): Promise<void> => {
      await ui.close();
      await broker.close();
    })();
    await shutdown.promise;
  } catch {
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
