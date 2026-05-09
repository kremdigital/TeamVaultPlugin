# Changelog

All notable changes to the Obsidian Team plugin land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-05-08

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
  `<vault>/.obsidian/plugins/obsidian-sync/sync.log` with size-based
  rotation (default 1 MiB, 3 archives). DevTools mirror at debug level.
- Russian + English i18n catalogs (Russian source-of-truth, English in
  parity), automated coverage test.
- CLI emulator (`scripts/cli-emulator.ts`) with `list-projects` /
  `list-files` / `pull` / `push` / `watch` for protocol debugging.

### Tests

26 Jest suites, 261 unit and integration tests covering every module
boundary plus the engine's main flows (create / delete / yjs update /
offline queue / reconnect drain / conflict resolver branches).

### Known limitations

- Desktop only — `better-sqlite3` and `chokidar` are native dependencies.
- Project creation is server-side only.
- History view is read-only; version restore lives in the web UI.
- The conflict modal renders sizes and paths, no image preview or inline
  diff yet.
