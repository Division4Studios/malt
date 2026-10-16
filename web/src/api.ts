/**
 * Dependency-free browser contract validation and authenticated local requests.
 *
 * @file
 */

/** Finite observation deadline; controls are never automatically retried. */
const READ_TIMEOUT_MS = 15_000;

/**
 * Read uncached older Activity through the paired local boundary.
 *
 * @param project - Selected public project ID.
 * @param before - Exclusive durable sequence.
 * @param limit - Bounded page size.
 * @returns Untrusted response, validated transactionally by ActivityHistory.
 */
export async function activityHistory(project: string, before: number, limit: number): Promise<unknown> {
  return await request(`${scoped(project, '/api/history')}&before=${String(before)}&limit=${String(limit)}`);
}
/** Validated plain JSON object. */
export type Data = Record<string, unknown>;

/**
 * Reject malformed server boundaries rather than casting untrusted JSON.
 *
 * @param value - Untrusted decoded response.
 * @returns Validated plain object.
 * @throws {Error} For malformed input.
 */
export function data(value: unknown): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local service response.');
  }
  return Object.fromEntries(Object.entries(value));
}

/**
 * Read a required string field safely.
 *
 * @param value - Validated object.
 * @param key - Expected field.
 * @returns Actual string, or a clear empty display fallback.
 */
export function text(value: Data, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

/**
 * Display an explicit fallback for an unavailable string value.
 *
 * @param value - Actual display text.
 * @param fallback - Clear empty-state wording.
 * @returns Actual text or the supplied fallback.
 */
export function displayText(value: string, fallback: string): string {
  return value === '' ? fallback : value;
}

/**
 * Choose the first available plain-text display field.
 *
 * @param values - Ordered fallbacks.
 * @returns First nonempty value, or an empty display.
 */
export function firstText(...values: readonly string[]): string {
  return values.find((value) => value !== '') ?? '';
}

/**
 * Format a finite validated count without nested rendering expressions.
 *
 * @param value - Validated record.
 * @param key - Count field.
 * @returns Plain decimal text.
 */
export function numericText(value: Data, key: string): string {
  return String(number(value, key));
}

/**
 * Read a finite numeric field safely.
 *
 * @param value - Validated object.
 * @param key - Expected field.
 * @returns Finite value, or zero for an unavailable count.
 */
export function number(value: Data, key: string): number {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
}

/**
 * Read a boolean state without treating arbitrary values as true.
 *
 * @param value - Validated object.
 * @param key - Expected field.
 * @returns Actual affirmative state.
 */
export function hasFlag(value: Data, key: string): boolean {
  return value[key] === true;
}

/**
 * Decode an object collection; reject malformed members at the boundary.
 *
 * @param value - Untrusted collection.
 * @returns Validated records.
 */
export function records(value: unknown): Data[] {
  return Array.isArray(value) ? value.map((item) => data(item)) : [];
}

/**
 * Read one typed object field with an explicit empty-state fallback.
 *
 * @param value - Validated parent.
 * @param key - Field name.
 * @returns Validated child record.
 */
export function child(value: Data, key: string): Data {
  const field = value[key];
  return field === null || field === undefined ? {} : data(field);
}

/**
 * Format actual readings with an explicit unknown CPU state.
 *
 * @param factory - Validated factory snapshot.
 * @returns Plain resource telemetry without changing UI controls.
 */
export function resourceSummary(factory: Data): string {
  const resources = child(factory, 'resources');
  const free = Math.round(number(resources, 'freeMemoryMb'));
  const measured = Math.round(number(resources, 'cpuPercent'));
  const cpu = resources['cpuPercent'] === null ? 'sampling' : `${String(measured)}%`;
  return `${String(free)} MiB free memory · CPU ${cpu}`;
}
/** State delivered by the authenticated local broker gateway. */
export interface Snapshot {
  /** Current target metadata. */
  readonly project: Data;
  /** Actual factory lifecycle. */
  readonly factory: Data;
  /** Real recent event history. */
  readonly events: Data[];
  /** Saved project GitHub connection. */
  readonly github: Data;
  /** Reviewed project learning state. */
  readonly learning: Data;
  /** Local delivery ledger summary, null when the project delivers through GitHub. */
  readonly local: Data | null;
  /** Delivery manager status and mission brief, null before configuration. */
  readonly manager: Data | null;
  /** Observation timestamp. */
  readonly observedAt: number;
}

/**
 * Validate a live snapshot before updating the UI.
 *
 * @param value - Decoded server response.
 * @returns Bounded project state.
 * @throws {Error} For inconsistent boundary types.
 */
export function snapshot(value: unknown): Snapshot {
  const root = data(value);
  const factory = child(root, 'factory');
  if (typeof factory['active'] !== 'boolean' || typeof factory['configured'] !== 'boolean') {
    throw new TypeError('Invalid factory state.');
  }
  for (const key of ['jobs', 'tasks', 'features', 'capacities']) {
    if (!Array.isArray(factory[key])) {
      throw new TypeError('Incomplete factory snapshot.');
    }
    records(factory[key]);
  }
  return {
    project: child(root, 'project'),
    factory,
    events: records(child(root, 'events')['events']),
    github: child(root, 'github'),
    learning: child(root, 'learning'),
    local: root['local'] === null || root['local'] === undefined ? null : child(root, 'local'),
    manager: root['manager'] === null || root['manager'] === undefined ? null : child(root, 'manager'),
    observedAt: number(root, 'observedAt'),
  };
}
/** Authenticated API failures carry a status so the app can return to pairing. */
export class LocalRequestError extends Error {
  /** Actual HTTP status. */
  public readonly status: number;

  /**
   * Construct a user-readable local service failure.
   *
   * @param message - Validated error text.
   * @param options - HTTP status metadata.
   */
  public constructor(message: string, options: ErrorOptions & { status: number }) {
    super(message, options);
    this.name = 'LocalRequestError';
    this.status = options.status;
  }
}

/**
 * Request local state or apply one explicit control; no automatic mutation replay.
 *
 * @param route - Fixed app API route.
 * @param input - Optional mutation input.
 * @returns Decoded JSON for the caller's boundary validator.
 * @throws {LocalRequestError} When authorization, validation or broker access fails.
 */
export async function request(route: string, input?: unknown): Promise<unknown> {
  const response = await fetch(
    route,
    input === undefined
      ? { cache: 'no-store', signal: AbortSignal.timeout(READ_TIMEOUT_MS) }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          cache: 'no-store',
        },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = displayText(text(data(result), 'error'), 'Local service request failed.');
    throw new LocalRequestError(message, { status: response.status });
  }
  return result;
}

/**
 * Select a project through a public scope identifier, never a bearer token.
 *
 * @param project - Public selected project ID.
 * @param route - Fixed API route.
 * @returns Same-origin API path.
 */
export function scoped(project: string, route: string): string {
  return `${route}?project=${encodeURIComponent(project)}`;
}

/** Controller callbacks keep mutation state independent of DOM rendering. */
export interface ControlHooks {
  /** Current project and connectivity, sampled before each explicit control. */
  scope: () => { project: string; isReady: boolean };
  /** Explicit project selection. */
  openProject: (workspace: string) => Promise<void>;
  /** Read authoritative state without replaying a mutation. */
  refresh: () => Promise<void>;
  /** Accessible operator feedback, scoped to the initiating project. */
  notice: (message: string, isSuccess?: boolean) => void;
}

/**
 * Create one single-flight controller; offline and late-project controls never replay.
 *
 * @param hooks - Current controller state and read-only refresh callbacks.
 * @returns An explicit validated-backend control sender.
 */
export function createOperatorControl(hooks: ControlHooks): (operation: string, input: unknown) => Promise<boolean> {
  const pending = new Set<string>();
  return async (operation, input) => {
    const { project, isReady } = hooks.scope();
    if (!isReady || pending.size > 0) {
      return false;
    }
    pending.add(operation);
    try {
      return await canApplyOperatorControl(hooks, project, operation, input);
    } catch (error) {
      if (project === hooks.scope().project) {
        hooks.notice(error instanceof Error ? error.message : 'The control could not be applied.');
        if (operation === 'factory_queue') {
          await hooks.refresh();
        }
      }
      return false;
    } finally {
      pending.delete(operation);
    }
  };
}

/**
 * Apply one captured project mutation and fence its eventual feedback.
 *
 * @param hooks - Operator state callbacks.
 * @param project - Initiating public project ID.
 * @param operation - Explicit backend operation.
 * @param input - Untrusted payload validated by the server.
 * @returns Whether the operation succeeded in its intended scope.
 */
async function canApplyOperatorControl(
  hooks: ControlHooks,
  project: string,
  operation: string,
  input: unknown,
): Promise<boolean> {
  if (operation === 'open-project' && typeof input === 'string') {
    await hooks.openProject(input);
    return true;
  }
  await request(scoped(project, '/api/control'), { operation, input });
  if (project !== hooks.scope().project) {
    return false;
  }
  hooks.notice('Saved to project memory. The factory will coordinate the next safe step.', true);
  await hooks.refresh();
  return true;
}
