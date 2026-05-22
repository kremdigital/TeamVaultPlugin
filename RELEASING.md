# Releasing

How to cut a release and (eventually) get listed in the Obsidian
Community Plugins catalogue.

## Cutting a release

1. Make sure `main` is green: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
2. Update `CHANGELOG.md` with the new version's notes.
3. Bump the version. `pnpm version` runs `scripts/version-bump.mjs`, which
   syncs `manifest.json#version` and appends a `versions.json` entry
   mapping the new version to the current `minAppVersion`, then stages
   both files:

   ```bash
   pnpm version patch   # or minor / major / an explicit x.y.z
   ```

   This also creates the `vX.Y.Z` commit + tag npm makes by default.

4. Push the **plain** version tag (no `v` prefix) — this is what the
   catalogue requires:

   ```bash
   git push origin main
   git tag 0.1.1            # exact manifest version, NO leading v
   git push origin 0.1.1
   ```

   The `Release` GitHub Action builds `main.js`, validates that the tag
   matches both `manifest.json` and `versions.json`, and publishes a
   GitHub release with `main.js`, `manifest.json`, `styles.css` attached.

   > The workflow also accepts a legacy `vX.Y.Z` tag, but the catalogue
   > bot only recognises the no-prefix form. Always tag the
   > catalogue-facing release as `X.Y.Z`.

## First-time catalogue submission

The catalogue is a separate repo
([`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)).
Once a `X.Y.Z` GitHub release exists:

1. Fork `obsidian-releases` and add an entry to
   `community-plugins.json`:

   ```json
   {
     "id": "obsidian-team",
     "name": "Obsidian Team",
     "author": "krem.digital",
     "description": "Self-hosted vault sync with live collaboration for Obsidian teams.",
     "repo": "kremdigital/ObsidianTeamPlugin"
   }
   ```

2. Open a PR. The validation bot checks:
   - `manifest.json` is present at the repo root and valid.
   - A GitHub release exists whose tag equals `manifest.version`.
   - That release has `main.js` + `manifest.json` attached.
   - The `id` is unique and not already taken.

3. A human reviewer then looks the plugin over. Known things they may
   flag for this plugin:
   - **Name / id contain "Obsidian"** — the guidelines discourage it.
     We kept `obsidian-team` because the folder path is already in use
     by testers; be ready to justify or rename if the reviewer insists
     (renaming the `id` changes the install folder, so weigh it).
   - **`isDesktopOnly: true`** is correct — `better-sqlite3` + `chokidar`
     are native and there is no mobile storage layer yet.

## Checklist before tagging

- [ ] `manifest.json` version == `package.json` version == new tag.
- [ ] `versions.json` has an entry for the new version.
- [ ] `CHANGELOG.md` updated.
- [ ] All gates green.
- [ ] `minAppVersion` still accurate for any new API usage.
