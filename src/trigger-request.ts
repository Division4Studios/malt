/**
 * Read a loopback webhook trigger request: its path, the secret it presents
 * and the payload it carries. The broker fires the trigger with the result.
 *
 * @file
 */
import type { fireTrigger } from './factory/automations.ts';
import type { IncomingHttpHeaders } from 'node:http';

/** Loopback webhook path: `/triggers/<trigger id>`. */
export const TRIGGER_PATH = /^\/triggers\/(?<id>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/v;
/** Authorization scheme a trigger secret is presented with. */
const BEARER = 'Bearer ';

/**
 * The fire call a webhook request presents.
 *
 * @param headers - Request headers: `Authorization: Bearer <secret>` and an optional `Idempotency-Key`.
 * @param body - Parsed JSON body; an empty object carries no payload.
 * @param id - Trigger id from the path.
 * @returns Trigger id, presented secret, idempotency key and payload text.
 */
export function triggerCall(
  headers: IncomingHttpHeaders,
  body: unknown,
  id: string,
): Parameters<typeof fireTrigger>[1] {
  const authorization = headers.authorization ?? '';
  const key = headers['idempotency-key'];
  const isEmpty = typeof body === 'object' && body !== null && Object.keys(body).length === 0;
  return {
    id,
    secret: authorization.startsWith(BEARER) ? authorization.slice(BEARER.length) : '',
    idempotencyKey: typeof key === 'string' ? key : null,
    payload: isEmpty ? '' : JSON.stringify(body, null, 2),
  };
}
