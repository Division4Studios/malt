import { z } from 'zod';

export const states = ['STARTING', 'IDLE', 'WORKING', 'WAITING', 'BLOCKED', 'REVIEWING', 'NEEDS_INPUT', 'OFFLINE', 'FAILED', 'STOPPED'];
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const short = z.string().max(500);
const body = z.string().min(1).max(32000);
const id = z.string().min(1).max(100);
const page = { limit: z.number().int().min(1).max(100).default(50), after: z.number().int().min(0).default(0) };
// Schemas are shared by HTTP validation and MCP tool discovery. The broker is
// the authority: callers cannot bypass bounds by avoiding the MCP bridge.
export const schemas = {
  register: z.object({ name, secret: z.string().min(32).max(128), sessionId: z.string().uuid(), provider: z.string().min(1).max(64), runtime: z.string().min(1).max(64), role: z.string().min(1).max(64).default('generalist') }).strict(),
  whoami: z.object({}).strict(),
  heartbeat: z.object({}).strict(),
  disconnect: z.object({}).strict(),
  list_agents: z.object({ status: z.enum(states).optional() }).strict(),
  team_status: z.object({}).strict(),
  set_status: z.object({ status: z.enum(states), text: short.default('') }).strict(),
  send_message: z.object({ to: id, body, type: z.enum(['direct', 'task', 'handoff', 'question', 'blocker', 'review_request']).default('direct'), taskId: id.optional(), handoff: z.object({ task: short, result: body, filesChanged: z.array(short).max(100).default([]), commits: z.array(short).max(100).default([]), tests: z.array(short).max(100).default([]), knownIssues: z.array(short).max(100).default([]), nextAction: short.optional() }).strict().optional() }).strict(),
  broadcast: z.object({ body }).strict(),
  get_messages: z.object({ ...page, unreadOnly: z.boolean().default(true) }).strict(),
  ack_message: z.object({ id }).strict(),
  reply: z.object({ id, body }).strict(),
  events: z.object(page).strict(),
  set_lead: z.object({ agent: id }).strict(),
  check_in: z.object({ summary: z.string().min(1).max(4000) }).strict(),
  work_status: z.object({}).strict(),
  list_check_ins: z.object({}).strict(),
  answer_check_in: z.object({ requestId: id, decision: z.enum(['work', 'idle']), instructions: body.optional(), reason: short.optional() }).strict(),
  wait_for_work: z.object({ timeoutMs: z.number().int().min(0).max(25000).default(20000), afterRevision: z.number().int().min(0).optional() }).strict(),
};

// hold belongs to the MCP facade, not the HTTP protocol. The bridge renews
// bounded HTTP waits internally so empty timeout responses do not wake a model.
export const mcpWaitSchema = schemas.wait_for_work.extend({ hold: z.boolean().default(true) });

export class MeshError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export const toolDescriptions = {
  whoami: 'Inspect your persistent Agent Mesh identity.',
  list_agents: 'Discover peers in this project, optionally filtered by presence.',
  team_status: 'Get compact team counts and blocked agent summaries.',
  set_status: 'Update your presence and short progress description.',
  send_message: 'Send a durable message to a peer by name or ID. Handoffs may include structured results.',
  broadcast: 'Send a durable message to every other registered peer, including offline peers.',
  get_messages: 'Read your inbox without acknowledging messages. Paginate using nextCursor; default is unread only.',
  ack_message: 'Acknowledge a message after you have processed it. Safe to repeat.',
  reply: 'Reply to a message in your inbox. The original remains unread until explicitly acknowledged.',
  check_in: 'After finishing work and acknowledging your inbox, ask the orchestrator for more work. Repeating a pending check-in is safe. Only an explicit idle decision permits idle; silence never does.',
  work_status: 'Inspect your durable work request, assigned instructions, idle permission and orchestrator. This does not finish work.',
  list_check_ins: 'For the designated orchestrator: list workers waiting for a work or idle decision.',
  answer_check_in: 'For the designated orchestrator: assign work with instructions, or explicitly approve idle for the exact pending requestId. Resolves the check-in notification.',
  wait_for_work: 'Keep this tool call open until a message, assignment or idle decision arrives. By default hold=true renews bounded HTTP waits internally without waking the model on empty timeouts; configure a long host tool timeout. hold=false returns after one bounded wait (timeoutMs defaults to 20000, max 25000). Silence never grants idle. Cannot restart an already-ended model turn.',
};
