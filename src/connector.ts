/**
 * Provider-neutral contracts that separate a work tracker from source control.
 * A connection record carries one section for each, with independent
 * verification state and a capability descriptor. Records hold no credentials:
 * each section may name a credential handle (see `credentials.ts`), never a value.
 *
 * @file
 */

import { z } from 'zod/v3';

import { verificationSchema } from './connection-state.ts';
import { credentialHandleSchema, scopedHandle } from './credentials.ts';
import { MeshError } from './protocol.ts';

/** Preserve bounded legacy names without silently dropping resumable journals. */
export const REPOSITORY_ALIAS_MAX = 100;

/** Whether a provider capability is known to work, known not to, or not yet checked. */
export const CAPABILITY_STATES = ['supported', 'unsupported', 'unverified'] as const;

/** Capabilities a tracker or source section can describe. */
export const CAPABILITY_NAMES = [
  'issue_create',
  'sub_issues',
  'dependencies',
  'labels',
  'milestones',
  'views',
  'pull_requests',
] as const;

/** Work tracker providers. */
export const TRACKER_PROVIDERS = ['github-projects', 'jira'] as const;

/** Capability name to state; absent entries are unverified. */
export const capabilitiesSchema = z.record(z.enum(CAPABILITY_NAMES), z.enum(CAPABILITY_STATES));

/** A capability name. */
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
/** A capability state. */
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** Capability descriptor of one connection section. */
export type Capabilities = z.output<typeof capabilitiesSchema>;

/** One option of a workflow field. */
const optionSchema = z.object({ id: z.string(), name: z.string() });

/** A workflow (status) field selected in the tracker. */
export const workflowFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  options: z.array(optionSchema).optional(),
});

/** Where a Jira tracker lives; the token itself is only ever named by the section's credential handle. */
export const jiraTrackerSchema = z
  .object({
    /** `https://<name>.atlassian.net`. */
    site: z.string().url(),
    /** Project key such as `PROJ`. */
    projectKey: z.string().regex(/^[A-Z][\dA-Z_]{1,99}$/v),
    /** Atlassian account email the API token belongs to. */
    email: z.string().email(),
  })
  .strict();

/**
 * Work tracker section; `projectId` is the provider's stable identifier. A
 * Jira tracker fills the shared fields from Jira: `owner` is the site name,
 * `projectId` and `projectNumber` the numeric project ID, `url` the project's
 * browse page and `workflowField` Jira's own Status field; `jira` holds the
 * site, project key and account email.
 */
export const trackerSchema = z.object({
  provider: z.enum(TRACKER_PROVIDERS),
  owner: z.string().regex(/^[\w\-]+$/v),
  projectId: z.string().min(1),
  projectNumber: z.number().int().positive(),
  url: z.string().url(),
  workflowField: workflowFieldSchema,
  capabilities: capabilitiesSchema,
  /** Where this section's credential lives; absent on records saved before handles. */
  credential: credentialHandleSchema.optional(),
  /** Jira site, project key and account, for a Jira tracker only. */
  jira: jiraTrackerSchema.optional(),
  /** Latest verification; absent on records saved by a verified connect or before states existed. */
  verification: verificationSchema.optional(),
  savedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable().default(null),
});

/** Source control section; the node ID survives repository renames. */
export const sourceSchema = z.object({
  provider: z.literal('github'),
  repository: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v),
  repositoryId: z.string().min(1).nullable().default(null),
  repositoryAliases: z
    .array(z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v))
    .max(REPOSITORY_ALIAS_MAX)
    .default([]),
  capabilities: capabilitiesSchema,
  /** Where this section's credential lives; absent on records saved before handles. */
  credential: credentialHandleSchema.optional(),
  /** Latest verification; absent on records saved by a verified connect or before states existed. */
  verification: verificationSchema.optional(),
  savedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable().default(null),
});

/** Tracker section type. */
export type TrackerConnection = z.output<typeof trackerSchema>;
/** Source section type. */
export type SourceConnection = z.output<typeof sourceSchema>;

/** Version 2 connection record. */
export const connectionV2Schema = z.object({
  version: z.literal(2),
  tracker: trackerSchema,
  source: sourceSchema,
});

/** Version 2 connection record type. */
export type ConnectionV2 = z.output<typeof connectionV2Schema>;

/**
 * Describe a section whose capabilities have never been probed.
 *
 * @returns Every capability marked unverified.
 */
export function unverifiedCapabilities(): Capabilities {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, 'unverified' as const]));
}

/**
 * Read a capability, treating a missing entry as unverified rather than unsupported.
 *
 * @param capabilities - Section descriptor.
 * @param name - Capability to look up.
 * @returns Its recorded state.
 */
export function capabilityState(capabilities: Capabilities, name: CapabilityName): CapabilityState {
  return capabilities[name] ?? 'unverified';
}

/** Legacy flat connection shape (version 1), still returned to current callers; it holds no bearer token. */
export const legacyConnectionSchema = z.object({
  version: z.literal(1),
  repository: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v),
  owner: z.string().regex(/^[\w\-]+$/v),
  project: z.object({ id: z.string(), number: z.number().int().positive(), url: z.string().url() }),
  statusField: workflowFieldSchema,
  verifiedAt: z.string().datetime(),
});

/** Legacy flat connection view. */
export type LegacyConnection = z.output<typeof legacyConnectionSchema>;

/** A saved record in either on-disk version, resolved to both views. */
export interface SavedConnection {
  /** Flat view used by existing callers. */
  legacy: LegacyConnection;
  /** Separated tracker and source view. */
  v2: ConnectionV2;
}

/**
 * Normalize a version 1 record in memory. Its capabilities and repository
 * node ID were never probed, so they are reported unverified.
 *
 * @param legacy - Validated version 1 record.
 * @returns Equivalent version 2 view; the file is not rewritten.
 */
function upgradeConnection(legacy: LegacyConnection): ConnectionV2 {
  return {
    version: 2,
    tracker: {
      provider: 'github-projects',
      owner: legacy.owner,
      projectId: legacy.project.id,
      projectNumber: legacy.project.number,
      url: legacy.project.url,
      workflowField: legacy.statusField,
      capabilities: unverifiedCapabilities(),
      savedAt: legacy.verifiedAt,
      verifiedAt: legacy.verifiedAt,
    },
    source: {
      provider: 'github',
      repository: legacy.repository,
      repositoryId: null,
      repositoryAliases: [],
      capabilities: unverifiedCapabilities(),
      savedAt: legacy.verifiedAt,
      verifiedAt: null,
    },
  };
}

/**
 * Project a version 2 record onto the flat shape existing callers consume.
 *
 * @param record - Validated version 2 record.
 * @returns Legacy-shaped connection.
 */
export function flattenConnection(record: ConnectionV2): LegacyConnection {
  const { tracker, source } = record;
  return {
    version: 1,
    repository: source.repository,
    owner: tracker.owner,
    project: { id: tracker.projectId, number: tracker.projectNumber, url: tracker.url },
    statusField: tracker.workflowField,
    verifiedAt: tracker.verifiedAt ?? tracker.savedAt,
  };
}

/**
 * Validate a saved record, checking each version 2 section independently.
 *
 * @param raw - Parsed connection.json content.
 * @returns Both views of the record.
 * @throws {MeshError} When the record or one of its sections is damaged.
 */
export function parseConnection(raw: unknown): SavedConnection {
  const header = z.object({ version: z.union([z.literal(1), z.literal(2)]) }).safeParse(raw);
  if (!header.success) {
    throw new MeshError('INVALID_INPUT', 'The saved GitHub connection has an unsupported version.');
  }
  if (header.data.version === 1) {
    const legacy = legacyConnectionSchema.parse(raw);
    return { legacy, v2: upgradeConnection(legacy) };
  }
  const sections = z.object({ tracker: z.unknown(), source: z.unknown() }).parse(raw);
  const tracker = trackerSchema.safeParse(sections.tracker);
  if (!tracker.success) {
    throw new MeshError('INVALID_INPUT', 'The saved GitHub connection tracker section is damaged.');
  }
  const source = sourceSchema.safeParse(sections.source);
  if (!source.success) {
    throw new MeshError('INVALID_INPUT', 'The saved GitHub connection source section is damaged.');
  }
  for (const [section, value] of [
    ['tracker', tracker.data],
    ['source', source.data],
  ] as const) {
    if (value.credential !== undefined) {
      scopedHandle({ section, provider: value.provider }, value.credential);
    }
  }
  const v2 = connectionV2Schema.parse({ version: 2, tracker: tracker.data, source: source.data });
  return { legacy: flattenConnection(v2), v2 };
}
