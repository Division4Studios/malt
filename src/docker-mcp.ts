/**
 * Host-side launcher for an MCP bridge inside the Docker broker container.
 *
 * An MCP host starts a stdio server in the folder of the session that uses
 * it, but `docker compose exec` runs the bridge inside the container, where
 * that folder is invisible. Hosts that report MCP roots (Claude Code) tell the
 * bridge the folder anyway; others (Codex) do not. This launcher runs on the
 * host, reads its working directory, and starts the bridge in the container
 * with `AGENTMESH_WORKSPACE` set to it, so a nameless session joins the team
 * of the folder it was started in. Reported MCP roots still take precedence.
 *
 * Use it as the MCP server command, passing `agentmesh mcp` options through,
 * as in this example.
 *
 * ```text
 * node /absolute/path/to/agent-mesh/src/docker-mcp.ts --provider openai --runtime codex-cli
 * ```
 *
 * It uses the Compose file of this repository; `COMPOSE_PROJECT_NAME`
 * selects another Compose project as usual. Standard streams pass straight
 * through, so the MCP stream and the bridge's diagnostics are untouched.
 *
 * @file
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

/** The Compose file of this repository. */
const COMPOSE_FILE = path.resolve(import.meta.dirname, '..', 'compose.yaml');

const child = spawn(
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Like any MCP server command, docker is found on the user's own PATH.
  'docker',
  [
    'compose',
    '-f',
    COMPOSE_FILE,
    'exec',
    '-T',
    '-e',
    `AGENTMESH_WORKSPACE=${process.cwd()}`,
    'broker',
    'node',
    'src/cli.ts',
    'mcp',
    '--project',
    '/data',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', windowsHide: true },
);

child.once('error', (error) => {
  process.stderr.write(`ERROR: Cannot start docker: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', () => {
  // A child ended by a signal reports no exit code; treat that as a failure.
  process.exitCode = child.exitCode ?? 1;
});
// Normally the host simply closes stdin; forward explicit termination too.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
