import type { ServerConfig } from '@/settings/settings';
import type { ApiFile, ApiFileMeta, ApiFileVersion, ApiProject, ApiUser } from './types';

// Re-export DTOs so call sites can `import { ApiProject } from '@/client/api'`
// without having to know the types live in a separate file.
export type {
  ApiFile,
  ApiFileMeta,
  ApiFileType,
  ApiFileVersion,
  ApiProject,
  ApiUser,
} from './types';

/**
 * REST client for the Obsidian Team server.
 *
 * Goes through Obsidian's `requestUrl` (instead of plain `fetch`) because
 * `fetch` from the Electron renderer trips on cross-origin requests. The
 * IPC-based `requestUrl` bypasses CORS entirely.
 *
 * Authentication uses the `X-API-Key` header, matching
 * `server/src/lib/auth/api-key-middleware.ts`. Every server route the plugin
 * hits goes through `authenticateRequest()` server-side.
 */

/** Subset of Obsidian's RequestUrlParam we actually use. Kept local so tests
 *  don't have to extend the manual `obsidian` mock with the full type. */
interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}

/** Subset of Obsidian's RequestUrlResponse we depend on. Exported so tests
 *  can reuse the shape without importing the obsidian module type. */
export interface RequestUrlResponse {
  status: number;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
  text: string;
}

export type ApiErrorKind =
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'server'
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, kind: ApiErrorKind, status: number, retryable: boolean) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Indirection for tests — production calls `requestUrl` from 'obsidian'. */
export type RequestFn = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

const defaultRequest: RequestFn = async (params) => {
  // Lazy import — `obsidian` ships only TypeScript types (no runtime),
  // so a top-level `import { requestUrl } from 'obsidian'` would crash
  // when this module is loaded outside Obsidian (Jest tests, CLI
  // emulator). Node-side callers always supply their own `RequestFn`,
  // so this branch never runs there.
  const { requestUrl } = await import('obsidian');
  const res = await requestUrl({ ...params, throw: false });
  return res as unknown as RequestUrlResponse;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly request: RequestFn;

  constructor(server: Pick<ServerConfig, 'url' | 'apiKey'>, request: RequestFn = defaultRequest) {
    this.baseUrl = server.url.replace(/\/+$/, '');
    this.apiKey = server.apiKey;
    this.request = request;
  }

  // -- Auth / discovery -------------------------------------------------------

  async getMe(): Promise<ApiUser> {
    const body = await this.json<{ user: ApiUser }>('GET', '/api/auth/me');
    return body.user;
  }

  async getProjects(): Promise<ApiProject[]> {
    const body = await this.json<{ projects: ApiProject[] }>('GET', '/api/projects');
    return body.projects;
  }

  async getProject(projectId: string): Promise<ApiProject> {
    const body = await this.json<{ project: ApiProject }>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
    return body.project;
  }

  // -- Files ------------------------------------------------------------------

  /**
   * List all files in a project. Returns the active set by default; pass
   * `{ includeDeleted: true }` to include tombstones (used during catch-up
   * sync to apply DELETE operations the client missed).
   */
  async getProjectFiles(
    projectId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ApiFile[]> {
    const qs = options.includeDeleted ? '?includeDeleted=true' : '';
    const body = await this.json<{ files: Array<Omit<ApiFile, 'size'> & { size: string }> }>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/files${qs}`,
    );
    return body.files.map(parseFile);
  }

  /** Download raw file bytes. Empty file is `ArrayBuffer` of length 0. */
  async downloadFile(projectId: string, fileId: string): Promise<ArrayBuffer> {
    return this.binary(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
    );
  }

  /**
   * Create a new file via multipart/form-data. Server-side enforces unique
   * paths within a project — duplicate paths surface as `ApiError(conflict)`.
   */
  async uploadFile(
    projectId: string,
    path: string,
    content: ArrayBuffer,
    options: { mimeType?: string } = {},
  ): Promise<ApiFileMeta> {
    const { body, contentType } = buildMultipartUpload(path, content, options.mimeType);
    const res = await this.send('POST', `/api/projects/${encodeURIComponent(projectId)}/files`, {
      body,
      contentType,
    });
    const parsed = ensureJson(res);
    const data = parsed as { file?: Omit<ApiFileMeta, 'size'> & { size: string } };
    if (!data.file) throw new ApiError('Malformed upload response', 'server', res.status, false);
    return parseFileMeta(data.file);
  }

  /** Replace the contents of an existing file. */
  async updateFile(projectId: string, fileId: string, content: ArrayBuffer): Promise<ApiFileMeta> {
    const res = await this.send(
      'PUT',
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
      {
        body: content,
        contentType: 'application/octet-stream',
      },
    );
    const parsed = ensureJson(res);
    const data = parsed as { file?: Omit<ApiFileMeta, 'size'> & { size: string } };
    if (!data.file) throw new ApiError('Malformed update response', 'server', res.status, false);
    return parseFileMeta(data.file);
  }

  /** Move (rename) a file inside the project. */
  async moveFile(
    projectId: string,
    fileId: string,
    newPath: string,
  ): Promise<{ id: string; path: string }> {
    const body = await this.json<{ file: { id: string; path: string } }>(
      'PATCH',
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
      { json: { newPath } },
    );
    return body.file;
  }

  /** Soft-delete a file (server marks `deletedAt`, removes blob). */
  async deleteFile(projectId: string, fileId: string): Promise<void> {
    await this.json<{ success: boolean }>(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
    );
  }

  // -- Versions ---------------------------------------------------------------

  async getFileVersions(projectId: string, fileId: string): Promise<ApiFileVersion[]> {
    const body = await this.json<{ versions: ApiFileVersion[] }>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/versions`,
    );
    return body.versions;
  }

  async downloadFileVersion(
    projectId: string,
    fileId: string,
    versionId: string,
  ): Promise<ArrayBuffer> {
    return this.binary(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`,
    );
  }

  // -- Internals --------------------------------------------------------------

  private async json<T>(
    method: string,
    path: string,
    options: { json?: unknown } = {},
  ): Promise<T> {
    const res = await this.send(method, path, {
      ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
      contentType: 'application/json',
    });
    const parsed = ensureJson(res);
    return parsed as T;
  }

  private async binary(method: string, path: string): Promise<ArrayBuffer> {
    const res = await this.send(method, path, {});
    return res.arrayBuffer;
  }

  private async send(
    method: string,
    path: string,
    options: { body?: string | ArrayBuffer; contentType?: string },
  ): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (options.contentType) headers['Content-Type'] = options.contentType;

    let res: RequestUrlResponse;
    try {
      res = await this.request({
        url: `${this.baseUrl}${path}`,
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : 'network error', 'network', 0, true);
    }
    if (res.status >= 200 && res.status < 300) return res;
    throw classifyError(res.status);
  }
}

// -- helpers ------------------------------------------------------------------

function classifyError(status: number): ApiError {
  if (status === 401) return new ApiError('Unauthorized', 'unauthorized', 401, false);
  if (status === 403) return new ApiError('Forbidden', 'forbidden', 403, false);
  if (status === 404) return new ApiError('Not found', 'not_found', 404, false);
  if (status === 409) return new ApiError('Conflict', 'conflict', 409, false);
  if (status >= 500) return new ApiError(`Server error ${status}`, 'server', status, true);
  return new ApiError(`Request failed ${status}`, 'unknown', status, false);
}

function ensureJson(res: RequestUrlResponse): unknown {
  if (res.json === undefined || res.json === null) {
    throw new ApiError('Empty JSON response', 'server', res.status, false);
  }
  return res.json;
}

function parseFile(raw: Omit<ApiFile, 'size'> & { size: string }): ApiFile {
  return { ...raw, size: parseSize(raw.size) };
}

function parseFileMeta(raw: Omit<ApiFileMeta, 'size'> & { size: string }): ApiFileMeta {
  return { ...raw, size: parseSize(raw.size) };
}

function parseSize(raw: string | number): number {
  if (typeof raw === 'number') return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build a `multipart/form-data` body by hand. We can't use `FormData` with
 * `requestUrl` — it expects a string or ArrayBuffer body.
 *
 * The boundary is derived from `crypto.randomUUID()`, which is collision-safe
 * for our purposes (we only need uniqueness per request, not per process).
 */
function buildMultipartUpload(
  path: string,
  content: ArrayBuffer,
  mimeType?: string,
): { body: ArrayBuffer; contentType: string } {
  const boundary = `----osync-${globalThis.crypto.randomUUID()}`;
  const encoder = new TextEncoder();

  // Field 1: path
  const pathPart = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${path}\r\n`,
  );

  // Field 2: file
  const filename = path.split('/').pop() ?? 'file';
  const filePartHeader = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType ?? 'application/octet-stream'}\r\n\r\n`,
  );
  const trailer = encoder.encode(`\r\n--${boundary}--\r\n`);

  const total =
    pathPart.byteLength + filePartHeader.byteLength + content.byteLength + trailer.byteLength;
  const buf = new Uint8Array(total);
  let offset = 0;
  buf.set(pathPart, offset);
  offset += pathPart.byteLength;
  buf.set(filePartHeader, offset);
  offset += filePartHeader.byteLength;
  buf.set(new Uint8Array(content), offset);
  offset += content.byteLength;
  buf.set(trailer, offset);

  return {
    body: buf.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
