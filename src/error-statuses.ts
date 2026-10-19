/**
 * The closed table of MALT error codes and their HTTP statuses, which
 * {@link MeshError} in `protocol.ts` carries across the HTTP boundary.
 * Like the protocol, it has no runtime dependencies on other project modules.
 *
 * @file
 */

/**
 * Every error code MALT can produce, mapped to its HTTP status.
 *
 * Keeping codes in one closed table means a misspelt code is a compile-time
 * error, and the HTTP status of each failure is defined in exactly one place.
 * Status 499 follows the common "client closed request" convention.
 */
export const ERROR_STATUSES = {
  AGENT_ACTIVE: 409,
  AGENT_LEFT: 410,
  ALREADY_JOINED: 409,
  BROKER_STOPPING: 503,
  BROKER_UNAVAILABLE: 503,
  CAPABILITY_DENIED: 403,
  CREDENTIALS_MISSING: 409,
  CLIENT_CLOSED: 400,
  CONTENT_TYPE: 415,
  FORBIDDEN_ORIGIN: 403,
  FACTORY_GATED: 409,
  GITHUB_UNAVAILABLE: 503,
  GITHUB_NOT_CONNECTED: 409,
  GITHUB_OPERATION_PENDING: 409,
  HTTP_ERROR: 502,
  HUMAN_CONTROL_REQUIRED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  IDENTITY_CONFLICT: 409,
  IDLE_NOT_APPROVED: 409,
  INSTRUCTIONS_REQUIRED: 400,
  INTERNAL: 500,
  INVALID_INPUT: 400,
  INVALID_JSON: 400,
  INVALID_REQUEST: 400,
  INVALID_REVISION: 400,
  LEAD_ACTIVE: 409,
  NO_WORKSPACE: 400,
  WORKSPACE_UNAVAILABLE: 400,
  NOT_A_WORKER: 400,
  NOT_FOUND: 404,
  NOT_JOINED: 409,
  NOT_ORCHESTRATOR: 403,
  STALE_CHECKIN: 409,
  TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  UNAUTHORIZED_AGENT: 401,
  RATE_LIMITED: 429,
  TOOL_DENIED: 403,
  UNKNOWN_OPERATION: 404,
  UNKNOWN_TEAM: 404,
  UNREAD_MESSAGES: 409,
  WAIT_ALREADY_ACTIVE: 409,
  WAIT_CANCELLED: 499,
  WAIT_SUPERSEDED: 409,
  WRONG_PROJECT: 403,
} as const satisfies Readonly<Record<string, number>>;
