/**
 * The strict JSON Schema both provider CLIs must satisfy for their final
 * structured result, and the size limits it shares with the Zod result schema.
 * This module depends only on the seat list, so schemas can import its limits.
 *
 * @file
 */

import { FACTORY_ROLES } from './seats.ts';

/** Extra reviewed project skills attached to one stage. */
export const MAX_ASSIGNMENT_SKILLS = 4;
/** Bound the lead's per-role routing explanation. */
export const ROUTING_REASON_MAX = 1000;
/** Largest atomic plan accepted at once. */
export const PLAN_MAX = 100;
/** Maximum focused instruction receipts per assignment. */
export const MAX_INSTRUCTION_RECEIPTS = 20;

/** Strict JSON Schema passed to both providers for their final result. */
export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'findings', 'deliveries', 'skillActions', 'instructionReceipts', 'dispositions'],
  properties: {
    outcome: { type: 'string', enum: ['success', 'changes_requested', 'blocked'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    dispositions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'decision', 'reason', 'evidence'],
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['adopted', 'rejected', 'merged'] },
          reason: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    instructionReceipts: {
      type: 'array',
      maxItems: MAX_INSTRUCTION_RECEIPTS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'acknowledged', 'applied', 'evidence'],
        properties: {
          id: { type: 'string' },
          acknowledged: { type: 'boolean' },
          applied: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    skillActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'revision', 'state', 'reason'],
        properties: {
          name: { type: 'string' },
          revision: { type: 'string' },
          state: { type: 'string', enum: ['active', 'archived'] },
          reason: { type: 'string' },
        },
      },
    },
    deliveries: {
      type: 'array',
      maxItems: PLAN_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'title',
          'description',
          'acceptanceCriteria',
          'dependencies',
          'capabilityTier',
          'assignmentProfiles',
          'skills',
        ],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          dependencies: { type: 'array', items: { type: 'string' } },
          capabilityTier: { type: ['string', 'null'], enum: ['small', 'standard', 'advanced', null] },
          assignmentProfiles: {
            type: 'array',
            maxItems: FACTORY_ROLES.length,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'tier', 'effort', 'reason'],
              properties: {
                role: { type: 'string', enum: FACTORY_ROLES },
                tier: { type: 'string', enum: ['small', 'standard', 'advanced'] },
                effort: { type: 'string', enum: ['low', 'medium', 'high'] },
                reason: { type: 'string', minLength: 1, maxLength: ROUTING_REASON_MAX },
              },
            },
          },
          skills: { type: 'array', maxItems: MAX_ASSIGNMENT_SKILLS, items: { type: 'string' } },
        },
      },
    },
  },
};
