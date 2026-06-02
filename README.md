# Team Vault — Plugin

Self-hosted vault synchronization for Obsidian with live collaborative editing
through Yjs CRDT, offline-first edits, and version history. Companion to the
[Team Vault server](https://github.com/kremdigital/TeamVaultServer).

- Plugin (this repo): <https://github.com/kremdigital/TeamVaultPlugin>
- Server: <https://github.com/kremdigital/TeamVaultServer>

> **Status:** MVP, desktop-only. Mobile support deferred.

## What it does

- **Live collaboration on text files** — edits propagate per-character via
  Yjs CRDT; concurrent typing on two devices merges cleanly without conflict
  modals.
- **Binary files** — versioned via REST snapshots. A three-way conflict
  prompt opens when both sides have diverged from the same starting hash
  (keep-server / keep-local / keep-both).
- **Offline-first** — edits made while disconnected queue in a local SQLite
  log; the engine drains the queue on reconnect with exponential-backoff
  reconnect to the server.
- **External edits** — chokidar watches the filesystem, so changes from CLI
  scripts and AI agents propagate the same way as in-app edits.
- **Version history** — right-pane view shows every server-side version of
  the active file, with author and timestamp.

## Stack

- TypeScript 5.9, esbuild → `main.js` (CJS, single bundle)
- Yjs + y-indexeddb + y-codemirror.next for CRDT
- socket.io-client for live transport
- chokidar for the filesystem watcher
- better-sqlite3 for the local operation log
- Obsidian API 1.5+ (desktop only — `isDesktopOnly: true`)
- Jest + ts-jest, 260+ tests

## Installation

The plugin is not yet on Obsidian's Community Plugins list. Install manually:

1. Download `main.js` and `manifest.json` from the latest release on GitHub.
2. Copy them into `<your-vault>/.obsidian/plugins/team-vault/`.
3. In Obsidian → **Settings → Community plugins**, enable **"Team Vault"**.
4. Open the **Team Vault** tab in Settings to add a server.

## Configuration

### 1. Get an API key from the server

In the web UI of your Team Vault server (e.g. `https://sync.example.com`):

1. Sign in.
2. Go to **API Keys** in the sidebar.
3. Click **Create new key**, give it a name (e.g. "Laptop"), and copy the
   shown `osk_…` value. You won't see it again.

### 2. Add the server to the plugin

In Obsidian → **Settings → Team Vault → Servers**:

1. Click **Add server**.
2. Enter a display name, the server URL (`https://...`), and the API key.
3. Click **Test** — the modal verifies the key by calling
   `GET /api/auth/me` and prints the matching email on success.
4. Click **Save**.

### 3. Bind a vault folder to a project

1. Make sure the project exists on the server (create it via the web UI;
   the plugin doesn't create projects).
2. In **Team Vault → Vaults**, click **Add binding**.
3. Pick the server, the project, and the local folder. **`/` (root) means
   the entire vault.**
4. Click **Bind**.

The plugin connects to the server, pulls the file list, and starts
synchronizing. The status bar shows the aggregate state.

### 4. Behavior settings

- **Change debounce** (default 500 ms) — how long to wait before pushing a
  modify upstream. Higher = fewer round-trips but laggier remote view.
- **Sync on startup** — catch up with accumulated changes when the plugin
  loads. Leave on.
- **Notifications** — toasts for connect / disconnect / sync completion.
  Errors and conflict notices always fire regardless.
- **Log level** — `error` / `warn` / `info` / `debug`. Debug also mirrors
  every entry to DevTools.
- **Open log / Clear log** — copy `sync.log` into the vault as a markdown
  fence so you can read it without leaving Obsidian.

## Commands

Available from the command palette (`Ctrl/Cmd-P`):

- **Team Vault: Sync now** — runs a deep diff against every active
  binding (catches files that drifted while the plugin was offline).
- **Team Vault: Pause** — disconnects every engine until you resume.
- **Team Vault: Resume** — reconnect after a manual pause.
- **Team Vault: Active file history** — opens the right-pane history
  view for the file currently in focus.
- **Team Vault: Open settings** — focuses the plugin's settings tab.

## Status bar

The status bar widget reports the aggregate state across every active
binding:

| Icon           | State        | Meaning                                      |
| -------------- | ------------ | -------------------------------------------- |
| `check-circle` | `connected`  | Every binding is connected and up to date.   |
| `refresh-cw`   | `syncing`    | At least one binding is mid-sync.            |
| `refresh-cw`   | `connecting` | Initial handshake in progress.               |
| `pause`        | `paused`     | You pressed Pause.                           |
| `wifi-off`     | `offline`    | Every binding lost the server.               |
| `alert-circle` | `error`      | One or more bindings hit an error (see log). |
| `circle`       | `idle`       | No active bindings yet.                      |

Click the widget for an action menu (Sync now / Pause-or-Resume / History
/ Settings).

## Troubleshooting

**"Test" fails with "Invalid API key"** — the key was rotated server-side, or
you copied an extra space. Generate a fresh one in the web UI.

**"Test" fails with a network error** — confirm the URL (no trailing slash
needed; the plugin trims it) and that the server is reachable from this
machine. Try `curl -H "X-API-Key: osk_…" https://your-server/api/auth/me`.

**Status stays at `connecting…`** — the plugin handles the WebSocket
upgrade; if your reverse proxy doesn't pass `Upgrade` / `Connection`
headers cleanly, the socket can't establish. Check Caddy / nginx logs.

**Files don't sync** — open the log via Settings → Behavior → "Open log".
Look for `[error]` lines. Common causes:

- The binding's local folder doesn't exist in the vault.
- The folder is the same as another binding's (the plugin disallows
  overlapping bindings; the modal warns at bind time).

**External agent edits don't propagate** — the FS watcher uses chokidar
on the vault root and respects the same `.obsidian` / `.git` /
`.versions` ignore list. Files outside any binding's local folder are
correctly ignored.

**Conflict modal keeps showing** — happens for binary files when both
sides changed since the last sync. Pick "Keep server" if you trust the
server's copy, "Keep local" to push yours, or "Keep both" to keep your
edits in `…conflict-<ts>.<ext>`.

## Limitations (MVP)

- Desktop only (better-sqlite3 + chokidar are native; mobile builds need
  a different storage layer).
- Project creation is server-only — the plugin binds to existing projects.
- The conflict modal is bare-bones (no image preview, no inline diff).
- The history view is read-only — restoring a version requires the web UI.
- One client id per device, generated on first run; not synced across
  devices (that's by design — vector clock keys must be unique per
  device).

## Development

```bash
pnpm install
pnpm dev:vault          # esbuild --watch + copy to TEST_VAULT
pnpm test               # Jest, 260+ tests
pnpm typecheck
pnpm lint
pnpm build              # production main.js
pnpm cli help           # protocol-debug CLI emulator
```

`pnpm dev:vault` requires `TEST_VAULT` to point at a vault folder; copy
`.env.example` to `.env` and edit.

## Layout

```
src/
  main.ts               # plugin entry — wires every subsystem together
  settings/             # settings types + tab UI + add-server / add-binding modals
  client/               # REST + Socket.IO clients
  sync/                 # operation-log, vector-clock, engine, engine-manager,
                        # conflict, reconnect, hash, file-type, vault-adapter
  crdt/                 # Y.Doc cache, text-diff helper, editor binding
  watcher/              # ObsidianWatcher + FsWatcher + path utilities
  ui/                   # status bar, commands, notice service, history view,
                        # conflict modal
  integration/          # concrete Obsidian adapters (vault, log storage,
                        # watchable vault)
  i18n/                 # ru / en catalogs + tiny `t()` helper
  utils/                # logger, debounce, hash, uuid
scripts/
  cli-emulator.ts       # CLI-based protocol debugger
tests/                  # Jest, organized 1:1 with src
```

## License

MIT — see [LICENSE](./LICENSE).
