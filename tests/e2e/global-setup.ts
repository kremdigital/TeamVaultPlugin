/**
 * Starts the sync stand of the server next door for the end-to-end run (Jest
 * `globalSetup` of `jest.e2e.config.mjs`), once for all the scenarios.
 *
 * - The server: `TV_SERVER_DIR`, `../server` by default — a checkout of
 *   TeamVaultServer with its dependencies installed.
 * - The database: `TV_E2E_DATABASE_URL`, by default
 *   `postgresql://team_vault:team_vault@localhost:5432/team_vault_e2e`. The
 *   stand wipes it, and takes only a local one named `*_e2e`. PostgreSQL has
 *   to be running; the database is created once (`createdb team_vault_e2e`)
 *   and migrated by the stand.
 *
 * The stand's address and token go to the scenarios in the environment (see
 * `stand.ts`): nothing on disk that another run could read or overwrite.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STAND_TOKEN_ENV, STAND_URL_ENV } from './stand';

const DEFAULT_DATABASE_URL = 'postgresql://team_vault:team_vault@localhost:5432/team_vault_e2e';

/** A cold start migrates the database and compiles the server with tsx. */
const READY_TIMEOUT_MS = 120_000;

interface Ready {
  ready: true;
  port: number;
  token: string;
  scratch: string;
}

/** What `global-teardown.ts` stops. */
export interface RunningStand {
  child: ChildProcess;
  scratch: string;
}

export const STAND_GLOBAL = '__teamVaultSyncStand';

/** The stand's one line on stdout, once it listens. */
function readyLine(child: ChildProcess): Promise<Ready> {
  return new Promise((resolveReady, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      reject(new Error(`the sync stand did not start in ${READY_TIMEOUT_MS / 1000} s`));
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (!line.startsWith('{')) continue;
        const parsed = JSON.parse(line) as Partial<Ready>;
        if (parsed.ready !== true) continue;
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        // Whatever it prints later goes on to the runner's stderr.
        child.stdout?.pipe(process.stderr);
        resolveReady(parsed as Ready);
        return;
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the sync stand exited with code ${String(code)} before it was ready ` +
            '(is PostgreSQL running, and the team_vault_e2e database created?)',
        ),
      );
    });
  });
}

export default async function globalSetup(): Promise<void> {
  const pluginRoot = resolve(__dirname, '..', '..');
  const serverDir = resolve(process.env.TV_SERVER_DIR ?? join(pluginRoot, '..', 'server'));
  const entry = join(serverDir, 'tests', 'stand', 'sync-stand.ts');
  const tsx = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(entry)) {
    throw new Error(`no sync stand at ${entry}: set TV_SERVER_DIR to a TeamVaultServer checkout`);
  }
  if (!existsSync(tsx)) {
    throw new Error(`no tsx in ${serverDir}: run pnpm install there first`);
  }
  // Node itself, not pnpm or a shell: the same on Windows.
  const child = spawn(process.execPath, [tsx, entry, '--migrate'], {
    cwd: serverDir,
    env: {
      ...process.env,
      STAND_DATABASE_URL: process.env.TV_E2E_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let ready: Ready;
  try {
    ready = await readyLine(child);
  } catch (err) {
    child.kill();
    throw err;
  }
  process.env[STAND_URL_ENV] = `http://127.0.0.1:${ready.port}`;
  process.env[STAND_TOKEN_ENV] = ready.token;
  const running: RunningStand = { child, scratch: ready.scratch };
  (globalThis as Record<string, unknown>)[STAND_GLOBAL] = running;
}
