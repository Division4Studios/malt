/** @file Validated wrapper descriptors and fixed native containment invocation. */
import path from 'node:path';

import { z } from 'zod/v3';

import { writeAtomic } from '../summary.ts';

import { subscriptionEnvironment } from './authentication.ts';
import { createTerminalInput } from './terminal-input.ts';
import { terminalEnvironment } from './terminal-launch.ts';

import type { TerminalInput } from './terminal-input.ts';

/** Only these helper bootstrap variables need a separate target environment. */
const MODULE_KEYS = ['PSModulePath', 'PSModuleAnalysisCachePath', 'PSDisableModuleAnalysisCacheCleanup'] as const;
/** Windows environment values cannot contain NUL separators. */
const moduleValue = z
  .string()
  .refine((value) => !value.includes('\0'))
  .nullable();
/** No arbitrary environment keys can cross this bootstrap-only restoration boundary. */
const moduleEnvironmentSchema = z
  .object({
    PSModulePath: moduleValue,
    PSModuleAnalysisCachePath: moduleValue,
    PSDisableModuleAnalysisCacheCleanup: moduleValue,
  })
  .strict();

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
  moduleEnvironment: moduleEnvironmentSchema.optional(),
});
/** Validated descriptor. */
type OwnedLaunch = z.output<typeof ownedLaunchSchema>;

/**
 * Write private target metadata while keeping bootstrap variables out of the target.
 *
 * @param file - Existing private wrapper descriptor.
 * @param launch - Validated native launch.
 * @param pipe - Optional private interactive input channel.
 * @returns New native Job descriptor path.
 */
function nativeDescriptor(file: string, launch: OwnedLaunch, pipe: TerminalInput | null): string {
  const descriptor = path.join(path.dirname(file), launch.interactive ? 'pty-job.json' : 'native-job.json');
  const original: Record<string, string | null> = {};
  for (const key of MODULE_KEYS) {
    const lookup = (environment: NodeJS.ProcessEnv): string | undefined =>
      Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    original[key] = launch.interactive ? null : (lookup(launch.env) ?? lookup(process.env) ?? null);
  }
  writeAtomic(
    descriptor,
    JSON.stringify({
      ...launch,
      args: pipe === null ? launch.args : [...launch.args, '--input-pipe', pipe.name],
      moduleEnvironment: moduleEnvironmentSchema.parse(original),
    }),
  );
  return descriptor;
}

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
  if (process.platform !== 'win32') {
    return { descriptor: file, pipe: null };
  }
  const pipe = launch.interactive ? await createTerminalInput(process.stdin) : null;
  try {
    const descriptor = nativeDescriptor(file, launch, pipe);
    return { descriptor, pipe };
  } catch (error) {
    await pipe?.close();
    throw error;
  }
}

/**
 * Keep native executables separate from literal arguments.
 *
 * @param descriptor - Private launch metadata.
 * @param launch - Validated native program.
 * @param cancellation - Unique owned control marker.
 * @param ownerPipe - OS-lifetime capability of the exact wrapper, never a PID lookup.
 * @returns Executable and arguments.
 */
export function ownedInvocation(
  descriptor: string,
  launch: OwnedLaunch,
  cancellation: string,
  ownerPipe: string,
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
          '-OwnerPipe',
          ownerPipe,
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
  const helper = Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      MODULE_KEYS.every((name) => name.toLowerCase() !== key.toLowerCase()),
    ),
  );
  // Only Microsoft's built-in cmdlets are needed by the fixed Job helper.
  // Avoid discovering user/runner modules or sharing their analysis-cache lock.
  return {
    ...helper,
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
