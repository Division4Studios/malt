/**
 * The only application logging sink. stdout belongs to the MCP protocol (or a
 * CLI JSON response), so diagnostics MUST use stderr, including in Docker.
 * Callers pass deliberately selected metadata, never RPC envelopes, credentials,
 * message bodies, work instructions, or whole error objects.
 *
 * Levels are evaluated on each call so --verbose can be applied by the CLI
 * after ES modules have loaded. AGENTMESH_LOG_LEVEL=silent is useful in tests.
 */
const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
export function log(level, category, event, fields = {}) {
  const minimum = levels[process.env.AGENTMESH_LOG_LEVEL ?? 'info'] ?? levels.info;
  if (levels[level] < minimum) return;
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, category, event, ...fields }));
}
