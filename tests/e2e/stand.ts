/**
 * The sync stand the end-to-end suite runs against: the server's socket
 * process and the REST routes a client reads, over a local test database (see
 * `tests/stand/sync-stand.ts` in the server). `global-setup.ts` starts it once
 * for the run and hands its address and token over in the environment.
 *
 * This is the client of its service API (`/__stand/*`): a project per
 * scenario, what the server holds, faults.
 */

/** A user of a stand project and the API key its devices sync with. */
export interface StandMember {
  userId: string;
  apiKey: string;
}

export interface StandProject {
  projectId: string;
  /** The owner (ADMIN) first, then the other members (EDITOR). */
  members: StandMember[];
}

/** A row of the server's files, tombstones included. */
export interface ServerFileRow {
  id: string;
  path: string;
  fileType: 'TEXT' | 'BINARY';
  contentHash: string;
  size: number;
  deletedAt: string | null;
}

/** A row of the server's journal (`OperationLog`), in the order it was written. */
export interface ServerOpRow {
  id: string;
  opType: 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
  filePath: string;
  newPath: string | null;
  clientId: string | null;
  opId: string | null;
  authorId: string | null;
  outcome: ({ kind: string; fileId?: string } & Record<string, unknown>) | null;
  payload: { fileId?: string; folder?: string } & Record<string, unknown>;
}

/** A fault of the stand (see `control.ts` in the server). */
export type StandFault =
  | { kind: 'queue-deadline'; ms: number }
  | { kind: 'hold-journal'; projectId: string; filePath: string }
  | { kind: 'release-journal' }
  | { kind: 'clear' };

/** Where `global-setup.ts` puts the stand's address and token. */
export const STAND_URL_ENV = 'TV_STAND_URL';
export const STAND_TOKEN_ENV = 'TV_STAND_TOKEN';

export class Stand {
  readonly url: string;
  readonly port: number;
  private readonly token: string;

  private constructor(url: string, token: string) {
    this.url = url;
    this.port = Number(new URL(url).port);
    this.token = token;
  }

  /** The stand of this run; throws when the suite runs without its global setup. */
  static fromEnv(): Stand {
    const url = process.env[STAND_URL_ENV];
    const token = process.env[STAND_TOKEN_ENV];
    if (!url || !token) {
      throw new Error(`no sync stand: run the suite with pnpm test:e2e (${STAND_URL_ENV} unset)`);
    }
    return new Stand(url, token);
  }

  /** A new project with `members` users, each with an API key. */
  newProject(members = 2): Promise<StandProject> {
    return this.call<StandProject>('POST', '/__stand/project', { members });
  }

  /** The project's files, tombstones included, by path. */
  files(projectId: string): Promise<ServerFileRow[]> {
    return this.call('GET', `/__stand/project/${encodeURIComponent(projectId)}/files`);
  }

  /** The project's live files, by path. */
  async liveFiles(projectId: string): Promise<ServerFileRow[]> {
    return (await this.files(projectId)).filter((f) => f.deletedAt === null);
  }

  /** The project's journal, in the order it was written. */
  ops(projectId: string): Promise<ServerOpRow[]> {
    return this.call('GET', `/__stand/project/${encodeURIComponent(projectId)}/ops`);
  }

  /** The text of each live note of the project, from its Y.Doc. */
  texts(projectId: string): Promise<Record<string, string>> {
    return this.call('GET', `/__stand/project/${encodeURIComponent(projectId)}/texts`);
  }

  async fault(fault: StandFault): Promise<void> {
    await this.call('POST', '/__stand/fault', fault);
  }

  /** How many journal inserts wait on the held journal (see {@link StandFault}). */
  async journalWaiters(): Promise<number> {
    return (await this.call<{ waiting: number }>('GET', '/__stand/journal-hold')).waiting;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { 'x-stand-token': this.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`stand ${method} ${path}: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  }
}
