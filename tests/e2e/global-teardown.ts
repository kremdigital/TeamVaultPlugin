/**
 * Stops the sync stand `global-setup.ts` started (Jest `globalTeardown`). Its
 * stdin closes, and it shuts down by itself: sockets, database connections, its
 * temp folder. `kill()` is the fallback — on Windows it ends the process at
 * once, with no cleanup — so the temp folder is removed here as well.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { STAND_GLOBAL, type RunningStand } from './global-setup';

const STOP_TIMEOUT_MS = 10_000;

function exited(stand: RunningStand, ms: number): Promise<boolean> {
  if (stand.child.exitCode !== null || stand.child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    stand.child.once('exit', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

export default async function globalTeardown(): Promise<void> {
  const stand = (globalThis as Record<string, unknown>)[STAND_GLOBAL] as RunningStand | undefined;
  if (!stand) return;
  stand.child.stdin?.end();
  if (!(await exited(stand, STOP_TIMEOUT_MS))) {
    stand.child.kill();
    await exited(stand, STOP_TIMEOUT_MS);
  }
  // Only the stand's own folder: in the temp folder, named as the stand names it.
  const scratch = resolve(stand.scratch);
  if (dirname(scratch) === resolve(tmpdir()) && basename(scratch).startsWith('tv-stand-')) {
    rmSync(scratch, { recursive: true, force: true });
  }
}
