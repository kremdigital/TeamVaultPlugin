# Changelog

All notable changes to the Team Vault plugin land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [0.2.8] — 2026-06-22

### Fixed

- **Large binary files (10–15 MB storyboard images) broke the sync
  connection.** Binary file bytes were shipped over the Socket.IO channel as a
  JSON `number[]` (~3.7× inflation), blowing the server's 16 MB message limit
  and dropping the socket into a reconnect loop — files above ~3.6 MB never
  synced (dense `websocket error` / `timeout` / `network (HTTP 0)` in
  `sync.log`). Binary bytes now upload out-of-band over REST to a
  content-addressed staging endpoint (`PUT /blobs/:hash`) via `fetch` — which
  streams large bodies off the renderer thread, unlike Obsidian's `requestUrl`
  — and the `file:create` / `file:update-binary` socket op carries only
  metadata. The socket stays sized for tiny Yjs ops. Text files are unchanged
  (content still rides inline and seeds Yjs). **Requires the matching server
  build** (staging endpoint + CORS for the Obsidian origin).

### Changed

- Binary downloads (`downloadFile` / version downloads) now use the `fetch`
  transport as well; JSON requests stay on `requestUrl`.

## [0.2.7] — 2026-06-12

### Fixed

- **Every Obsidian launch re-uploaded the vault and conflict-renamed
  diverged files.** While the vault index loads at startup, Obsidian fires
  `vault.on('create')` for _every existing file_. The watchers were
  registered in `onload()`, so each launch turned into a vault-sized
  create-flood that raced the engine's file-index refresh: paths the index
  couldn't classify yet were emitted as `file:create`, and the server
  conflict-renamed every one whose content hash had diverged — 120 junk
  `<name>.conflict-<clientId>.md` copies in two seconds on 2026-06-12 (and
  the same signature as the 2026-06-07 burst "right after reload").
  Watchers now attach via `workspace.onLayoutReady` (the initial scan never
  reaches the engine), and as defense in depth the engine queues — rather
  than emits — any CREATE that arrives before the file index is ready; the
  post-connect drain then routes server-known paths through the modify
  path.
- **Doubled file content ("snowball" duplication).** Editing a text file
  whose local `Y.Doc` had no ops yet — fresh offline store after a database
  rename, a doc whose catch-up batch hadn't landed, or y-indexeddb still
  loading — diffed the entire disk text into an empty doc. That full-content
  insert was a _second, independent_ insertion of content the server already
  held (its CREATE-time seed), and the CRDT merge kept both copies: every
  affected file ended up with its whole text repeated under itself (observed
  2026-06-12: 101 files; same shape as 2026-06-04: 203 files). Local text
  modifies now await the offline store and **defer** when the doc is op-less
  while the server is known to have content; the doc then hydrates via the
  catch-up stream or the live seed broadcast, and the next snapshot folds the
  disk edits in as a minimal diff over the server's copy.
- **Half-applied docs could snapshot to disk.** A `yjs:update` delivered
  out of order parks in Yjs as a pending struct; the doc's visible text is a
  stale subset (or empty) until the missing update arrives. The disk
  snapshot ran regardless, truncating or rolling the file back — one of the
  silent-rollback shapes in the 2026-06-12 incident. Snapshots now skip
  op-less docs for files the server has content for and any doc with pending
  remote updates; the completing update triggers its own snapshot with the
  full merged state.
- **Catch-up rewrote every text file on every connect.** The snapshot path
  wrote the doc text to disk even when the file already matched byte-for-byte
  — a mass write storm on each reconnect (hundreds of files) that churned
  Obsidian's atomic-write temp files (the orphaned `*.tmp.<pid>.<hex>`
  artifacts) and left hundreds of live echo budgets in the watcher
  suppression set, where they swallowed genuine external edits arriving in
  the same window. Unchanged files are no longer rewritten; no write, no
  echo budget, no temp-file churn.
- **Concurrent snapshots of one file could interleave.** A live-update
  debounce and a catch-up batch snapshotting the same path ran their
  read-fold-write sequences concurrently and could clobber each other's
  fold. Snapshots are now serialized per path.
- **Catch-up CREATE replays wiped file metadata.** Re-applying a CREATE for
  an already-indexed file reset its `contentHash`/`size` to empty, breaking
  every downstream three-way compare (binary conflict detection, disk-edit
  folding, the new unhydrated-doc guard). The existing index entry is now
  reused as-is.

## [0.2.6] — 2026-06-12

### Fixed

- **Mass rollback of disk files on reconnect.** Edits made while the plugin
  was off (git operations, external agents, another editor) exist only on
  disk — the `Y.Doc` learns about local changes solely through watcher
  events. The catch-up flow applied the server's doc state and immediately
  snapshotted it to disk, silently rolling such files back to the last
  server-known version (observed 2026-06-12: 56 freshly-edited files reverted
  at once). Snapshots now _fold_ unseen disk edits into the doc first: when
  the bytes on disk differ from the last hash the engine itself synced, the
  disk content is diffed into the CRDT (so it survives the merge and is
  pushed to the server) before anything is written. When the disk is
  unchanged since the last sync, server content applies as before.
- **Catch-up raced the offline doc store.** Nothing awaited y-indexeddb's
  `whenSynced` before catch-up applied server state and snapshotted to disk,
  so a doc could be observed half-loaded (effectively empty) — producing both
  a bogus push-back diff and a rollback-style disk write. The engine now
  awaits `DocManager.whenSynced` (with a 10 s cap so a wedged IndexedDB
  degrades instead of stalling) before using a doc in catch-up or snapshots.
- **Offline CREATE replay spawned `.conflict-<clientId>` duplicates.** A file
  touched while the engine was offline (e.g. a git checkout over synced
  files) queued a CREATE; on reconnect it replayed as `file:create` for a
  path the server already tracked with different content, so the server
  conflict-renamed the upload — 56 junk `<name>.conflict-<clientId>.md`
  copies in the 2026-06-12 incident. The replay now consults the refreshed
  file index: a server-known path routes through the modify path (Yjs diff
  for text, binary UPDATE) instead of a re-create.
- **Orphaned Obsidian atomic-write artifacts synced as real notes.** Obsidian
  writes files as `<name>.tmp.<pid>.<hex>` + rename; a crash or locked target
  orphans the temp file. The watcher's ignore list only matched the literal
  `.tmp` suffix, so the artifacts were watched, uploaded by the initial-push
  pass, and never cleaned up. They are now always ignored (watchers and
  initial push), and a startup sweep deletes orphans from previous sessions
  (the embedded pid differs from the running process) inside binding folders.

## [0.2.5] — 2026-06-07

### Fixed

- **Critical data corruption on non-Latin vaults.** Each text file's offline
  `y-indexeddb` database was named `team-vault-{bindingId}-{slug}`, where the
  slug was `filePath.replace(/[^a-zA-Z0-9._-]+/g, '_')` — every non-ASCII
  character (all Cyrillic / CJK letters) and `/` collapsed to `_`. On a
  Cyrillic vault this made distinct paths share **one** database name
  (`персонажи/андрей-перминов.md` and `персонажи/иван-воренок.md` both →
  `_-_.md`), so dozens of files read and wrote the **same** offline CRDT store.
  Their `Y.Doc` contents accumulated into each other and every affected file
  hydrated with the concatenated text of all its name-collisions — pages mixed
  together across files, growing on each sync. The database name is now a
  lossless, injective function of the path (`encodeURIComponent`), so distinct
  files never share a store. A vault already corrupted by this bug must restore
  the affected files from a clean snapshot and re-seed the server — the fix
  prevents recurrence but cannot un-mix already-merged documents. ASCII-only
  vaults were unaffected (their slugs never collided).

## [0.2.4] — 2026-06-07

### Fixed

- Deleting a binding leaked its **offline CRDT state** — the local-state
  analogue of the `state.db` leak fixed in 0.2.3. Each tracked text file keeps
  a per-file `y-indexeddb` database (`team-vault-{bindingId}-{slug}`); removing
  a binding only closed any open connections — it never deleted the databases,
  and files not opened that session (the common case for a binding you're
  deleting) were never touched at all, so a deleted binding's Yjs stores piled
  up on disk forever. `DocManager.purgeBinding` now clears cached docs through
  y-indexeddb's `clearData()` and enumerates + deletes every
  `team-vault-{bindingId}-*` database. It fires in the same two places as the
  operation-log purge: when a binding is removed from settings (not merely
  _disabled_, which keeps its offline edits for when it's switched back on),
  and the one-time startup sweep. Local-only cleanup — the sync wire protocol
  is untouched.

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
