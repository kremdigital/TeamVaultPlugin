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

Obsidian moved community-plugin submissions off `obsidianmd/obsidian-releases`
PRs in 2026; the catalogue is now driven by the portal at
[community.obsidian.md](https://community.obsidian.md). The
`community-plugins.json` mirror still exists, but PRs against it are
disabled — the portal is the single entry point.

Once a `X.Y.Z` GitHub release exists:

1. Sign in to <https://community.obsidian.md> with your **Obsidian
   account** (not GitHub).
2. Link your GitHub account in profile settings — this is what proves
   you own `kremdigital/TeamVaultPlugin`.
3. Sidebar → **Plugins** → **New plugin** → enter
   `https://github.com/kremdigital/TeamVaultPlugin`.
4. Review the Developer policies, agree, submit.

The automated review then checks:

- `manifest.json` is present at the repo root and valid.
- A GitHub release exists whose tag equals `manifest.version`.
- That release has `main.js` + `manifest.json` attached.
- The `id` is unique and not already taken, and does not contain the
  substring `obsidian` (we renamed from `obsidian-team` → `team-vault`
  in v0.2.0 for exactly this reason).

If the automated check passes, a human reviewer takes a look. Known
things they may flag for this plugin:

- **`isDesktopOnly: true`** is correct — `better-sqlite3` + `chokidar`
  are native and there is no mobile storage layer yet.
- The plugin describes itself as "Self-hosted" — make sure the README's
  setup section clearly explains where to point users for the server
  side (link to `kremdigital/TeamVaultServer`).

To address feedback: update the repo, cut a new patch release
(`pnpm version patch` + tag), and the portal automatically re-reviews.

## Checklist before tagging

- [ ] `manifest.json` version == `package.json` version == new tag.
- [ ] `versions.json` has an entry for the new version.
- [ ] `CHANGELOG.md` updated.
- [ ] All gates green.
- [ ] `minAppVersion` still accurate for any new API usage.
