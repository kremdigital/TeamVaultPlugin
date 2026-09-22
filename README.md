# Team Vault — Plugin

Self-hosted vault synchronization for Obsidian: edits to the same note from
different devices merge through a Yjs CRDT, offline edits catch up on
reconnect, and every file keeps its version history. Companion to the
[Team Vault server](https://github.com/kremdigital/TeamVaultServer).

- Plugin (this repo): <https://github.com/kremdigital/TeamVaultPlugin>
- Server: <https://github.com/kremdigital/TeamVaultServer>

> **Status:** MVP, desktop-only. Mobile support deferred.

## What it does

- **Text notes merge instead of overwriting** — when Obsidian saves a note
  (about two seconds after you type), the plugin folds the change into the
  note's Yjs CRDT document and sends it to the server; other devices merge it
  with their own edits and write the result to disk within a few seconds.
  Edits to the same note from different devices are combined without
  conflict prompts. Changes travel save by save, not keystroke by keystroke
  — see Limitations.
- **Binary files** — versioned via REST snapshots. A three-way conflict
  prompt opens when both sides have diverged from the same starting hash
  (keep-server / keep-local / keep-both).
- **Offline-first** — edits made while disconnected queue in a local
  operation log; the engine drains the queue on reconnect with
  exponential-backoff reconnect to the server.
- **External edits** — chokidar watches the filesystem, so changes from CLI
  scripts and AI agents propagate the same way as in-app edits.
- **Version history** — right-pane view shows every server-side version of
  the active file, with author and timestamp.

## Stack

- TypeScript 5.9, esbuild → `main.js` (CJS, single bundle — no native
  modules, nothing to install alongside it)
- Yjs + y-indexeddb for CRDT
- socket.io-client for live transport
- chokidar for the filesystem watcher
- Obsidian API 1.5+ (desktop only — `isDesktopOnly: true`, the watcher and
  the log need Node APIs that mobile doesn't have)
- Jest + ts-jest, 350+ tests

## Network use and privacy

Team Vault is the client half of a self-hosted setup, so it does talk to a
server — here is exactly what that means:

- **The only remote host contacted is the server URL you enter yourself.**
  There is no vendor backend, no default endpoint, no fallback host. Nothing
  leaves your machine until you add a server and bind the vault.
- **An account on that server is required**, in the form of an API key you
  generate in its web UI. The key is stored in plain text in the plugin's
  `data.json`, inside your vault's config folder — keep that folder out of
  git and out of other sync tools. Team Vault never syncs the config folder
  itself, whatever the server asks for.
- **Synced content is the content of the bound vault** — note text, binary
  attachments, paths, and their edit history — sent to your server so other
  devices and teammates can receive it. The config folder, `.trash` and
  `.git` are never synced.
- **No telemetry, no analytics, no crash reporting.** The plugin sends
  nothing anywhere else, and collects nothing about you.
- **Logs stay local**, in `.obsidian/plugins/team-vault/sync.log`.

The server is open source and self-hosted:
[kremdigital/TeamVaultServer](https://github.com/kremdigital/TeamVaultServer).

## Installation

Install manually until the directory listing lands:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest
   release on GitHub.
2. Copy them into `<your-vault>/.obsidian/plugins/team-vault/`.
3. In Obsidian → **Settings → Community plugins**, enable **"Team Vault"**.
4. Open the **Team Vault** tab in Settings to add a server.

Those three files are all there is — since 0.3.0 the plugin has no native
dependencies, so there is no `node_modules` to install next to it.

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

### 3. Bind the vault to a project

1. Make sure the project exists on the server (create it via the web UI;
   the plugin doesn't create projects).
2. In **Team Vault → Vaults**, click **Add binding**.
3. Pick the server and the project. The whole vault is synced — the folder
   Obsidian opens is the one you mean, so there is nothing else to choose.
4. Click **Bind**.

A vault holds one binding. To sync it with a different project, remove the
current binding first. Bindings made by older versions to a subfolder keep
working as they are — but once removed, a subfolder can't be bound again:
the new binding covers the whole vault and uploads everything in it to the
project.

The plugin connects to the server, pulls the file list, and starts
synchronizing. The status bar shows the aggregate state.

### 4. Behavior settings

- **Change debounce** (default 500 ms) — how long to wait after a file is
  saved before pushing the change upstream. Higher = fewer round-trips but
  laggier remote view.
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

- The binding is switched off (toggle in **Team Vault → Vaults**).
- A binding made by an older version points to a subfolder that no longer
  exists — remove it and bind the vault again. Note that the new binding
  covers the whole vault, so every note in it goes to the project.

**External agent edits don't propagate** — the FS watcher uses chokidar
on the vault root and respects the same ignore list: the config folder,
`.trash`, `.git`, and the server's own `.versions` / `.staging`. For a
binding made to a subfolder by an older version, files outside that folder
are correctly ignored.

**Conflict modal keeps showing** — happens for binary files when both
sides changed since the last sync. Pick "Keep server" if you trust the
server's copy, "Keep local" to push yours, or "Keep both" to keep your
edits in `…conflict-<ts>.<ext>`.

## Limitations (MVP)

- No live co-editing inside Obsidian's editor: changes travel when Obsidian
  saves the note, not keystroke by keystroke, and there are no remote
  cursors. If a teammate's change arrives while you have unsaved typing in
  that note, Obsidian merges your typing into it and shows a "modified
  externally" notice; if you both changed the same words, part of your
  unsaved typing can be lost. To type together in real time, use the web
  editor of the Team Vault server.
- Desktop only: the filesystem watcher and the log both use Node APIs that
  Obsidian mobile doesn't expose.
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
pnpm test               # Jest, 350+ tests
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
  crdt/                 # Y.Doc cache, text-diff helper
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
