/**
 * Validated routing of the manager's three factory operations. Authority is
 * enforced by the broker before these run: factory_manager is operator-only,
 * factory_manager_ask belongs to the live manager and factory_brief is read-only.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { managerOperationSchemas } from './manager-schema.ts';

import type { ManagerService } from './manager-service.ts';

/** The factory constructs its manager through this module alongside its handlers. */
export { ManagerService } from './manager-service.ts';

/**
 * Require an optional field for one action.
 *
 * @param value - Optional field.
 * @param name - Field name for the error.
 * @returns The present value.
 * @throws {MeshError} When absent.
 */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new MeshError('INVALID_INPUT', `This manager action requires ${name}.`);
  }
  return value;
}

/**
 * Execute one operator control.
 *
 * @param manager - Project manager.
 * @param raw - Untrusted input.
 * @returns Action result.
 */
async function control(manager: ManagerService, raw: unknown): Promise<unknown> {
  const input = managerOperationSchemas.factory_manager.parse(raw);
  switch (input.action) {
    case 'status': {
      return manager.status();
    }
    case 'start': {
      return manager.start();
    }
    case 'stop': {
      return manager.stop();
    }
    case 'send': {
      return manager.send(required(input.text, 'text'));
    }
    case 'answer': {
      return manager.answer(required(input.decisionId, 'decisionId'), required(input.text, 'text'));
    }
    case 'history': {
      return { entries: manager.ledger.page(input.after ?? 0, input.limit), latestSeq: manager.ledger.latestSeq() };
    }
    default: {
      throw new MeshError('INVALID_INPUT', 'Unknown manager action.');
    }
  }
}

/**
 * Handlers for the factory operation table.
 *
 * @param manager - Project manager.
 * @param raw - Untrusted input of whichever operation runs.
 * @returns One handler per manager operation.
 */
export function managerHandlers(
  manager: ManagerService,
  raw: unknown,
): Record<'factory_manager' | 'factory_brief' | 'factory_manager_ask', () => unknown> {
  return {
    factory_manager: async () => control(manager, raw),
    factory_brief: () => manager.brief(),
    factory_manager_ask: () => {
      const input = managerOperationSchemas.factory_manager_ask.parse(raw);
      return manager.ask(input.question, input.options, input.evidence);
    },
  };
}
