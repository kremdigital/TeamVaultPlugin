/**
 * The end state every scenario checks: the devices and the server agree, and
 * nothing a device did reached the server twice.
 *
 * A retry that went out under a new operation id is what lost answers, voided
 * operations and late packets could turn into; the server applies an `opId`
 * once (its unique index makes a second row impossible), so a check of unique
 * ids would never fail. The journal is read for the effect instead: one delete
 * per file, no rename from one name to another twice, no operation of one
 * device on the same paths twice.
 */
import { sha256Hex } from '@/sync/hash';
import { eventually, quietFor } from './eventually';
import type { LiveClient } from './live-client';
import type { ServerOpRow, Stand } from './stand';

/** A path a device syncs: not a dotted service file (see `isAlwaysIgnored`). */
export function isSynced(path: string): boolean {
  return !path.split('/').some((segment) => segment.startsWith('.'));
}

export function isConflictCopy(path: string): boolean {
  return /\.conflict-/.test(path);
}

export interface ConvergedOptions {
  /** How many conflict copies the server may hold: 0 by default. */
  conflicts?: number;
  timeoutMs?: number;
}

/** A journal row as `OP path[ -> newPath]`. */
export function rowOf(op: ServerOpRow): string {
  return `${op.opType} ${op.filePath}${op.newPath !== null ? ` -> ${op.newPath}` : ''}`;
}

/** The file a journal row is about, as the server recorded it. */
export function fileIdOf(op: ServerOpRow): string | undefined {
  return op.payload.fileId ?? op.outcome?.fileId;
}

/**
 * Operations applied twice, by their effect: a second delete of a file, a
 * second rename of a file from one name to the same other name, and one
 * device's second create, delete, rename or move on the same paths (a no-op
 * excepted: it changed nothing; an attachment saved twice is two updates).
 * Each as a line that names the rows.
 */
export function repeatsIn(ops: readonly ServerOpRow[]): string[] {
  const seen = new Map<string, number>();
  const count = (key: string): void => {
    seen.set(key, (seen.get(key) ?? 0) + 1);
  };
  for (const op of ops) {
    const fileId = fileIdOf(op) ?? '?';
    if (op.opType === 'DELETE') count(`DELETE of file ${fileId}`);
    if (op.opType === 'RENAME' || op.opType === 'MOVE') {
      count(`rename of file ${fileId}: ${op.filePath} -> ${String(op.newPath)}`);
    }
    if (op.opType !== 'UPDATE' && op.outcome?.kind !== 'no_op') {
      count(`${rowOf(op)} by ${String(op.clientId)}`);
    }
  }
  return [...seen].filter(([, n]) => n > 1).map(([key, n]) => `${key} (${n} times)`);
}

/** The journal, one row a line, for failure messages. */
export function journalText(ops: readonly ServerOpRow[]): string {
  return ops
    .map((op) => `  ${rowOf(op)} [${String(op.clientId)}] ${op.outcome?.kind ?? ''}`)
    .join('\n');
}

/** Throws unless every device's disk holds what the server holds. */
async function checkDisks(stand: Stand, projectId: string, clients: readonly LiveClient[]) {
  for (const client of clients) {
    if (!client.isSettled()) throw new Error(`${client.name} not settled: ${client.describe()}`);
  }
  const files = await stand.liveFiles(projectId);
  const texts = await stand.texts(projectId);
  const want = files.map((f) => f.path).sort();
  for (const client of clients) {
    const have = client.paths().filter(isSynced);
    if (have.join('\n') !== want.join('\n')) {
      throw new Error(`${client.name} has [${have.join(', ')}], the server [${want.join(', ')}]`);
    }
    for (const file of files) {
      if (file.fileType === 'TEXT') {
        const text = client.text(file.path);
        if (text !== texts[file.path]) {
          throw new Error(
            `${client.name}: ${file.path} is ${JSON.stringify(text)}, ` +
              `the server has ${JSON.stringify(texts[file.path])}`,
          );
        }
      } else {
        const bytes = client.bytes(file.path) ?? new Uint8Array();
        const hash = await sha256Hex(bytes.slice().buffer);
        if (hash !== file.contentHash) {
          throw new Error(`${client.name}: ${file.path} differs from the server's bytes`);
        }
      }
    }
  }
}

/**
 * Wait until every device is settled and holds what the server holds — the
 * same files, each note with the text of its server doc, each attachment with
 * the server's bytes — then check it stays so, and that the journal has no
 * repeat, the server `conflicts` conflict copies, and no device a failed
 * handler, a conflict question or a twin.
 */
export async function expectConverged(
  stand: Stand,
  projectId: string,
  clients: readonly LiveClient[],
  opts: ConvergedOptions = {},
): Promise<void> {
  await eventually(() => checkDisks(stand, projectId, clients), {
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  // Settled, it stays so: nothing late arrives on its own.
  await quietFor(300);
  await checkDisks(stand, projectId, clients);

  const ops = await stand.ops(projectId);
  if (process.env.TV_E2E_TRACE === '1') {
    process.stderr.write(`[journal ${projectId}]\n${journalText(ops)}\n`);
  }
  const repeats = repeatsIn(ops);
  if (repeats.length > 0) {
    throw new Error(`applied twice: ${repeats.join('; ')}\njournal:\n${journalText(ops)}`);
  }
  const copies = (await stand.liveFiles(projectId)).filter((f) => isConflictCopy(f.path));
  expect(copies.map((f) => f.path)).toHaveLength(opts.conflicts ?? 0);
  for (const client of clients) {
    expect({ device: client.name, errors: client.route.errors.map(String) }).toEqual({
      device: client.name,
      errors: [],
    });
    expect({ device: client.name, questions: client.questions }).toEqual({
      device: client.name,
      questions: [],
    });
    expect({ device: client.name, twins: client.twins }).toEqual({
      device: client.name,
      twins: [],
    });
  }
}
