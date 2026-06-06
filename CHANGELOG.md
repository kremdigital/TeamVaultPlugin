# Changelog

All notable changes to the Team Vault plugin land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [0.2.3] — 2026-06-06

### Fixed

- Large vaults could not finish the initial sync. `project:join` returned the
  full Yjs state of every text file in one ack, so the server loaded hundreds of
  Y.Docs into memory at once and the client applied them synchronously —
  blocking its event loop past the Socket.IO heartbeat, which dropped the socket
  and triggered a reconnect→rejoin livelock (and drove the earlier server OOM).
  The plugin now opts into a **streamed catch-up** (`streamYjs`): the server
  ships the docs as batched `yjs:catchup` events and the client applies each
  batch in its own tick, so neither the event loop nor the UI ever block. Falls
  back to the inline array against older servers.
- Deleting a binding leaked its local state. The binding's rows in the local
  `state.db` (`pending_operations`, `file_meta`, `bindings_state`) were never
  cleaned up, so each delete left dead state behind — including queued
  operations for an engine that no longer exists and can never drain them, so
  the pending queue only grew. `EngineManager` now purges a binding's local
  state the moment it's removed from settings (a merely _disabled_ binding
  keeps its queue for when it's switched back on), and a one-time sweep on
  plugin load mops up state orphaned by earlier versions. No server round-trip
  is involved; only stale local bookkeeping is removed.
- Sync failures were silent everywhere but the status bar. When a binding's
  project was deleted server-side — or any `project:join` / file-index fetch
  failed — the engine flipped to the `error` state but wrote nothing to
  `sync.log` or the DevTools console (the log showed only `plugin loaded`).
  The root cause: the `Logger` built in `main.ts` was never passed down to
  the `SyncEngine`, so the engine had no logger at all. `SyncEngine` now
  takes a logger (forwarded through `EngineManager`) and logs every error
  transition at `error` level with its `bindingId` and the cause, folding
  the HTTP status code into the detail (e.g. `not_found (HTTP 404)`) so a
  deleted project is distinguishable from other failures. Non-error
  transitions log at `debug`. No data was ever at risk — local files stay
  intact; this only restores diagnosability.

## [0.2.2] — 2026-06-02

### Fixed

- A binding's `lastSyncedAt` (in `data.json`) was stamped once at creation
  (`0`) and never updated — the engine only tracked sync state in the local
  SQLite store. The `EngineManager` now reports each catch-up completion
  (engine → `connected`) back to the host via a new `onBindingSynced`
  callback, which updates the binding's `lastSyncedAt` and persists it.
  It now reflects the last successful sync and refreshes on every reconnect.

## [0.2.1] — 2026-06-02

Security + housekeeping ahead of the catalogue submission.

### Security

- Pinned `ws` to `≥ 8.21.0` via `pnpm.overrides` to clear
  GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure), which entered
  the tree transitively through `socket.io-client`. `pnpm audit` is now
  clean. In Obsidian's Electron renderer `socket.io-client` uses the
  native WebSocket rather than the `ws` package, so the vulnerable code
  did not ship in `main.js`, but the override keeps the dependency tree
  audit-clean.

### Changed

- Removed the legacy development logs (`log.md`, `tasks.md`) from the
  repo. Project/agent documentation now lives at the workspace root.

## [0.2.0] — 2026-06-02

Renamed for Obsidian Community Plugins compatibility.

### Changed

- **BREAKING:** Plugin `id` renamed from `obsidian-team` to `team-vault`.
  The Obsidian Community Plugins catalogue forbids `obsidian` in plugin
  ids; the new id keeps the spirit (a vault for your team) while
  fitting the policy. Display name is now `Team Vault`.
- Plugin install path moves from
  `<vault>/.obsidian/plugins/obsidian-team/` to
  `<vault>/.obsidian/plugins/team-vault/`. Existing installs need to
  reinstall: their settings, operation log (`state.db`), and offline
  Yjs state (`y-indexeddb` databases keyed off the old prefix) live
  under the old path and will not be auto-migrated.
- Command palette entries are now prefixed `Team Vault: …` instead of
  `Obsidian Team: …`.
- Internal `Y.Doc` origin labels, CSS class prefixes, and the y-indexeddb
  `dbName` builder all carry the `team-vault` prefix.

## [0.1.0] — 2026-05-17

Initial MVP release.

### Added

- Settings UI: per-server entries, vault bindings, behavior section
  (debounce, sync-on-startup, notifications, log level, log open / clear).
- REST client (`ApiClient`) covering project listing, file CRUD,
  multipart upload, version listing.
- Socket.IO client (`SocketClient`) with handshake auth, exponential-backoff
  reconnect (1 → 30 s, infinite attempts), typed event subscriptions.
- Local `OperationLog` (better-sqlite3, WAL): pending-operations queue,
  per-file metadata cache, per-binding vector-clock state.
- `DocManager` — Yjs `Y.Doc` cache with y-indexeddb persistence and
  origin-tagged remote-update intake (no echo loop).
- Vault watchers — Obsidian `vault.on(...)` adapter and chokidar for
  external-agent edits, with cross-source dedupe and `RecentlyApplied`
  TTL set.
- `SyncEngine` per binding: catch-up via `project:join`, local→server
  flow for create/modify/delete/rename (text via Yjs, binary via REST),
  server→local flow with `RecentlyApplied` echo suppression.
- `EngineManager` orchestrating per-binding engines, aggregate status,
  pause / resume, deep-sync diff for "Sync now".
- Conflict resolver — three-way binary detection (`detectBinaryConflict`),
  delete-vs-update guard, keep-server / keep-local / keep-both via
  `UiConflictResolver` modal.
- Status bar widget + command palette entries (Sync now / Pause /
  Resume / History / Settings).
- Right-pane History view (`ItemView`) listing server-side versions of
  the active file.
- Notice service that respects `showSyncNotifications` (errors and
  conflict notices always fire regardless).
- File-rotated logger (`Logger` + `FileLogSink` + `ConsoleLogSink` +
  `CompositeLogSink`) writing to
  `<vault>/.obsidian/plugins/team-vault/sync.log` with size-based
  rotation (default 1 MiB, 3 archives). DevTools mirror at debug level.
- Russian + English i18n catalogs (Russian source-of-truth, English in
  parity), automated coverage test.
- CLI emulator (`scripts/cli-emulator.ts`) with `list-projects` /
  `list-files` / `pull` / `push` / `watch` for protocol debugging.

### Fixed during S1–S11 manual-test pass

- `initialPush` no longer races the offline-queue drain on reconnect —
  the two used to fire concurrently and the duplicate emits produced
  server-side `<path>.conflict-<clientId>` twins.
- `replayPending` recomputes the content hash from the fresh disk
  bytes; the stale enqueue-time hash made the server conflict-rename
  every retry of a file that had been edited between create + flush.
- `replayPending` keeps `fileIndex` authoritative on every success
  (CREATE / UPDATE / DELETE / RENAME), so the post-drain `initialPush`
  skips files the queue already synced.
- `refreshFileIndex` preserves the client's last-known `contentHash`
  for known files; overwriting it with the server's current hash made
  `detectBinaryConflict` see "stored == server" for every remote
  update and silently adopt the server's copy without a modal.
- `applyServerUpdateBinary` (plus `applyServerCreate` binary +
  `snapshotDocToDisk`) updates `meta.contentHash` BEFORE the disk
  write, so the inevitable watcher echo's hash compare in
  `handleLocalModify` short-circuits — without this, binary updates
  cascaded into an infinite emit/apply loop.
- `RecentlyApplied.mark(path, count)` is now count-based; one
  system-applied write fans out into multiple watcher events
  (Obsidian + chokidar split into `unlink` + `add` on Windows) and
  every echo gets its own slot in the budget. The conflict-keep-both
  branch marks both source and destination paths with the right
  per-op counts.
- `handleLocalCreate` / `handleLocalDelete` guard against stale
  watcher events whose on-disk state no longer matches the event type
  (atomic-rename leftovers + chokidar `unlink` mid-overwrite).
- Catch-up replay (`applyServerOperation`) skips stale ops whose file
  was deleted / re-created / already moved on the server since the op
  was logged — prevents spurious delete-vs-update modals, 404s on
  binary downloads, and inflated `fileIndex` entries.
- `applyServerRename` drops the stale source when the destination
  already exists locally instead of throwing "Destination file
  already exists" and crashing the engine to `error`.
- Yjs offline edits made while disconnected are pushed back to the
  server on reconnect via `encodeStateAsUpdate(localDoc,
serverStateVector)` — previously they stayed stuck in
  `y-indexeddb` and the server treated every subsequent live edit as
  a no-op replay.
- Server contract: `file_not_found` is now the message for
  UPDATE/DELETE/RENAME on a missing file, matching the plugin's
  non-retryable suffix heuristic so a single dead-letter op no longer
  halts the whole offline-queue drain.
- Server `applyCreate` revives a soft-deleted tombstone at the same
  path instead of hitting the `@@unique([projectId, path])`
  constraint; `applyMove` clears a tombstoned target the same way.
- Server `file:create` for TEXT broadcasts the seeded Yjs state
  alongside `file:created` so peers materialise the content on disk
  without waiting for their next `project:join`.
- Server `project:join` ships `stateVector` per `yjsDoc` so the
  client can compute the inverse delta for the offline-resync push.
- `_count.files` aggregates filter `deletedAt: null` so the project
  dashboard counter matches the actual listing.
- History view command toggles instead of just opening; the sidebar
  tab has no inline close X and "right-click → Close" is poor
  discoverability.
- "Open log" renders into an in-app modal instead of a vault note —
  the note used to get picked up by the sync engine and propagated
  debug dumps to every other vault and the server.

### Tests

26 Jest suites, 281 unit and integration tests covering every module
boundary plus the engine's main flows (create / delete / yjs update /
offline queue / reconnect drain / conflict resolver branches / catch-up
stale-op guards / dual-watcher echo suppression). Server: 12 unit + 9
integration test files, 48 + 64 tests respectively.

### Known limitations

- Desktop only — `better-sqlite3` and `chokidar` are native dependencies.
- Project creation is server-side only.
- History view is read-only; version restore lives in the web UI.
- The conflict modal renders sizes and paths, no image preview or inline
  diff yet.
