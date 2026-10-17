/**
 * Read-only operator conversation windows, separate from agent inbox acknowledgements.
 *
 * @file
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { loadIdentity } from '../config.ts';
import { selectAll, messageRowSchema } from '../database.ts';
import { SecretRedactor } from '../secrets.ts';

import { credentialValues } from './authentication.ts';
import { FACTORY_ROLES } from './schema.ts';

import type { MeshConfig } from '../config.ts';
import type { Store } from '../store.ts';

/** Bounded live window; complete message history remains in project SQLite. */
const MESSAGE_WINDOW = 40;
/** Keep operator streams bounded while preserving full broker inbox history. */
const PREVIEW_MAX = 4000;
/** Largest Unicode point represented by one UTF-16 unit. */
const SINGLE_UNIT_MAX = 65_535;
/** Read-only peer names are joined without exposing credential columns. */
export const conversationSchema = messageRowSchema.extend({
  sender_name: z.string(),
  recipient_name: z.string(),
  truncated: z.boolean().default(false),
});

/**
 * Collect only already existing managed identity secrets for literal output redaction.
 *
 * @param mesh - Selected project; no identity is created by inspection.
 * @returns Backend-only known values, never returned to the browser.
 */
function messageSecrets(mesh: MeshConfig): string[] {
  const values = [mesh.token, ...credentialValues(process.env)];
  for (const role of FACTORY_ROLES) {
    const name = `factory-${role}`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only fixed logical role identity names under this selected project's private directory.
    if (existsSync(path.join(mesh.directory, 'identities', `${name}.json`))) {
      values.push(loadIdentity(mesh, name).secret);
    }
  }
  return values;
}

/**
 * Share known-secret filtering with other read-only operator projections.
 *
 * @param mesh - Selected project; inspection creates no identity.
 * @returns Backend-only redactor.
 */
export function conversationRedactor(mesh: MeshConfig): SecretRedactor {
  return new SecretRedactor(messageSecrets(mesh));
}

/**
 * Bound redacted text without splitting an astral character.
 *
 * @param value - Already redacted prose.
 * @returns At most the existing preview limit of UTF-16 units.
 */
function excerpt(value: string): string {
  const end = (value.codePointAt(PREVIEW_MAX - 1) ?? 0) > SINGLE_UNIT_MAX ? PREVIEW_MAX - 1 : PREVIEW_MAX;
  return value.slice(0, end);
}

/**
 * Inspect actual peer messages without marking an agent's inbox acknowledged.
 *
 * @param store - Selected project's durable broker messages.
 * @param mesh - Its private credentials remain backend-only.
 * @returns Recent safe message previews in chronological order.
 */
export function conversationWindow(store: Store, mesh: MeshConfig): z.output<typeof conversationSchema>[] {
  const filter = conversationRedactor(mesh);
  return selectAll(
    store.db,
    conversationSchema,
    'SELECT m.*,s.name AS sender_name,r.name AS recipient_name FROM messages m JOIN agents s ON s.id=m.sender JOIN agents r ON r.id=m.recipient ORDER BY m.seq DESC LIMIT ?',
    MESSAGE_WINDOW,
  )
    .toReversed()
    .map((message) => {
      const body = filter.redact(message.body);
      const handoff = message.handoff === null ? null : filter.redact(message.handoff);
      return {
        ...message,
        body: excerpt(body),
        handoff: handoff === null ? null : excerpt(handoff),
        truncated: body.length > PREVIEW_MAX || (handoff?.length ?? 0) > PREVIEW_MAX,
      };
    });
}
