import { EngineManager } from '@/sync/engine-manager';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import { ApiClient } from '@/client/api';
import { SocketClient } from '@/client/socket';
import { sha256Hex } from '@/sync/hash';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import { FakeSocket, MemoryVault, deferred, encode, flushAsync } from './engine-test-kit';

/**
 * A server edited in the settings tab — a new address or API key — while the
 * old engine of a binding on it is in the middle of a local phase: a note's
 * rename, whose history moves to the new name in IndexedDB. The old engine
 * waits for that phase before it has stopped, and a vault event that came
 * meanwhile went to it and was dropped: a delete made then never reached the
 * queue, and the note came back from the server, although the binding stayed
 * on. Real engines here, on sockets that never connect.
 */

/** Holds the next history move until the test lets it through. */
class HeldMoves extends DocManager {
  private held: { reached: () => void; open: Promise<void> } | null = null;

  hold(): { reached: Promise<void>; release: () => void } {
    const reached = deferred<void>();
    const open = deferred<void>();
    this.held = { reached: () => reached.resolve(), open: open.promise };
    return { reached: reached.promise, release: () => open.resolve() };
  }

  override move(...args: Parameters<DocManager['move']>): ReturnType<DocManager['move']> {
    const held = this.held;
    if (!held) return super.move(...args);
    this.held = null;
    held.reached();
    return held.open.then(() => super.move(...args));
  }
}

const BINDING = 'b1';

async function synced(vault: MemoryVault, log: OperationLog, path: string, id: string) {
  const text = `${path}\n`;
  const hash = await sha256Hex(text);
  vault.files.set(path, encode(text));
  log.setFileMeta({
    bindingId: BINDING,
    relativePath: path,
    serverFileId: id,
    contentHash: hash,
    size: encode(text).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
}

async function setup(): Promise<{
  vault: MemoryVault;
  log: OperationLog;
  docs: HeldMoves;
  settings: { servers: ServerConfig[]; bindings: VaultBinding[] };
  sockets: string[];
  manager: EngineManager;
}> {
  const vault = new MemoryVault();
  const log = new OperationLog();
  const docs = new HeldMoves();
  await synced(vault, log, 'a.md', 'f1');
  await synced(vault, log, 'b.md', 'f2');
  const settings = {
    servers: [{ id: 's1', name: 'Team', url: 'https://old.example.com', apiKey: 'k', addedAt: 0 }],
    bindings: [
      {
        id: BINDING,
        serverId: 's1',
        projectId: 'p1',
        projectName: 'Team',
        localFolder: '/',
        enabled: true,
        lastSyncedAt: 0,
        lastVectorClock: {},
      },
    ],
  };
  const sockets: string[] = [];
  const offline = (): Promise<never> => Promise.reject(new Error('offline'));
  const manager = new EngineManager({
    getSettings: () => settings,
    vault,
    operationLog: log,
    docManager: docs,
    recentlyApplied: new RecentlyApplied(),
    clientId: 'device-1',
    apiClient: (server) => new ApiClient(server, offline, offline),
    socketClient: (server, clientId) => {
      sockets.push(server.url);
      return new SocketClient({
        server,
        clientId,
        factory: () => {
          const socket = new FakeSocket();
          socket.reachable = false;
          return socket;
        },
      });
    },
  });
  await manager.start();
  await flushAsync();
  return { vault, log, docs, settings, sockets, manager };
}

function queued(log: OperationLog): string[] {
  return log
    .dequeueOperations(BINDING)
    .map((op) => [op.opType, op.filePath, op.newPath].filter(Boolean).join(' '));
}

describe('EngineManager — a server edited while its engine finishes a local phase', () => {
  it('queues a delete made while the old engine stops, and the new one is on the new address', async () => {
    const { vault, log, docs, settings, sockets, manager } = await setup();

    // Renamed in Obsidian: the old engine's local phase, held at the history move.
    const moving = docs.hold();
    vault.move('a.md', 'a2.md');
    const renamed = manager.dispatchVaultEvent({
      type: 'rename',
      bindingId: BINDING,
      oldPath: 'a.md',
      newPath: 'a2.md',
      source: 'obsidian',
    });
    await moving.reached;

    // Saved in the settings tab: the same server, a new address.
    settings.servers = [{ ...settings.servers[0]!, url: 'https://new.example.com' }];
    const restarting = manager.refreshFromSettings();
    await flushAsync();

    // Deleted meanwhile — by another tool, seen by the file watcher.
    vault.files.delete('b.md');
    const deleted = manager.dispatchVaultEvent({
      type: 'delete',
      bindingId: BINDING,
      path: 'b.md',
      source: 'fs',
    });
    await flushAsync();
    moving.release();
    await Promise.all([renamed, restarting, deleted]);
    await flushAsync();

    expect(sockets).toEqual(['https://old.example.com', 'https://new.example.com']);
    expect(manager.getEngine(BINDING)?.getStatus()).not.toBe('stopped');
    // Both wait in the queue for the new address.
    expect(queued(log)).toEqual(['RENAME a.md a2.md', 'DELETE b.md']);
    expect(log.getFileMeta(BINDING, 'b.md')).toBeNull();
    await manager.stop();
  });
});
