/**
 * The CLI dispatch table, importable without running the command-line entry point.
 *
 * @file
 */
import { FACTORY_COMMANDS } from './factory-cli.ts';

/** Every command the CLI accepts; `--help` lists each one. */
export const COMMANDS = [
  'doctor',
  'backup',
  'restore',
  'pairing-code',
  'ui',
  ...FACTORY_COMMANDS,
  'init',
  'attach',
  'stop',
  'start',
  'mcp',
  'status',
  'agents',
  'events',
  'teams',
  'lead',
  'message',
  'messages',
  'ack',
] as const;

/** A CLI command. */
export type Command = (typeof COMMANDS)[number];
