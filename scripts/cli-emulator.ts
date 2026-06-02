/**
 * Team Vault — CLI emulator.
 *
 * Same protocol as the plugin (REST + Socket.IO) but driven from the
 * shell. Run via `pnpm cli` or `tsx scripts/cli-emulator.ts ...`.
 *
 * Stage-13 surface: list / pull / push / watch. Diff-based deep sync,
 * Yjs round-tripping, and conflict modals are deliberately out of scope —
 * the CLI is for protocol debugging, not for replacing the plugin.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { CliArgsError, HELP_TEXT, parseArgs, type CliArgs } from './cli-args';
import { ApiClient, ApiError, type ApiFile, type RequestFn } from '@/client/api';
import { SocketClient } from '@/client/socket';
import { classifyFileType } from '@/sync/file-type';

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliArgsError) {
      console.error(err.message);
      console.error('\nRun "cli-emulator help" for usage.');
      process.exit(1);
    }
    throw err;
  }

  if (args.command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  const api = new ApiClient({ url: args.server, apiKey: args.apiKey }, nodeRequestFn);

  switch (args.command) {
    case 'list-projects':
      await listProjects(api);
      break;
    case 'list-files':
      await listFiles(api, args.projectId!);
      break;
    case 'pull':
      await pull(api, args.projectId!, args.folder!);
      break;
    case 'push':
      await push(api, args.projectId!, args.folder!);
      break;
    case 'watch':
      await watch(args, args.projectId!);
      break;
  }
}

// -- Commands -----------------------------------------------------------------

async function listProjects(api: ApiClient): Promise<void> {
  const projects = await api.getProjects();
  if (projects.length === 0) {
    console.log('No projects available for this API key.');
    return;
  }
  for (const p of projects) {
    console.log(`${p.id}\t${p.slug}\t${p.name}`);
  }
}

async function listFiles(api: ApiClient, projectId: string): Promise<void> {
  const files = await api.getProjectFiles(projectId);
  for (const f of files) {
    console.log(`${f.id}\t${f.fileType}\t${f.size}\t${f.contentHash}\t${f.path}`);
  }
}

async function pull(api: ApiClient, projectId: string, folder: string): Promise<void> {
  const target = resolve(folder);
  const files = await api.getProjectFiles(projectId);
  for (const f of files) {
    const dest = join(target, ...f.path.split('/'));
    await mkdir(dirOf(dest), { recursive: true });
    const buf = await api.downloadFile(projectId, f.id);
    await writeFile(dest, Buffer.from(buf));
    console.log(`pulled ${f.path} (${f.size} bytes)`);
  }
}

async function push(api: ApiClient, projectId: string, folder: string): Promise<void> {
  const root = resolve(folder);
  const existing = new Map<string, ApiFile>(
    (await api.getProjectFiles(projectId)).map((f) => [f.path, f]),
  );
  for await (const absolute of walkFiles(root)) {
    const rel = toForwardSlash(relative(root, absolute));
    const data = await readFile(absolute);
    const arrayBuf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    const existingFile = existing.get(rel);
    try {
      if (existingFile) {
        await api.updateFile(projectId, existingFile.id, arrayBuf);
        console.log(`updated ${rel}`);
      } else {
        await api.uploadFile(projectId, rel, arrayBuf);
        console.log(`created ${rel} (${classifyFileType(rel)})`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        console.error(`! ${rel}: ${err.kind} (${err.status})`);
      } else {
        throw err;
      }
    }
  }
}

async function watch(args: CliArgs, projectId: string): Promise<void> {
  const clientId = args.clientId ?? `cli-${Math.random().toString(36).slice(2, 10)}`;
  const socket = new SocketClient({
    server: { url: args.server, apiKey: args.apiKey },
    clientId,
  });

  socket.onConnect(() => console.log('[socket] connected'));
  socket.onDisconnect((reason) => console.log(`[socket] disconnected: ${reason}`));
  socket.onError((err) => console.error(`[socket] error: ${err.message}`));
  socket.onFileEvent((event) => console.log(`[event] ${JSON.stringify(event)}`));
  socket.onYjsUpdate((msg) =>
    console.log(`[yjs] file=${msg.fileId} bytes=${msg.update.byteLength}`),
  );

  socket.connect();
  // Wait for connect, then join the project. We don't pass a vector clock —
  // CLI watcher is a fresh subscriber every run.
  await new Promise<void>((r) => socket.onConnect(r));
  const result = await socket.joinProject(projectId);
  if (!result.ok) {
    console.error(`project:join failed: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `[join] ok — ${result.operations.length} catch-up ops, ${result.yjsDocs.length} yjs docs`,
  );
  console.log('[watch] streaming events (Ctrl+C to exit)…');

  // Block forever; SIGINT triggers process.exit in the runtime.
  await new Promise<void>(() => undefined);
}

// -- Helpers ------------------------------------------------------------------

/**
 * Node-side `RequestFn` for the API client. Uses the global `fetch` API
 * (Node 18+). Maps the response shape onto what the client expects.
 */
const nodeRequestFn: RequestFn = async (params) => {
  const init: RequestInit = {
    method: params.method ?? 'GET',
    headers: params.headers ?? {},
  };
  if (params.body !== undefined) init.body = params.body as BodyInit;
  const res = await globalThis.fetch(params.url, init);
  const arrayBuffer = await res.arrayBuffer();
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(arrayBuffer));
  } catch {
    /* binary or empty body */
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    status: res.status,
    json,
    arrayBuffer,
    headers,
    text: new TextDecoder().decode(arrayBuffer),
  };
};

async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      // Skip vault metadata + version control noise — same default as the
      // plugin's filesystem watcher.
      if (entry.name === '.obsidian' || entry.name === '.git') continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf(sep);
  return idx >= 0 ? p.slice(0, idx) : '.';
}

function toForwardSlash(p: string): string {
  return p.split(sep).join('/');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// Suppress unused-import warning for `stat` — re-exported in case the future
// "deep diff" command needs it.
void stat;
