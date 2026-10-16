/** @file Validated wrapper descriptors and fixed native containment invocation. */
import path from 'node:path';

import { z } from 'zod/v3';

import { writeAtomic } from '../summary.ts';

import { subscriptionEnvironment } from './authentication.ts';
import { createTerminalInput } from './terminal-input.ts';
import { terminalEnvironment } from './terminal-launch.ts';

import type { TerminalInput } from './terminal-input.ts';

/** Private contract remains compatible with existing one-shot assignments. */
export const ownedLaunchSchema = z.object({
  file: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  input: z.string(),
  env: z.record(z.string()).default({}),
  memoryMb: z.number(),
  cpuPercent: z.number(),
  processLimit: z.number().int().positive(),
  interactive: z.boolean().default(false),
});
/** Validated descriptor. */
type OwnedLaunch = z.output<typeof ownedLaunchSchema>;

/**
 * Separate interactive input from PowerShell bootstrap stdin.
 *
 * @param file - Private descriptor path.
 * @param launch - Validated server descriptor.
 * @returns Job descriptor and private input channel.
 * @throws {unknown} If preparation fails.
 */
export async function prepareOwnedInput(
  file: string,
  launch: OwnedLaunch,
): Promise<{ descriptor: string; pipe: TerminalInput | null }> {
  if (!launch.interactive || process.platform !== 'win32') {
    return { descriptor: file, pipe: null };
  }
  const pipe = await createTerminalInput(process.stdin);
  try {
    const descriptor = path.join(path.dirname(file), 'pty-job.json');
    writeAtomic(descriptor, JSON.stringify({ ...launch, args: [...launch.args, '--input-pipe', pipe.name] }));
    return { descriptor, pipe };
  } catch (error) {
    await pipe.close();
    throw error;
  }
}

/**
 * Keep native executables separate from literal arguments.
 *
 * @param descriptor - Private launch metadata.
 * @param launch - Validated native program.
 * @param cancellation - Unique owned control marker.
 * @returns Executable and arguments.
 */
export function ownedInvocation(
  descriptor: string,
  launch: OwnedLaunch,
  cancellation: string,
): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? {
        file: path.join(
          process.env['SystemRoot'] ?? 'C:/Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(import.meta.dirname, 'windows-job.ps1'),
          descriptor,
          '-CancelFile',
          cancellation,
        ],
      }
    : { file: launch.file, args: launch.args };
}

/**
 * Preserve assignment environments while minimizing interactive configuration.
 *
 * @param launch - Validated launch type.
 * @returns Subscription-only child environment.
 */
export function ownedEnvironment(launch: OwnedLaunch): NodeJS.ProcessEnv {
  const environment = launch.interactive
    ? terminalEnvironment(process.env)
    : subscriptionEnvironment({ ...process.env, ...launch.env });
  if (process.platform !== 'win32') {
    return environment;
  }
  // Only Microsoft's built-in cmdlets are needed by the fixed Job helper.
  // Avoid discovering user/runner modules or sharing their analysis-cache lock.
  return {
    ...environment,
    PSModulePath: path.join(
      process.env['SystemRoot'] ?? 'C:/Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules',
    ),
    PSModuleAnalysisCachePath: 'NUL',
    PSDisableModuleAnalysisCacheCleanup: '1',
  };
}
