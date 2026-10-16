/** @file Linux PTYs create a second process group; stop it before retiring the host. */
import { setTimeout as delay } from 'node:timers/promises';

/** Graceful PTY process-group shutdown before forced descendant cleanup. */
const GRACE_MS = 250;

/**
 * Signal only a PID reported by our owned host, never a browser-supplied number.
 *
 * @param pid - Owned CLI process-group leader reported by its started frame.
 */
export async function stopTerminalGroup(pid: number): Promise<void> {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  await delay(GRACE_MS);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* The owned group already exited. */
  }
}
