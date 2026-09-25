# Changelog

All notable changes to the Team Vault plugin land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **Server paths that Windows resolves to a different file are refused.**
  The path gate compared names as spelled, so on Windows a path in NTFS
  stream syntax (`name::$DATA`, `folder::$INDEX_ALLOCATION`) or an 8.3 short
  name (`NAME~1`) could reach a file or folder the gate refuses by its real
  name — the config folder or `.git`. Any name with a `:` in it (Obsidian
  doesn't allow one either) and any name shaped like a Windows short name —
  up to 8 characters ending in `~` and digits, with an optional extension of
  up to 3 — is now never synced, in either direction and on every system.
- **Server paths spelled so that a Mac opens a folder the plugin refuses are
  now refused.** The path gate compared names by lower case only. A
  case-insensitive Mac disk (APFS, the macOS default) also treats `ſ` (long s)
  as `s`, `ß` and `ẞ` as `ss`, and ligatures such as `ﬁ` as their letters, and
  older Mac disks (HFS+) skip some invisible characters when they compare
  names. So a project member could name a file
  `.obſidian/plugins/team-vault/data.json`: the gate let it through, and on a
  Mac that path led to the plugin's own settings file, API key included. Names
  are now compared the way these disks compare them, and fullwidth look-alikes
  such as `．obsidian` count too. This covers the config folder, `.trash`,
  `.git` and every other name on the built-in list, in both directions.
  Ordinary note names sync as before.

### Changed

- **More names that Windows can't keep as spelled no longer sync, on any
  system.** This extends the entry above about `:` and short names. A name
  that ends in a dot or a space (`Notes.`, `Notes `) is now refused, and so is
  a name with `*`, `?`, `<`, `>`, `"`, `|` or a control character (`Why?.md`).
  Obsidian allows these on macOS and Linux, but Windows can't keep them as
  spelled: a `Why?.md` from a Mac stopped a Windows teammate's sync, and
  deleting a synced folder `Notes.` from Obsidian on Windows sent the folder
  `Notes` next to it to the Recycle Bin, a delete that went on to the whole
  team. When you create, edit or rename such a note in Obsidian, a notice
  names it and says what is wrong with the name, even with notifications off,
  and `sync.log` gets a `warn` line for it (unless Log level is Errors only).
  For a note you create or edit in a folder with such a name, such as `U.S.`,
  the notice names the folder and says to rename the folder. Apart from the
  renames below, a notice comes once per name while the plugin runs, wherever
  the name turns up. Names reported within a moment of each other (a link
  update across many notes, a folder copied into the vault) share one notice,
  and a notice comes no sooner than 15 seconds after the one before, taking in
  whatever was reported meanwhile. Renaming the folder above such a note, or
  moving the note within its binding, gives no notice. Renaming or moving a
  synced note to such a name works like deleting it for your teammates: a
  notice says so for every such rename, even of a note renamed so before
  (renames close together share one notice), and `sync.log` gets a line for
  each, naming the note it was. A note an older version already synced under
  such a name stays on the server; to sync it again, rename it in the
  project's web interface or through MCP (renaming it in Obsidian uploads it
  as a new note and leaves the old one on the server). Teammates on older
  versions then see it renamed. Anyone on this version who already has a copy
  under the old name keeps it, no longer synced: on a Mac or Linux for any
  such name, and on Windows too for a name that ends in a dot or a space or a
  short name such as `Draft~1.md`, which older versions wrote there as
  spelled. Copy any edits made in that copy since the update over to the
  renamed note, then delete the copy; the notice says so too. On Windows,
  don't delete a copy whose name ends in a dot or a space in File Explorer, or
  in Obsidian while **Deleted files** is set to **Move to system trash** (the
  default): Windows drops the dot or space and deletes the synced file or
  folder named without it, for the whole team. "What is never synced" in the
  README gives safe ways to delete it.

### Fixed

- **Disabling, reloading or pausing the plugin now stops the sync work
  already under way.** The same goes for switching a binding off. Before, a
  connect-time catch-up, an offline-queue drain, a file download or upload,
  or a note being fetched from the server kept running afterwards: a server
  answer that arrived later still wrote vault files, rewrote the local sync
  state and triggered further requests. Now large file transfers in progress
  are cancelled, and an edit whose upload or acknowledgement was cut short is
  queued and sent when sync resumes. A server rename, delete or file download
  that had already started on disk is finished first, and so is writing a
  teammate's edit into a note, so no stray copy is left behind to be uploaded
  as a new file and a teammate's edit that arrives during that write is
  neither lost nor duplicated when sync resumes. Queued offline edits the server
  has already acknowledged are no longer sent twice; at most the one in
  flight at the moment of stopping goes out again.
- A queued offline edit to an attachment that no longer exists at its path
  no longer halts the whole offline queue. A queued attachment edit whose
  bytes match the last synced version is no longer re-uploaded.
- **A save that lands while Team Vault is writing a teammate's edit into the
  same note is no longer overwritten.** The note is re-read right before the
  write and the save is merged in. A note deleted at that moment is no longer
  written back, and a note deleted at the very moment it is re-read no longer
  makes the connect-time sync fail.
- A teammate's edit is no longer deleted when you save a note while that edit
  is being written to disk and the note has no merge base yet (for example,
  right after upgrading from 0.3.1 or earlier, or after Obsidian's local
  storage was cleared). It also reaches the disk now when git or an external
  editor briefly replaces the note at that moment; before, disk and server
  stayed out of step until the next change.
- **A binding the plugin can't read in `data.json` no longer loses its unsent
  changes.** Sometimes `data.json` is valid JSON but can't be fully used,
  usually after a hand edit: a binding lacks a field it needs (`id`,
  `serverId`, `projectId`), a server lacks its `id`, `url` or `apiKey`, or
  `bindings`/`servers` isn't a list. The plugin used to drop such an entry
  silently; the start-up cleanup then deleted that binding's offline queue and
  offline documents as orphaned, and the next settings save erased the entry
  from `data.json`. Now such entries are skipped but kept: every save writes
  them back in their place, and the cleanup of leftover local state is off
  while they are there. `sync.log` names each one by its position, id and the
  fields at fault, whatever the log level (Errors only included) — never the
  entry itself, which may hold an API key. A notice that stays until
  dismissed says how many entries were skipped and asks you to turn the
  plugin off (or quit Obsidian) before fixing the file. While a binding is
  skipped, **Add binding** is disabled.
- **Service files of the OS, editors and other sync tools no longer sync.**
  Since 0.3.4 a binding covers the whole vault, so `.DS_Store`,
  `desktop.ini`, `Thumbs.db`, Syncthing's `.stfolder` / `.stversions` and
  similar files went to the project and on to every teammate's disk. The
  built-in ignore list now covers macOS (`.DS_Store`, `._*`, `Icon\r`, iCloud
  placeholders, `.AppleDouble`, the volume folders), Windows (`desktop.ini`,
  `Thumbs.db`, `$RECYCLE.BIN`, `System Volume Information`), Linux
  (`.directory`, `.Trash-<uid>`), the lock and swap files of Office,
  LibreOffice, Vim and Emacs, and the service files of Syncthing, Resilio
  Sync, Dropbox, Google Drive and Nextcloud / ownCloud. They are neither
  uploaded nor written to disk, and a copy the server still holds can't
  overwrite or delete the local file. The full list is in the README, under
  "What is never synced".
- A folder named like a temporary file (`drafts~`, `old.tmp`) is now skipped
  with everything in it. Before, the filesystem watcher skipped the folder
  while the Obsidian watcher and the first upload synced the notes inside.
- A path from the server that the plugin refuses is logged at `warn` once per
  path while the plugin runs and at `debug` after that, instead of on every
  reconnect. Pausing and resuming sync, or switching the binding off and on,
  doesn't report it again. With Log level at Errors only the line isn't
  written; once the level is raised, it shows at the next reconnect or after
  Pause sync and Resume sync.
- **A file a teammate renamed or moved while you were offline or Obsidian was
  closed no longer comes back under its old name.** Your copy stayed on disk
  under the old name, and the next start uploaded it as a new file, so every
  teammate got a duplicate. It is now moved to the new name when sync starts.
  This also covers names swapped between two files, a new file created under
  the old name, and a rename that only changes letter case on a Windows or Mac
  disk. A note keeps what you typed into it in the meantime, because its
  offline editing history now moves to the new name with it.
- **A teammate's rename that only changes a file's letter case no longer
  deletes your copy on Windows and macOS.** Team Vault took `photo.png` for a
  second file already there with the same content as `Photo.png`. It then
  deleted the "duplicate", which was the only copy. On a Mac the same happened
  with other spellings the disk treats as one name, such as `Straße` and
  `STRASSE`.
- **A new note no longer takes in the text of the note that had its name
  before.** Team Vault keeps each note's offline editing history in Obsidian's
  local storage, under the note's name. When a note was renamed, moved or
  deleted, its history stayed under the old name. The next note created there
  started from it, and Obsidian reuses "Untitled" for every new note. The old
  note's text got mixed into the new one and went to the server for the whole
  team. Each history now belongs to its note: it moves with the note and is
  deleted with it. A leftover history from an earlier version is discarded when
  another note takes the name.
  - A teammate may delete a note and create a new one under its name while you
    are offline. The new note then no longer gets the deleted note's text back
    when you reconnect, empty new notes included.
  - Edits you made to the deleted note that never reached the server are kept
    next to it as `Name.conflict-<time>.md` and uploaded as a note of their own.
- **A note you deleted while offline stays deleted.** This now also works when
  you open Obsidian without a network connection, and after **Pause sync** and
  **Resume sync** without one. The delete went out when you reconnected, but the
  sync that runs first had already written the note back to disk. There it
  stayed, no longer synced. A new note you saved under the same name meanwhile
  was taken for the deleted one. Its text went to the server as the deleted
  note's, and the new note itself was never uploaded. Now a note leaves Team
  Vault's records as soon as you delete it, and a new note under its name is
  uploaded as a new note. In a session that started offline, the delete used not
  to go out at all. There is one exception: when a teammate changed the note
  while you were offline, or deleted it and created a new note under its name,
  your delete is not sent. Their note comes back to your vault. If you saved a
  new note under the same name in the meantime, yours is kept as
  `Name.conflict-<device>.md`. Before, the delete removed the teammate's note
  for the whole team.
- **A note you renamed while offline no longer comes back under its old name.**
  This now also works when you open Obsidian without a network connection, and
  when you rename a note more than once before you reconnect. Several renames of
  one note are sent as one. A note renamed and then renamed back sends nothing,
  so a teammate's rename of it still applies. The sync that ran before the
  rename was sent wrote the note back under its old name, and that copy was then
  uploaded as a second note. A new note saved under the old name meanwhile was
  taken for the renamed one. The note is now recorded under its new name right
  away.
  - If a teammate gave the name to another note meanwhile, by renaming or
    creating it, the server stores yours as `Name.conflict-<device>.md` and your
    note moves there. The teammate's note keeps the name and comes to your
    vault. Before, the two notes' texts could end up swapped or duplicated for
    the whole team.
  - A rename made while sync is connecting is no longer undone on your disk.
- **A file a teammate deleted while you were offline no longer comes back, and
  no longer stays behind on your disk.** A file renamed and then deleted came
  back under its old name for the whole team: the next start uploaded your
  copy as a new file. A file deleted without a rename stayed on your disk and
  was no longer synced. Both are now removed when sync starts. You are asked
  first only when your copy has changes the server may not have.
- Leftover temporary files from Obsidian's own saves
  (`note.md.tmp.<number>.<hex>`, left behind when Obsidian quits in the middle
  of a save) are now removed at startup, as intended since 0.2.10. The cleanup
  ran before Obsidian had listed the vault's files and never found one. They
  were never synced either way.
- An attachment you edited and then renamed while offline now has its edit
  uploaded. The queued edit looked for the file under its old name, found
  nothing and was dropped, so the server kept the old version until the next
  edit.
- An attachment that was added and then renamed while you were offline is now
  saved under its current name. It used to be written under the name it was
  created with: the current name was missing (broken embeds) and the old name
  was uploaded again as a new file.
- **A file a teammate renames to a name that never syncs** (with an older
  plugin version, the MCP server or the API) **is now removed from your vault,
  as if it had been deleted.** If your copy has changes the server doesn't,
  you are asked first, and **Restore on server** moves the file back to its
  name. Before, your copy stayed under the old name and was uploaded again as
  a new file on the next connect. If the file is later renamed back to a name
  that syncs, it returns. When the rename happened while you were offline, the
  question now comes once sync has connected, and the rest of your vault syncs
  in the meantime. A copy the server already has is removed without a
  question.
- **Renames Team Vault makes on your disk are no longer sent to the server as
  yours.** Obsidian reports every rename in the vault, including the ones Team
  Vault makes to apply a teammate's changes, and Team Vault took them for
  renames you made. When you chose **Keep both** for an attachment, the
  attachment was renamed on the server, for the whole team, to the name of the
  copy kept aside.
- **A note you save or rename again right after renaming it is no longer
  uploaded as a second note.** Until the server confirmed a rename, a save under
  the new name was uploaded as a new note. A second rename (for example, a
  template plugin that renames a note and then moves it) went out without saying
  which note it was, and the next connect uploaded the note again.
- **A new note renamed right after you create it is no longer uploaded twice.**
  This happens with Templater's `tp.file.rename`, or when you type a title on a
  slow connection. The rename now waits for the server to confirm the note and
  goes out as a rename, so the team no longer gets the note under both names and
  the old name no longer comes back after a restart.
- **A note you create while offline under a name a teammate used meanwhile no
  longer overwrites theirs.** Yours is kept as `Name.conflict-<device>.md` and
  theirs keeps the name. Before, your text replaced theirs for the whole team,
  and every save of yours added another conflict copy on the server.
- **A rename, attachment edit or delete made offline no longer hits the new file
  a teammate created under the same name.** The server gives a file created
  again under a deleted file's name the same id. A change queued for the old
  file used to rename the teammate's new file, write the old attachment over it,
  or delete it for everyone. Now such a change is not sent, and the teammate's
  file comes to your vault. A copy of yours with changes the server never had is
  kept as a file of its own.
- **After Restore on server, your next save no longer uploads the file again as
  a new file.** This is the answer to a delete made while you were offline.
  Edits you had not sent before no longer come back doubled.
- **An attachment saved twice in a row no longer goes back to the first version
  on your disk.** The server sends every change back to the device that made it
  too, and Team Vault took its own upload for a teammate's: it downloaded the
  first version again and wrote it over the second.
- When the server stores your rename under another name because a teammate took
  the name first (`Note.conflict-<device>.md`), your note now moves there right
  away. Before, it stayed under the name you gave it until the next connect, and
  the teammate's file with that name did not arrive until then.
- A note deleted while sync is connecting no longer comes back to your disk,
  unsynced.
- **A vault copied to another computer together with its `data.json` no longer
  misses the copy's changes.** Both copies send under one client id, and each
  took the other's new notes, deletes and renames for its own until the next
  connect. They now apply right away, and `sync.log` says that another device
  uses the same id. The README's Troubleshooting section explains how to give
  the copy an id of its own.

## [0.3.7] — 2026-09-23

### Fixed

- **A `data.json` the plugin can't read no longer wipes the plugin's data.**
  A settings file with a stray comma after a hand edit, or one held for a
  moment by an antivirus or a cloud-sync client, was taken for a first run:
  the plugin saved empty settings over it (servers, API keys and bindings
  gone, a new device id) and then deleted every binding's offline queue and
  offline documents as orphaned. Now only a file that isn't there, on two
  looks a quarter of a second apart, counts as a first run. A file that can't
  be read or parsed is retried for about two seconds; if that doesn't help,
  the plugin doesn't start: it writes nothing, cleans nothing up, logs the
  reason (with the parser's error) to `sync.log` and shows a notice that
  stays until dismissed, saying whether the file is damaged or held by
  another program.
- A `data.json` saved as UTF-8 with a byte order mark (PowerShell 5.1, some
  editors) is read instead of being rejected.
- A first run no longer cleans up local state it finds from earlier bindings;
  the next start does, once the settings are known.

## [0.3.6] — 2026-09-23

### Changed

- **A Russian saved by 0.3.5 or earlier now loads as Same as Obsidian.** It
  was never a choice: up to 0.3.4 the plugin had no language setting and
  always saved Russian, and 0.3.5 kept that as if it had been picked, so an
  English Obsidian showed a Russian plugin. A saved English stays English.
  `data.json` gains a `settingsVersion` field, so a language picked from now
  on is kept as picked (a Russian picked explicitly in 0.3.5 has to be picked
  once more).

## [0.3.5] — 2026-09-23

### Added

- **Interface language setting.** A new "Interface language" option under
  Behavior: Same as Obsidian, Русский or English. Same as Obsidian — the
  default for new installs — shows the plugin in Russian when Obsidian runs in
  Russian and in English otherwise. English is now also the fallback for any
  missing translation (it was Russian). Installs upgraded from 0.3.4 or
  earlier keep the Russian they had saved. The settings tab and the status bar
  switch at once; command names switch after the plugin is reloaded.
- **Bundled license notices.** `main.js` now ends with the name, version and
  full license text of every third-party package bundled into it (yjs, lib0,
  y-indexeddb, socket.io-client and its dependencies engine.io-client,
  engine.io-parser, socket.io-parser and @socket.io/component-emitter,
  chokidar, readdirp, diff). Until now only chokidar's notice survived
  bundling, which fell short of diff's BSD-3-Clause terms.
- Releases now carry a signed build provenance attestation for `main.js`,
  `manifest.json` and `styles.css` (`actions/attest`, as in Obsidian's
  official release workflow).
- `SECURITY.md` — how to report a vulnerability privately — and
  `CONTRIBUTING.md` — setup, gates, tests and commit conventions.

### Changed

- **Command names no longer repeat the plugin name.** The command palette
  showed "Team Vault: Team Vault: sync now", now "Team Vault: Sync now"
  ("Pause sync", "Resume sync", "Toggle active file history", "Open
  settings"). Command ids are unchanged, so existing hotkeys keep working.
- **Removing a server or a binding asks in an Obsidian dialog** instead of
  the system `confirm()` box. Enter confirms; Escape, the close button or a
  click outside cancels.
- **Disabling, reloading or updating the plugin shuts it down in order.**
  Vault listeners and the file watcher are detached at once; the vault
  listeners used to stay attached until the file watcher had closed. The rest
  of the shutdown (flushing the offline queue to `state.json`, closing
  offline documents) finishes in the background and logs its failures to
  `sync.log`, and the plugin's next start waits for it, up to 5 seconds,
  before it reads `state.json`. Disabling the plugin no longer pops a
  "connection lost" notice.
- **Log level changes apply at once.** Debug starts mirroring every entry to
  the DevTools console without a plugin reload (and leaving Debug stops it),
  and the sync engines' own log lines follow the new level immediately
  instead of keeping the level they started with until a reload.
- Minimum Obsidian version is now 1.7.2: the History view awaits
  `workspace.revealLeaf`, which returns a promise since 1.7.2.
- Timers, `crypto` and the clipboard now go through `window` /
  `activeWindow`, as the Obsidian plugin guidelines ask for popout-window
  compatibility. The History view uses `createDiv` / `createSpan`.
- The GitHub release body is now just that version's CHANGELOG section
  instead of the whole file. The release workflow fails if the section is
  missing or empty (`node scripts/release-notes.mjs X.Y.Z` prints it).
- README: the Behavior settings, Commands and status bar sections now match
  the plugin. Open log shows `sync.log` in a window with Copy and Clear log
  and writes nothing into the vault.
- This changelog is now entirely in English: the entries for 0.2.10–0.3.4
  were written in Russian.
- Development: `pnpm lint` now runs `eslint-plugin-obsidianmd` 0.4.2 (its
  recommended config, the same rules as the community directory's automated
  review) over the whole repository, including `manifest.json` and
  `package.json`, and refuses to run outside the plugin root.
- Build: dropped the `builtin-modules` dev dependency in favour of Node's own
  `node:module` `builtinModules`. The bundle's code is byte-for-byte
  unchanged.
- The release workflow runs on Node 22 instead of 20; ESLint 10 needs Node
  20.19+, 22.13+ or 24+.

### Removed

- The "Sync on startup" switch: it never did anything, since every binding
  catches up with the server whenever it connects. A `data.json` that still
  has the field loads as before.

### Fixed

- A queued offline operation whose `fileId` in `state.json` is not a string
  is dropped instead of being sent to the server as "[object Object]".
- A `connect_error` that is not an `Error` keeps a readable message.
- The log no longer throws on a circular object without a prototype, or on a
  circular array holding one.
- **Offline changes recorded after the plugin was disabled are kept.** A
  request that was in flight when the plugin was disabled can still settle
  and update the offline queue; the operation log dropped every change made
  after it had closed. It now writes such a change to `state.json` at once —
  until a newer instance of the plugin takes the file over after a reload or
  an update, so an older snapshot never overwrites the newer file.
- Shutting down waits for a `state.json` write already under way. The next
  instance could read the file just before the last queued operation reached
  it, and then overwrite that operation with its own next write.
- Disabling the plugin while it is still starting stops the start where it
  is: no sync engines, settings tab, view, commands or startup clean-up after
  that point (they were never torn down, and the next start failed to
  register its view). A settings change that arrives after the plugin was
  disabled no longer starts an engine, and the old instance no longer writes
  `data.json`, which by then may belong to the next one.
- A `state.json` caught mid-replacement (only `state.json.tmp` on disk, after
  a crash or a reload during a write) is read from the temporary file instead
  of starting with an empty offline queue. When the log has to fall back to
  writing `state.json` in place, it now removes the temporary file, which
  would otherwise come back as the log once `state.json` is deleted by hand.
- Development: `pnpm dev:vault` copies every rebuild into the test vault. It
  used to copy once, before the first build had even finished. The license
  notice collector no longer skips a package that esbuild reports by an
  absolute path (a dependency on another drive on Windows) and fails the
  build rather than leave a notice out.

## [0.3.4] — 2026-09-22

### Changed

- **Folder selection is gone from binding — the whole vault is bound.**
  Obsidian opens a vault as its root, and that is the folder you mean; the
  "Local folder" field was a redundant mandatory step (a binding couldn't be
  saved without picking one). The binding window now says outright that
  everything in the vault goes to the project. Since a binding covers the
  whole vault, it overlaps any other: a vault can hold one binding, and while
  it exists the "Add binding" button is disabled, with an explanation.
  Bindings to subfolders made earlier keep working as they are, but once
  removed, a subfolder can't be bound again — the new binding covers the whole
  vault.

## [0.3.3] — 2026-09-22

### Security

- **The server can no longer name an arbitrary local path.** Everything that
  comes from the server — the file list, catch-up operations, live create,
  rename and move events, text snapshots — passes a single gate
  (`checkVaultPath`). It rejects paths in Obsidian's config folder, in
  `.trash` and `.git`, outside the binding folder, as well as absolute paths
  and `..`; a rejection is written to `sync.log` at `warn` level and doesn't
  stop the other files from syncing.

  Before, rename had no checks at all: a project member with write access
  could rename their file to `.obsidian/plugins/team-vault/data.json`, and a
  teammate's client retargeted its metadata onto that file. From there,
  "Restore on server" uploaded the file — with the API key inside.

### Fixed

- **The config folder is no longer hardcoded as `.obsidian`.** Its name comes
  from `Vault.configDir`. With a non-standard folder (the "Override config
  folder" setting), the vault's entire configuration, `data.json` with the key
  included, was uploaded to the server and to every project member.
- **Obsidian's trash (`.trash`) is not synced.** A note deleted to the trash
  came back to the server as a new file.
- **A rename onto an occupied path no longer silently deletes the local
  file.** If the contents match, the extra copy is deleted, as before; if they
  differ, the local file moves aside to `<name>.conflict-<stamp>.<ext>`.
- Service-folder matching is now case-insensitive: a path like `.OBSIDIAN/…`
  slipped past the filters. Non-ASCII names are compared in a single Unicode
  normalization form (macOS reports NFD, the server stores NFC).
- **The outgoing side is gated too.** Local events and operations from the
  offline queue are checked by the same predicate: the queue lives in
  `state.json` and survives an update, so an upload of `data.json` queued by
  an old build is now dropped instead of going to the server.
- **Deleting a note to Obsidian's trash is sent as a delete.** Before, this
  rename published the trash to the whole team.
- A server rejection with `invalid_path` is final: the operation is dropped
  from the queue. Previously such a rejection looked transient, and one stuck
  operation silently blocked sending all the edits piled up behind it.
- The config folder is matched as a folder at the vault root, not as a name
  anywhere: `Архив/.obsidian-work/` syncs as ordinary notes again. The
  chokidar filter no longer looks at directories above the vault root — a
  vault inside a folder named `.git` or `.trash` is no longer cut off
  entirely.
- **Moving a file outside the binding folder no longer spawns a duplicate.**
  The file moves to where the server said and leaves the index; before, the
  rejection left a local copy, and the initial upload sent it to the server
  as a new file — a second copy of the note for the whole team. Moving back
  into the binding folder works again: such a file materializes as new.
- **A deferred rename into the trash turns into a delete.** Such an operation
  from an old build's queue used to be simply dropped, and the note came back
  to life: it is alive on the server, and the next catch-up wrote it back to
  disk.
- `.staging` (the server's service folder) is added to the ignore list: its
  upload would be rejected by the server forever. A `path_is_directory`
  rejection is also final.
- Without a path to the vault root the filesystem watcher no longer starts:
  it would watch the process's working directory, where path filters make no
  sense.

## [0.3.2] — 2026-09-18

### Fixed

- **An edit from another device was deleted after you saved — everywhere.**
  The engine folded disk text into the CRDT with a two-way "document vs file"
  diff, while the "this disk content is already accounted for" mark
  (`contentHash`) was only updated when a snapshot was written, not on a local
  save. Once you saved a note, the next edit someone else made to it looked
  like your deletion: it was cut from the CRDT, and the deletion went to the
  server and from there to the author's device. Edits from the web editor and
  from agents via MCP/REST disappeared the same way.

  The merge is now three-way. Text files get their own mark, `foldedHash`
  (the last disk content already folded into the CRDT; `contentHash` stays
  for the "delete vs edit" check). Disk edits are computed against this base,
  and other people's edits not yet written to disk are kept. The base text is
  used only if its hash matches the mark — whether it comes from memory, from
  the document itself or from the server's version history. If nothing can
  confirm the base (logs written by older versions, both sides changed while
  the plugin was off), the disk wins, as before, and this is logged. A local
  save and a snapshot write of the same file no longer overlap.

- **An edit from another device didn't reach a note skipped during
  catch-up.** Since 0.2.11 catch-up doesn't load a document if the file on
  disk matches the server. Such a document has no history, and an incoming
  `yjs:update` (the server sends only the delta) had nothing to apply to: the
  edit waited for a reconnect, and a local edit to the same note was
  deferred. Now the document is fetched from the server on demand via
  `yjs:fetch` at the moment it is needed. Against a server without
  `yjs:fetch`, the previous behavior.

### Removed

- **`src/crdt/editor-binding.ts` and the `y-codemirror.next`, `y-protocols`
  dependencies.** The `yCollab` editor binding was never wired up, and
  esbuild dropped it from the bundle — the removal doesn't change `main.js`
  (verified against the build hash).

### Changed

- **The README and the directory description no longer promise
  per-character sync.** They said "edits propagate per-character" and "edit
  notes together in real time", while edits go out when Obsidian saves the
  note. Now it is described as it is, with a limitations section; live
  co-editing is in the server's web editor.

## [0.3.1] — 2026-09-16

### Fixed

- **The plugin deleted other vaults' offline CRDT.** The
  `DocManager.purgeUnknownBindings` backstop, added in 0.2.12, went through
  the `y-indexeddb` databases with the `team-vault-` prefix at startup and
  removed every one that didn't belong to a binding of **this** vault. But
  Obsidian keeps IndexedDB in **one store shared by every vault on the
  machine**, and database names are tied to the binding id, not to the vault
  — from inside one vault, a live binding of another vault is
  indistinguishable from an orphan. Found while checking a clean install of
  0.3.0: a fresh test vault deleted **207 databases** of a working vault on
  its second launch.

  Anyone with Team Vault in two or more vaults on one machine is affected.
  The consequences: a re-sync of the affected vault from the server and the
  loss of offline edits in it that had **not yet been sent**; the content
  itself, on disk and on the server, was not touched. The backstop is removed
  entirely: the only bindings safe to clean up are those named by the vault's
  own operation log — and that is what remains.

## [0.3.0] — 2026-09-08

Preparation for publishing in the Obsidian Community directory. The main
thing: the plugin finally **works on a clean install**.

### Fixed

- **The plugin loaded nowhere but on hand-built installs.** `better-sqlite3`
  and `chokidar` were declared `external` and loaded at runtime from
  `<plugin folder>/node_modules/`. A release (and the directory) carries only
  `main.js`, `manifest.json` and `styles.css` — there is nowhere for
  `node_modules` to come from, so `loadNative('better-sqlite3')` threw,
  `onload` failed, and the plugin didn't come up at all. Only our own vault
  worked, where 21 MB of dependencies had been put in place by hand. Now:
  - **the operation log is no longer SQLite** — the state lives in memory and
    is persisted to `.obsidian/plugins/team-vault/state.json` through the
    same adapter as `sync.log`. The class's public API stayed **synchronous**
    (the engine reads the log on hot paths); only `load()` at startup and
    `close()` at unload were added. Writes go through a temporary file and a
    rename, debounced by 500 ms, while the operation queue is flushed at once
    — the server can't restore it;
  - **chokidar is bundled** into `main.js` (pure JS; only Node's built-in
    modules stay external);
  - `src/utils/native-loader.ts` is removed as no longer needed.

  No migration needed: the operation log is a cache, and `file_meta` is
  restored on catch-up. The old `state.db` can be deleted by hand.

- **Closed a high-severity vulnerability in dependencies** —
  `socket.io-parser` < 4.2.7 (GHSA-2m8v-j782-fhvr, memory exhaustion). Added
  a `pnpm.overrides` entry.

### Changed

- **Command ids no longer duplicate the plugin id.** It was
  `team-vault:team-vault-sync-now`, now it is `team-vault:sync-now` — a
  directory requirement. If you had hotkeys assigned to Team Vault commands,
  they need to be assigned again.
- **Styles moved to `styles.css`.** 22 `el.style.*` assignments were replaced
  with classes; the file is now versioned instead of being created as a stub
  in CI. Themes and user snippets can finally override them.
- **Headings the Obsidian way.** Settings sections use `Setting.setHeading()`,
  modal titles use `titleEl`; the duplicate "Team Vault" heading in the
  settings is removed (Obsidian already names the tab).
- The description in `manifest.json` now meets the directory's requirements.
- README: added a section on network use and privacy (which host is
  contacted, what is sent, that there is no telemetry) — a mandatory
  disclosure under the Developer policies.
- Removed stray console output from the settings.

## [0.2.12] — 2026-09-05

### Fixed

- **Two plugin folders with one `id` no longer break sync silently.** Obsidian
  tells plugins apart by the `id` in `manifest.json`, not by folder name, so
  a copy next to the working one (`team-vault-backup-0.2.9`, an unpacked
  release, a dev build) makes it load **one of the two** — and the choice
  isn't the user's. From there the state diverges: `data.json` is read from
  the **loaded** folder (a copy usually has none — the plugin creates an empty
  one, and the status bar sits at "No active vaults"), while `state.db` and
  `sync.log` live in the `{manifest.id}` folder, i.e. the **canonical** one.
  Meanwhile the stale copy edits the real operation log, orphaned-binding
  cleanup included: with empty settings every binding looks removed to it,
  and it wipes the offline CRDT of the live vault. Now the plugin checks the
  folders in `.obsidian/plugins` on load, shows a **persistent** notice with
  the name of the extra folder, and **skips the cleanups** until the install
  is put in order.

- ~~**Offline CRDT cleanup no longer depends on `state.db`.**~~ **Revoked in
  0.3.1** — the backstop deleted other vaults' databases, see above. The
  startup cleanup took the list of bindings from the operation log; if
  `state.db` was deleted or restored from a backup, it named no bindings — and
  the `y-indexeddb` databases of a removed binding stayed on disk, only to
  merge back in the next time the same id was used. Added the
  `DocManager.purgeUnknownBindings` backstop: it lists our databases by the
  `team-vault-` prefix and deletes those that belong to no binding in the
  settings. Other plugins' databases are not touched; the cleanup is skipped
  if the settings look unloaded (no servers, no bindings).

## [0.2.11] — 2026-08-06

### Fixed

- **Obsidian froze on large vaults on every connect.** After `project:join`
  the plugin unconditionally went through every text file of the project and
  subscribed to local edits, and the subscription creates a `Y.Doc` and a
  **separate `y-indexeddb` database for each file** under the hood. On a
  vault of 1062 notes this held the UI thread for tens of seconds, even with
  no note open. Then came a self-sustaining loop: thread busy → missed
  heartbeat → the server drops the connection → reconnect → all over again.
  Measured sync phases: 46 s → 30 s → **174 s** → 94 s, 796 s of CPU.

  Now the subscription is attached **lazily** — to a document at the moment
  it is actually needed (opening a note, an edit, a server update).
  `DocManager` got `onDocAcquired` for this.

  On top of that, catch-up **skips documents that already match the disk**:
  the snapshot is unpacked into a throwaway `Y.Doc` without IndexedDB and
  without a disk write, and if the text matches, the document isn't loaded at
  all.

  Measured after the fix on the same vault: sync phase **8.7 s**, 21.7 s of
  CPU, zero disconnects.

  > The comparison is by content, NOT by the `contentHash` from the file list:
  > that one can lag behind the state of the Yjs document, and skipping by
  > hash would throw away newer server text (a silent rollback).

## [0.2.10] — 2026-08-06

### Fixed

- **Renaming or moving a note deleted it** — both from the server and from
  disk. One action in the UI produces three events: Obsidian's own
  `vault.on('rename')` and a pair from the filesystem watcher (`unlink` of the
  old path, `add` of the new one). The local rename handler didn't mark the
  paths in `recentlyApplied`, so the pair reached the engine: the `unlink`
  got into delete handling **before** the rename acknowledgement came back,
  found the not-yet-updated `fileId` — and right after the `RENAME` a
  `DELETE` went to the server, killing the just-renamed file.

  The race window grows with the server's response time, so the bug doesn't
  reproduce against a local server but does, consistently, against a remote
  one.

### Added

- Tests for edits by an **external process** (an agent, a script, a
  third-party editor) working on the vault alongside a running Obsidian:
  creating, deleting and moving a file outside the UI. Separately pinned down:
  an external `mv` arrives as an `unlink`+`add` pair (so on the server it
  is a create + delete, not a rename) and doesn't lose content.

## [0.2.9] — 2026-07-15

### Fixed

- **Deleting a folder, or a file the client hadn't indexed, didn't stick — the
  files came back from the server** (the storyboard-image resurrection).
  Obsidian fires a single `delete` for a `TFolder` and the per-child chokidar
  `unlink` events are unreliable under a burst, so folder deletes never reached
  the server; and a delete for a path missing from the local index was queued
  with an empty `fileId` and silently dropped as `no_file_id`. Now: a folder
  delete is expanded into a delete for every indexed child (children are
  pre-marked so the chokidar echo can't double-fire), and an empty `fileId` is
  resolved from the server's live file list before the delete is sent.
- **`initialPush` could re-upload a deleted-but-still-on-disk file and
  resurrect it.** It now consults the server's tombstones
  (`GET /files?includeDeleted`) and skips those paths, and **fails closed** if
  that lookup errors (defers the upload pass rather than risk a resurrection).
- **A debounced disk snapshot from a concurrent remote edit could recreate a
  just-deleted note.** Local delete now releases the Yjs doc and cancels the
  pending snapshot, matching the server-delete teardown.

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
