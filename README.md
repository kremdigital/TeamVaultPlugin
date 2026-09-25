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
- Obsidian 1.7.2+ (desktop only — `isDesktopOnly: true`, the watcher and
  the log need Node APIs that mobile doesn't have)
- Jest + ts-jest, 500+ tests

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
  devices and teammates can receive it. The config folder, `.trash`, `.git`
  and the service files of the OS and other sync tools are never synced (see
  [What is never synced](#what-is-never-synced)).
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

- **Interface language** (default **Same as Obsidian**) — the plugin's
  settings, notices and status bar follow Obsidian's own language: Russian
  when Obsidian runs in Russian, English otherwise. **Русский** or
  **English** pins one. The settings tab switches at once; command names in
  the command palette follow after the plugin is reloaded (turn it off and on
  in **Community plugins**, or restart Obsidian).
- **Change debounce** (default 500 ms) — how long to wait after a file is
  saved before pushing the change upstream. Higher = fewer round-trips but
  laggier remote view.
- **Notifications** — toasts for connect / disconnect / sync completion.
  Errors, conflicts and a note whose name can't be synced (see
  [What is never synced](#what-is-never-synced)) are always notified
  regardless.
- **Log level** — **Errors only**, **Warnings**, **Info** (default) or
  **Debug**: what goes into `sync.log`. At **Debug** every entry is also
  mirrored to the DevTools console (`Ctrl+Shift+I`). A change applies at
  once, no reload needed.
- **Event log** — **Open log** shows `sync.log` in a window, with **Copy**
  (to the clipboard) and **Clear log** buttons; **Clear log** next to it
  empties the log without opening it. Nothing is written into the vault: the
  log lives in the plugin's own folder and is never synced.

There is no "sync on startup" switch: every binding catches up with the
server whenever it connects, including at startup.

### What is never synced

Some paths are skipped in both directions: they are never uploaded, and a
copy that arrives from the server is neither written to disk nor allowed to
delete or overwrite the local file. A path is skipped when any folder or file
name in it matches — except your vault's config folder, which is matched at
the vault root only, the one place Obsidian reads it from. Names are compared
the way a disk that ignores letter case compares them: `.OBSIDIAN` matches,
and so does a spelling macOS opens as the same folder, such as `.obſidian`
with a long s.

- **Obsidian and Team Vault** — your vault's config folder at the vault root
  (`.obsidian`, or the one you set in Obsidian), a folder named `.obsidian`
  anywhere (another vault's settings), Obsidian's `.trash`, `.git`, and the
  server's own `.versions` / `.staging`.
- **Temporary files** — names ending in `.tmp` or `~`, and the leftovers of
  Obsidian's interrupted saves (`<name>.tmp.<pid>.<hex>`). A folder with
  such a name is skipped with everything in it.
- **Editors** — the owner files Word, Excel and PowerPoint keep next to an
  open document (`~$<name>`), LibreOffice's lock files (`.~lock.<name>#`),
  Vim's swap files (`.<name>.swp`) and Emacs' lock files (`.#<name>`).
- **macOS** — `.DS_Store`, AppleDouble files (`._<name>`), the folder icon
  file `Icon\r` (its name ends in a carriage return), iCloud placeholders
  (`.<name>.icloud`), netatalk's `.AppleDouble` folders, and what macOS keeps
  at the root of a volume: `.Spotlight-V100`, `.fseventsd`, `.Trashes`,
  `.TemporaryItems`, `.DocumentRevisions-V100`.
- **Windows** — `desktop.ini`, `Thumbs.db`, `$RECYCLE.BIN`,
  `System Volume Information`.
- **Linux** — `.directory` (Dolphin) and `.Trash-<uid>` folders.
- **Other sync tools** — Syncthing's `.stfolder`, `.stversions` and
  `.stignore`; Resilio Sync's `.sync` folder and unfinished `*.!sync`
  downloads; Dropbox's `.dropbox`, `.dropbox.attr` and `.dropbox.cache`;
  Google Drive's `.tmp.drivedownload` and `.tmp.driveupload`; the Nextcloud
  and ownCloud client's journal (`.sync_<hex>.db` with its `-wal` / `-shm`
  files) and `.owncloudsync.log`.
- **Names Windows can't keep as spelled** — on Windows such a name opens a
  different file or folder than the one it spells, or can't be written at
  all:
  - any name with a `:` in it (Obsidian doesn't allow one either; on
    Windows `desktop.ini::$DATA` is `desktop.ini` itself);
  - names shaped like a Windows short name: up to 8 characters ending in `~`
    and digits, optionally with an extension of up to 3 (`PROJEC~1`,
    `Draft~1.md`). Windows can store such a name, but it may also be the
    short name of another file or folder, which it then opens instead;
  - names ending in a dot or a space (a folder `Notes.` or `Notes `):
    Windows drops the dot or space, so deleting such a folder there could
    delete the folder `Notes` next to it instead;
  - names with `*`, `?`, `<`, `>`, `"`, `|` or a control character (a note
    `Why?.md`): Windows can't store them.

  Obsidian itself refuses `:` everywhere, and on Windows also `*`, `?`, `<`,
  `>`, `"`, `|` and a name ending in a dot or a space; on macOS and Linux it
  lets you create those. None of these names is synced on any system — not
  even between two Macs — so that no teammate uploads a name another
  teammate's disk can't hold. Unlike the rest of this list, such a name is
  often a note you meant to share, so when you create, edit or rename one in
  Obsidian, a notice names it and what is wrong with it, and `sync.log` gets
  a `warn` line for it (unless **Log level** is **Errors only**). A notice
  comes once per name while the plugin runs, wherever the name turns up;
  names reported within a moment of each other (a link update across many
  notes, a folder copied into the vault) share one notice, and `sync.log`
  lists each of them. A notice comes no sooner than 15 seconds after the one
  before, about when that one goes by itself, and takes in what was reported
  meanwhile.
  A rename that keeps the name at fault — renaming the folder above such a
  note, or moving the note within its binding — isn't reported, since
  nothing changes for your teammates; moving it into the folder of another
  binding (one an older version made) is. Renaming or moving a synced note to
  such a name works like deleting it for your teammates: a notice says so for
  every such rename, even if the name was reported before or the same note
  was renamed so earlier (renames close together share one notice), and
  `sync.log` gets a line for each, naming the note it was.

  Rename the note to sync it. A note an older version already synced under
  such a name is still on the server: rename it in the project's web
  interface (or have an MCP agent do it), and teammates get it under the new
  name, history included. Renamed in Obsidian, the note is uploaded as a new
  one, and the old one stays on the server, where teammates on older
  versions still see it, until someone deletes it there. The same goes for a
  folder with such a name: rename it, or the notes in it, in the web
  interface or through MCP.

  After such a rename in the web interface, teammates on an older version
  see the note renamed. Anyone with this version who already has a copy
  under the old name keeps it next to the renamed note, no longer synced.
  For a name with `:`, `*`, `?`, `<`, `>`, `"`, `|` or a control character,
  that is anyone on a Mac or Linux: Windows can't store such a name. For a
  name ending in a dot or a space, or a short name such as `Draft~1.md`, it
  is anyone at all, Windows included: an older version wrote such names
  there as spelled. Everyone who has such a copy — you included — deletes
  it, after copying over any edits made in it since the update, which never
  reached the server. The notice about such a copy says so too.

  On Windows, take care deleting a copy whose name ends in a dot or a space.
  File Explorer, a plain `rd` or `del`, and Obsidian with **Deleted files**
  (**Settings → Files and links**) at **Move to system trash**, the default,
  all drop the dot or space and delete the file or folder named without it:
  the synced folder `Notes` instead of the copy `Notes.`, and the plugin then
  deletes `Notes` for the whole team. Set **Deleted files** to **Move to
  Obsidian trash** or **Permanently delete** before deleting such a copy in
  Obsidian, or delete it from a command prompt by its full path with the
  `\\?\` prefix, which keeps the name as spelled:
  `rd /s "\\?\C:\Vault\Notes."` for a folder, `del "\\?\C:\Vault\Plan.md."`
  for a file.

The list is built in and the same on every device, so there is no setting
for it. Such files that an older version already uploaded stay on the
server; the plugin leaves them alone, and your own copy stays on your disk
without syncing any more. Renaming a note to a name on the list works like
moving it to the trash: teammates see it deleted, and your copy stays on
your disk only.

## Commands

Available from the command palette (`Ctrl/Cmd-P`), where Obsidian lists
them under the plugin's name:

- **Team Vault: Sync now** — runs a deep diff against every active
  binding (catches files that drifted while the plugin was offline).
- **Team Vault: Pause sync** — disconnects every engine until you resume.
  Shown only while sync runs.
- **Team Vault: Resume sync** — reconnect after a manual pause. Shown only
  while paused.
- **Team Vault: Toggle active file history** — opens the right-pane history
  view for the file currently in focus, or closes it if it is open.
- **Team Vault: Open settings** — focuses the plugin's settings tab.

With the interface in Russian the names are Russian too, e.g.
**Team Vault: Синхронизировать сейчас**.

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

Click the widget for an action menu: **Sync now** and **Pause** — or only
**Resume** while paused — then **Active file history** and **Open settings**.

## Troubleshooting

**"Test" fails with "Invalid API key"** — the key was rotated server-side, or
you copied an extra space. Generate a fresh one in the web UI.

**"Test" fails with a network error** — confirm the URL (no trailing slash
needed; the plugin trims it) and that the server is reachable from this
machine. Try `curl -H "X-API-Key: osk_…" https://your-server/api/auth/me`.

**Status stays at `connecting…`** — the plugin handles the WebSocket
upgrade; if your reverse proxy doesn't pass `Upgrade` / `Connection`
headers cleanly, the socket can't establish. Check Caddy / nginx logs.

**Files don't sync** — open the log via Settings → Team Vault → Behavior →
**Open log**.
Look for `[error]` lines. Common causes:

- The binding is switched off (toggle in **Team Vault → Vaults**).
- The file's name is on the built-in ignore list — see
  [What is never synced](#what-is-never-synced). Local files like that are
  skipped without a log line, except a name Windows can't keep: when you
  create, edit or rename such a note, it gets a notice and a `warn` line
  `not synced: Windows cannot keep this name as spelled`. One the server
  still holds is logged as
  `refused a path supplied by the server` with `"reason":"ignored"` (or
  `"invalid"` for a name Windows can't keep as spelled) — at `warn`
  once per path while the plugin runs, and at `debug` after that. With
  **Log level** at **Errors only** neither `warn` line is written; raise the
  level, then edit the note (for a path from the server, run **Pause sync**
  and **Resume sync**) to see it.
- A binding made by an older version points to a subfolder that no longer
  exists — remove it and bind the vault again. Note that the new binding
  covers the whole vault, so every note in it goes to the project.

**External agent edits don't propagate** — the FS watcher uses chokidar
on the vault root and respects the same ignore list: the config folder,
`.trash`, `.git`, the server's own `.versions` / `.staging`, temporary files,
editors' lock and swap files, and the service files of the OS and other sync
tools (`.DS_Store`, `desktop.ini`, `Thumbs.db`, `.stfolder`, … — the full list
is in [What is never synced](#what-is-never-synced)). For a binding made to a
subfolder by an older version, files outside that folder are correctly
ignored.

**"The plugin settings file is damaged" notice** — the plugin's `data.json`
(in `.obsidian/plugins/team-vault/`) isn't valid JSON any more, usually
after a hand edit. The plugin doesn't start rather than overwrite it. Fix the
file (a stray comma is the usual culprit; `sync.log` has the parser's error
with its position) or restore it from a backup, then turn the plugin off and
on in Settings → Community plugins. Don't delete the file: that resets the
plugin — servers, keys and bindings — and its unsent offline changes are
dropped.

**"Could not open the plugin settings file" notice** — another program (an
antivirus, a cloud-sync client) kept `data.json` locked while the plugin
started. Close it or wait a moment, then turn the plugin off and on.

**"Part of the plugin settings file could not be read" notice** — `data.json`
is valid JSON, but a server or a binding in it lacks a field the plugin needs
(a binding's `id`, `serverId` or `projectId`; a server's `id`, `url` or
`apiKey`) or isn't the right shape, usually after a hand edit. The plugin
starts with the rest. The skipped entries don't sync, but they stay in the
file as they are, and their unsent offline changes are kept: the start-up
cleanup of leftover local state is off until they are fixed. `sync.log` names
each one, whatever the log level — its position in the list, its id and the
fields at fault. While a binding is skipped, **Add binding** stays disabled:
the skipped one may be this vault's binding, and a vault holds only one. To
fix or remove the entries, first turn the plugin off in Settings → Community
plugins (or quit Obsidian) — a running plugin saves its settings over your
edit — then edit `data.json` and turn the plugin back on.

**`sync.log` says "another device uses the same id"** — two computers send
changes under one client id, usually because the vault was copied to the
second one (a USB stick, a cloud drive, git) together with
`.obsidian/plugins/team-vault/data.json`. Team Vault applies the other
computer's changes as a teammate's, but the id is also what keeps each
device's changes apart on the server, so give the copy an id of its own: on
the copied computer, quit Obsidian, set `"clientId"` in `data.json` to `""`,
and start Obsidian again. The plugin makes a new id on start.

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
- Don't keep a bound vault in iCloud Drive with **Optimize Mac Storage** on
  macOS 13 or earlier. To free space, macOS swaps a note for a
  `.<name>.icloud` placeholder. Team Vault reads that as the note being
  deleted and deletes it for the whole team. Move the vault out of iCloud
  Drive or turn the optimization off.
- Names that differ only in letter case (`A.md` next to `a.md`, `Notes/`
  and `notes/`) are two files on the server and on Linux, but one on Windows
  and macOS. When a teammate on Linux, the web editor or MCP makes such a
  second name, it doesn't come to a Windows or Mac vault while the first one
  is there; neither file's text changes. A folder a teammate renames only in
  letter case keeps its old case on a Windows or Mac disk: its notes stay
  synced, and a note you create in it goes to the server under the folder's
  old case.
- Project creation is server-only — the plugin binds to existing projects.
- The conflict modal is bare-bones (no image preview, no inline diff).
- The history view is read-only — restoring a version requires the web UI.
- One client id per device, generated on first run; not synced across
  devices (that's by design — vector clock keys must be unique per
  device). A vault copied to another computer together with the plugin's
  `data.json` takes the id along: see "`sync.log` says another device uses
  the same id" under Troubleshooting.

## Development

```bash
CI=1 pnpm install --frozen-lockfile
pnpm build:vault        # production main.js + copy the release files to TEST_VAULT
pnpm dev                # esbuild --watch, unminified, inline sourcemap
pnpm test               # Jest, 500+ tests
pnpm typecheck
pnpm lint               # ESLint + eslint-plugin-obsidianmd, the directory's review rules
pnpm build              # production main.js
pnpm cli help           # protocol-debug CLI emulator
```

`pnpm build:vault` copies `main.js`, `manifest.json` and `styles.css` into
`$TEST_VAULT/.obsidian/plugins/team-vault/`, so `TEST_VAULT` must be set to
the root of a test vault and that plugin folder must exist. The build reads
the variable from the environment only — it doesn't load `.env` files. Set it
in the shell (`TEST_VAULT="/path/to/vault" pnpm build:vault`) or pass a
`.env` to Node yourself; [`.env.example`](./.env.example) shows both.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the gates a change has to pass
and the commit conventions.

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
  i18n/                 # ru / en catalogs, tiny `t()` helper, language pick
  utils/                # logger, debounce, hash, uuid
scripts/
  cli-emulator.ts       # CLI-based protocol debugger
  version-bump.mjs      # `pnpm version` hook: manifest.json + versions.json
  release-notes.mjs     # one version's CHANGELOG section → GitHub release body
  bundle-licenses.mjs   # license notices of bundled packages → end of main.js
tests/                  # Jest, organized 1:1 with src
```

## Security

Found a vulnerability? Please report it privately — see
[SECURITY.md](./SECURITY.md) — rather than in a public issue.

## License

MIT — see [LICENSE](./LICENSE).

`main.js` bundles third-party packages — Yjs, lib0, y-indexeddb,
socket.io-client, chokidar, diff and their dependencies — under their own
licenses (MIT, BSD-3-Clause). The build appends each one's name, version and
full license text to the end of `main.js`, so the notices ship with every
install.
