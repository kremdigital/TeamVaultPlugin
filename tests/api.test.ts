import {
  ApiClient,
  ApiError,
  type BinaryRequestFn,
  type RequestFn,
  type RequestUrlResponse,
} from '@/client/api';

const server = { url: 'https://sync.example.com', apiKey: 'osk_secret' };

/**
 * Build a minimal `RequestUrlResponse`. Real Obsidian responses also carry
 * `arrayBuffer` / `headers` / `text` — we provide harmless defaults so each
 * test only specifies what it cares about.
 */
function response(partial: {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
}): RequestUrlResponse {
  return {
    status: partial.status,
    json: partial.json ?? null,
    arrayBuffer: partial.arrayBuffer ?? new ArrayBuffer(0),
    headers: {},
    text: '',
  };
}

function makeRequest(
  responder: (req: Parameters<RequestFn>[0]) => RequestUrlResponse,
): jest.Mock<Promise<RequestUrlResponse>, [Parameters<RequestFn>[0]]> {
  return jest.fn(async (req: Parameters<RequestFn>[0]) => responder(req));
}

/** Binary-transport mock (the `fetch`-backed seam used by downloads / blob
 *  uploads). Mirrors {@link makeRequest} for the binary path. */
function makeBinaryRequest(
  responder: (req: Parameters<BinaryRequestFn>[0]) => RequestUrlResponse,
): jest.Mock<Promise<RequestUrlResponse>, [Parameters<BinaryRequestFn>[0]]> {
  return jest.fn(async (req: Parameters<BinaryRequestFn>[0]) => responder(req));
}

/** JSON-request stub for binary-only tests — fails loudly if `requestUrl` is hit. */
const noRequest: RequestFn = async () => {
  throw new Error('binary test should not call requestUrl');
};

describe('ApiClient — auth / discovery', () => {
  it('strips trailing slashes from base url and sends X-API-Key', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: { user: { id: '1', email: 'me@example.com', name: null } },
      }),
    );
    const client = new ApiClient({ url: 'https://sync.example.com//', apiKey: 'k' }, request);
    await client.getMe();
    expect(request).toHaveBeenCalledTimes(1);
    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.url).toBe('https://sync.example.com/api/auth/me');
    expect(params.headers?.['X-API-Key']).toBe('k');
    expect(params.method).toBe('GET');
  });

  it('returns the unwrapped user payload', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: { user: { id: 'u1', email: 'a@b.com', name: 'Alice' } },
      }),
    );
    const client = new ApiClient(server, request);
    expect(await client.getMe()).toEqual({ id: 'u1', email: 'a@b.com', name: 'Alice' });
  });

  it('returns the unwrapped projects array', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: {
          projects: [{ id: 'p1', slug: 'a', name: 'A', description: null, iconEmoji: null }],
        },
      }),
    );
    const client = new ApiClient(server, request);
    const projects = await client.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe('p1');
  });

  it('hits the single-project endpoint with encoded id', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: { project: { id: 'p 1', slug: 'a', name: 'A', description: null, iconEmoji: null } },
      }),
    );
    const client = new ApiClient(server, request);
    await client.getProject('p 1');
    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.url).toBe('https://sync.example.com/api/projects/p%201');
  });
});

describe('ApiClient — files', () => {
  it('parses string size into number on listing', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: {
          files: [
            {
              id: 'f1',
              path: 'note.md',
              fileType: 'TEXT',
              contentHash: 'h',
              size: '1024',
              mimeType: 'text/markdown',
              deletedAt: null,
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
              lastModifiedById: 'u1',
            },
          ],
        },
      }),
    );
    const client = new ApiClient(server, request);
    const files = await client.getProjectFiles('p1');
    expect(files[0]?.size).toBe(1024);
    expect(typeof files[0]?.size).toBe('number');
  });

  it('passes ?includeDeleted=true when requested', async () => {
    const request = makeRequest(() => response({ status: 200, json: { files: [] } }));
    const client = new ApiClient(server, request);
    await client.getProjectFiles('p1', { includeDeleted: true });
    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.url).toBe('https://sync.example.com/api/projects/p1/files?includeDeleted=true');
  });

  it('returns the raw ArrayBuffer for download', async () => {
    const buf = new ArrayBuffer(8);
    const binary = makeBinaryRequest(() => response({ status: 200, arrayBuffer: buf }));
    const client = new ApiClient(server, noRequest, binary);
    const result = await client.downloadFile('p1', 'f1');
    expect(result).toBe(buf);
    const [params] = binary.mock.calls[0] as [Parameters<BinaryRequestFn>[0]];
    expect(params.method).toBe('GET');
    expect(params.headers['X-API-Key']).toBe('osk_secret');
  });

  it('uploads a binary blob via PUT to /blobs over the fetch seam', async () => {
    const binary = makeBinaryRequest(() => response({ status: 200, json: { hash: 'h', size: 3 } }));
    const client = new ApiClient(server, noRequest, binary);
    const buf = new TextEncoder().encode('png').buffer;
    const hash = 'a'.repeat(64);
    await client.uploadBlob('p1', hash, buf);
    const [params] = binary.mock.calls[0] as [Parameters<BinaryRequestFn>[0]];
    expect(params.method).toBe('PUT');
    expect(params.url).toBe(`https://sync.example.com/api/projects/p1/blobs/${hash}`);
    expect(params.headers['Content-Type']).toBe('application/octet-stream');
    expect(params.body).toBe(buf);
  });

  it('uploads as multipart/form-data with path and file fields', async () => {
    const request = makeRequest(() =>
      response({
        status: 201,
        json: {
          file: {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '5',
            mimeType: 'text/markdown',
            updatedAt: '2026-01-01',
          },
        },
      }),
    );
    const client = new ApiClient(server, request);
    const content = new TextEncoder().encode('hello').buffer;
    const meta = await client.uploadFile('p1', 'note.md', content, { mimeType: 'text/markdown' });
    expect(meta.size).toBe(5);

    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.method).toBe('POST');
    expect(params.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=----osync-/);

    // The body should embed both the path field name and the upload payload.
    const body = params.body as ArrayBuffer;
    const decoded = new TextDecoder().decode(body);
    expect(decoded).toContain('name="path"');
    expect(decoded).toContain('note.md');
    expect(decoded).toContain('name="file"');
    expect(decoded).toContain('hello');
  });

  it('updates a file with PUT and octet-stream', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: {
          file: {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h2',
            size: '6',
            mimeType: null,
            updatedAt: '2026-01-02',
          },
        },
      }),
    );
    const client = new ApiClient(server, request);
    const buf = new TextEncoder().encode('hello!').buffer;
    const meta = await client.updateFile('p1', 'f1', buf);
    expect(meta.contentHash).toBe('h2');
    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.method).toBe('PUT');
    expect(params.headers?.['Content-Type']).toBe('application/octet-stream');
  });

  it('moves a file via PATCH with JSON newPath', async () => {
    const request = makeRequest(() =>
      response({ status: 200, json: { file: { id: 'f1', path: 'new.md' } } }),
    );
    const client = new ApiClient(server, request);
    const result = await client.moveFile('p1', 'f1', 'new.md');
    expect(result.path).toBe('new.md');
    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.method).toBe('PATCH');
    expect(params.headers?.['Content-Type']).toBe('application/json');
    expect(params.body).toBe(JSON.stringify({ newPath: 'new.md' }));
  });

  it('deletes a file via DELETE', async () => {
    const request = makeRequest(() => response({ status: 200, json: { success: true } }));
    const client = new ApiClient(server, request);
    await client.deleteFile('p1', 'f1');
    const [params] = request.mock.calls[0] as [Parameters<RequestFn>[0]];
    expect(params.method).toBe('DELETE');
  });
});

describe('ApiClient — versions', () => {
  it('lists file versions', async () => {
    const request = makeRequest(() =>
      response({
        status: 200,
        json: {
          versions: [
            {
              id: 'v1',
              versionNumber: 3,
              contentHash: 'h',
              authorId: 'u1',
              message: null,
              createdAt: '2026-01-03',
              author: { id: 'u1', name: 'Alice', email: 'a@b.com' },
            },
          ],
        },
      }),
    );
    const client = new ApiClient(server, request);
    const versions = await client.getFileVersions('p1', 'f1');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.versionNumber).toBe(3);
  });

  it('downloads a specific version as bytes', async () => {
    const buf = new ArrayBuffer(4);
    const binary = makeBinaryRequest(() => response({ status: 200, arrayBuffer: buf }));
    const client = new ApiClient(server, noRequest, binary);
    const result = await client.downloadFileVersion('p1', 'f1', 'v1');
    expect(result).toBe(buf);
  });
});

describe('ApiClient — error mapping', () => {
  it('throws ApiError(unauthorized) on 401', async () => {
    const request = makeRequest(() => response({ status: 401 }));
    const client = new ApiClient(server, request);
    await expect(client.getMe()).rejects.toMatchObject({
      kind: 'unauthorized',
      status: 401,
    });
  });

  it('throws ApiError(forbidden) on 403', async () => {
    const request = makeRequest(() => response({ status: 403 }));
    const client = new ApiClient(server, request);
    await expect(client.getMe()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('throws ApiError(not_found) on 404', async () => {
    const request = makeRequest(() => response({ status: 404 }));
    const client = new ApiClient(server, request);
    await expect(client.getProject('missing')).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
    });
  });

  it('throws ApiError(conflict) on 409 (duplicate path on upload)', async () => {
    const request = makeRequest(() => response({ status: 409 }));
    const client = new ApiClient(server, request);
    const buf = new ArrayBuffer(0);
    await expect(client.uploadFile('p1', 'dup.md', buf)).rejects.toMatchObject({
      kind: 'conflict',
      status: 409,
    });
  });

  it('marks 5xx responses as retryable', async () => {
    const request = makeRequest(() => response({ status: 503 }));
    const client = new ApiClient(server, request);
    try {
      await client.getMe();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retryable).toBe(true);
      expect((err as ApiError).status).toBe(503);
    }
  });

  it('wraps thrown transport errors as network ApiError', async () => {
    const request: RequestFn = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const client = new ApiClient(server, request);
    await expect(client.getMe()).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });
});
