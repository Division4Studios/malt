/**
 * Jira Cloud REST v3 transport. Every request goes to the one configured site,
 * authenticated with the account email and an API token resolved from an
 * operator-supplied credential handle at call time. Reads use `jiraGet`;
 * `jiraSend` performs a mutation and is only called after the capability gate
 * allowed it (see `writes.ts`). Redirects
 * are refused so the token never follows a response to another host, response
 * bodies are bounded, and any message that could carry the token is redacted.
 * Data Center and Server sites are reported unsupported before any request.
 *
 * @file
 */
import { Buffer } from 'node:buffer';

import { z } from 'zod/v3';

import { SecretRedactor } from '../secrets.ts';

/** Jira Cloud sites are always served from an Atlassian subdomain. */
const CLOUD_SUFFIX = '.atlassian.net';
/** Deadline for one discovery request. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Largest response body read; discovery documents are far smaller. */
const RESPONSE_MAX_BYTES = 1_048_576;
/** HTTP statuses the discovery client distinguishes. */
const HTTP = {
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  rateLimited: 429,
} as const;
/** Longest Jira validation message kept in an error. */
const DETAIL_MAX = 300;

/** A Jira project key such as `PROJ`, kept as a typed string. */
export const jiraProjectKeySchema = z.string().regex(/^[A-Z][\dA-Z_]{1,99}$/v);
/** A Jira issue key such as `PROJ-123`, kept as a typed string, never a number. */
export const jiraIssueKeySchema = z.string().regex(/^[A-Z][\dA-Z_]{1,99}-[1-9]\d{0,17}$/v);
/** A Jira project key. */
export type JiraProjectKey = z.output<typeof jiraProjectKeySchema>;
/** A Jira issue key. */
export type JiraIssueKey = z.output<typeof jiraIssueKeySchema>;

/** Where a site is hosted; only Cloud is supported. */
export type JiraDeployment = 'cloud' | 'data-center';

/** A validated site origin. */
export interface JiraSite {
  /** `https://<name>.atlassian.net`, without a path. */
  readonly origin: string;
  /** Cloud, or a self-hosted Data Center/Server site. */
  readonly deployment: JiraDeployment;
}

/** The account email and API token a request authenticates with. */
export interface JiraCredential {
  /** Atlassian account email. */
  readonly email: string;
  /** API token; never stored, logged or returned. */
  readonly token: string;
}

/** Resolves the credential at call time; `null` when the handle is not set. */
export type JiraCredentialSource = () => JiraCredential | null;

/** The response fields the client reads, satisfied by the global `fetch` response. */
export interface JiraResponse {
  /** HTTP status. */
  readonly status: number;
  /** Response headers. */
  readonly headers: { get: (name: string) => string | null };
  /** Body text. */
  readonly text: () => Promise<string>;
}

/** Request options the client sends. */
export interface JiraRequest {
  /** `GET` for reads; `POST` or `PUT` only for capability-checked mutations. */
  readonly method: 'GET' | 'POST' | 'PUT';
  /** JSON body of a mutation. */
  readonly body?: string;
  /** Authorization, Accept and, for mutations, Content-Type headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Per-request deadline. */
  readonly signal: AbortSignal;
  /** Redirects are refused so credentials never reach another host. */
  readonly redirect: 'error';
}

/** Injectable transport; tests pass fixtures, production uses the global `fetch`. */
export type JiraFetch = (url: string, init: JiraRequest) => Promise<JiraResponse>;

/** Why a request did not return a document. */
export type JiraFailure = 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'unreachable' | 'invalid';

/** A failed Jira request, safe to show: it never contains the token. */
export class JiraRequestError extends Error {
  /** Failure kind. */
  public readonly failure: JiraFailure;
  /** Seconds Jira asked to wait, for rate limits. */
  public readonly retryAfterSeconds: number | null;

  /**
   * Describe one failed request.
   *
   * @param message - Redacted explanation.
   * @param options - Failure kind and, for rate limits, the `Retry-After` seconds.
   */
  public constructor(
    message: string,
    options: ErrorOptions & { readonly failure: JiraFailure; readonly retryAfterSeconds?: number | null },
  ) {
    super(message, options);
    this.name = 'JiraRequestError';
    this.failure = options.failure;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/**
 * Validate a site URL. Anything that is not an `https` Atlassian subdomain is
 * treated as a self-hosted Data Center/Server site, which 1.0 does not support.
 *
 * @param raw - Operator-supplied site URL.
 * @returns The site, or `null` when the URL is not an `https` origin without credentials.
 */
export function parseJiraSite(raw: string): JiraSite | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isCloud = host.endsWith(CLOUD_SUFFIX) && host.length > CLOUD_SUFFIX.length && url.port === '';
  return { origin: url.origin, deployment: isCloud ? 'cloud' : 'data-center' };
}

/**
 * A credential source reading the API token from an environment variable, the
 * opaque handle form an operator configures; the value itself is never saved.
 *
 * @param handle - Account email and the name of the variable holding the token.
 * @param handle.email - Atlassian account email.
 * @param handle.tokenVariable - Environment variable name.
 * @param environment - Environment to read; defaults to the process environment.
 * @returns A resolver returning `null` while the variable is unset or empty.
 */
export function environmentCredential(
  handle: { readonly email: string; readonly tokenVariable: string },
  environment: NodeJS.ProcessEnv = process.env,
): JiraCredentialSource {
  return () => {
    const token = environment[handle.tokenVariable];
    return token === undefined || token === '' || handle.email === '' ? null : { email: handle.email, token };
  };
}

/**
 * The global `fetch`, narrowed to the transport seam.
 *
 * @param url - Request URL.
 * @param init - Request options.
 * @returns Its response.
 */
export const globalJiraFetch: JiraFetch = async (url, init) => fetch(url, init);

/** Everything one request needs. */
export interface JiraTransport {
  /** Configured site. */
  readonly site: JiraSite;
  /** Resolved credential. */
  readonly credential: JiraCredential;
  /** Transport. */
  readonly fetch: JiraFetch;
}

/**
 * Remove the token, and its encoded Basic form, from a message.
 *
 * @param credential - Credential in use.
 * @param message - Untrusted text.
 * @returns Text without the token.
 */
export function redactCredential(credential: JiraCredential, message: string): string {
  const redactor = new SecretRedactor([credential.token, basicToken(credential)]);
  return redactor.redact(message);
}

/**
 * The Basic authentication value for a credential.
 *
 * @param credential - Account email and API token.
 * @returns Base64 of `email:token`.
 */
function basicToken(credential: JiraCredential): string {
  const pair = `${credential.email}:${credential.token}`;
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 24 lacks Uint8Array#toBase64; Buffer is its supported encoder.
  return Buffer.from(pair).toString('base64');
}

/** Jira's validation error shape. */
const jiraErrorsSchema = z.object({
  errorMessages: z.array(z.string()).default([]),
  errors: z.record(z.string(), z.string()).default({}),
});

/**
 * Jira's own explanation of a refused request, bounded.
 *
 * @param body - Response body text.
 * @returns Joined messages, or an empty string when Jira gave none.
 */
function jiraDetail(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const errors = jiraErrorsSchema.safeParse(parsed);
  if (!errors.success) {
    return '';
  }
  const fields = Object.entries(errors.data.errors).map(([field, message]) => `${field}: ${message}`);
  return [...errors.data.errorMessages, ...fields].join('; ').slice(0, DETAIL_MAX);
}

/**
 * The failure an HTTP status maps to, or `null` for success.
 *
 * @param response - Jira response.
 * @param path - Requested API path, for the message.
 * @param isRead - Whether the request was a read, for the message.
 * @returns Failure to throw, or `null`.
 */
function statusFailure(response: JiraResponse, path: string, isRead: boolean): JiraRequestError | null {
  switch (response.status) {
    case HTTP.ok:
    case HTTP.created:
    case HTTP.noContent: {
      return null;
    }
    case HTTP.unauthorized: {
      return new JiraRequestError(`Jira rejected the credential for ${path}.`, { failure: 'unauthorized' });
    }
    case HTTP.forbidden: {
      return new JiraRequestError(`The Jira account may not ${isRead ? 'read' : 'change'} ${path}.`, {
        failure: 'forbidden',
      });
    }
    case HTTP.notFound: {
      return new JiraRequestError(`Jira has no ${path} visible to this account.`, { failure: 'not_found' });
    }
    case HTTP.rateLimited: {
      const seconds = Number(response.headers.get('retry-after') ?? NaN);
      return new JiraRequestError(`Jira rate-limited ${path}.`, {
        failure: 'rate_limited',
        retryAfterSeconds: Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null,
      });
    }
    default: {
      return new JiraRequestError(`Jira answered ${path} with HTTP ${String(response.status)}.`, {
        failure: 'unreachable',
      });
    }
  }
}

/** One request to the configured site API. */
interface ApiCall {
  /** HTTP method. */
  readonly method: JiraRequest['method'];
  /** API path beginning with `/rest/api/3/`. */
  readonly path: string;
  /** Query parameters. */
  readonly query?: Readonly<Record<string, string>>;
  /** JSON body of a mutation. */
  readonly body?: unknown;
}

/**
 * Send one request to the configured site API and read its JSON answer.
 *
 * @param transport - Site, credential and transport.
 * @param call - Method, path, query and body.
 * @returns Parsed JSON, or `null` for an empty success.
 * @throws {JiraRequestError} For HTTP errors, unreachable sites, oversized or non-JSON bodies.
 */
async function request(transport: JiraTransport, call: ApiCall): Promise<unknown> {
  const url = new URL(call.path, transport.site.origin);
  if (call.query !== undefined) {
    const entries = Object.entries(call.query);
    for (const [key, value] of entries) {
      url.searchParams.set(key, value);
    }
  }
  if (url.origin !== transport.site.origin || !url.pathname.startsWith('/rest/api/3/')) {
    throw new JiraRequestError('Refused a Jira request outside the configured site API.', { failure: 'invalid' });
  }
  const { credential } = transport;
  const hasBody = call.body !== undefined;
  let response: JiraResponse;
  try {
    response = await transport.fetch(url.href, {
      method: call.method,
      headers: {
        authorization: `Basic ${basicToken(credential)}`,
        accept: 'application/json',
        ...(hasBody && { 'content-type': 'application/json' }),
      },
      ...(hasBody && { body: JSON.stringify(call.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    const detail = Error.isError(error) ? error.message : 'request failed';
    throw new JiraRequestError(redactCredential(credential, `Could not reach Jira: ${detail}`), {
      failure: 'unreachable',
    });
  }
  return readAnswer(transport, response, { method: call.method, path: url.pathname });
}

/**
 * Check a response and parse its body.
 *
 * @param transport - Site and credential, for redaction.
 * @param response - Jira response.
 * @param call - Method and path, for messages.
 * @param call.method - HTTP method.
 * @param call.path - Requested API path.
 * @returns Parsed JSON, or `null` for an empty success.
 * @throws {JiraRequestError} For HTTP errors, oversized or non-JSON bodies.
 */
async function readAnswer(
  transport: JiraTransport,
  response: JiraResponse,
  call: { readonly method: JiraRequest['method']; readonly path: string },
): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body) > RESPONSE_MAX_BYTES) {
    throw new JiraRequestError(`Jira returned an oversized document for ${call.path}.`, { failure: 'invalid' });
  }
  if (response.status === HTTP.badRequest) {
    const detail = redactCredential(transport.credential, jiraDetail(body));
    const suffix = detail === '' ? '.' : `: ${detail}`;
    throw new JiraRequestError(`Jira refused ${call.method} ${call.path}${suffix}`, { failure: 'invalid' });
  }
  const failure = statusFailure(response, call.path, call.method === 'GET');
  if (failure !== null) {
    throw failure;
  }
  if (body.trim() === '' && call.method !== 'GET') {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new JiraRequestError(`Jira did not return JSON for ${call.path}.`, { failure: 'invalid' });
  }
}

/**
 * Read one JSON document with a `GET` to the configured site.
 *
 * @param transport - Site, credential and transport.
 * @param path - API path beginning with `/rest/api/3/`.
 * @param query - Query parameters.
 * @returns Parsed JSON.
 * @throws {JiraRequestError} For HTTP errors, unreachable sites, oversized or non-JSON bodies.
 */
export async function jiraGet(
  transport: JiraTransport,
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  return request(transport, { method: 'GET', path, query });
}

/**
 * Perform one mutation. Callers authorize it with the capability gate first.
 *
 * @param transport - Site, credential and transport.
 * @param method - `POST` or `PUT`.
 * @param path - API path beginning with `/rest/api/3/`.
 * @param body - JSON body.
 * @returns Parsed JSON answer, or `null` when Jira answered with no body.
 * @throws {JiraRequestError} For HTTP errors, including Jira's own validation messages.
 */
export async function jiraSend(
  transport: JiraTransport,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<unknown> {
  return request(transport, { method, path, body });
}
