# Releasing

How to cut a release and get it listed in, and kept healthy on, the Obsidian
Community directory ([community.obsidian.md](https://community.obsidian.md)).

## Cutting a release

1. Make sure `main` is green: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
2. Update `CHANGELOG.md`: turn the `## [Unreleased]` notes into a
   `## [X.Y.Z] — YYYY-MM-DD` section and leave an empty `## [Unreleased]`
   heading above it for the next changes. The release workflow publishes
   exactly the version's section (up to the next `## [` heading) as the
   release body — `node scripts/release-notes.mjs X.Y.Z` prints it — and fails
   if the section is missing or empty. The changelog is in English: the
   release page and the directory's audience read it.
3. Bump the version. `pnpm version` runs `scripts/version-bump.mjs`, which
   syncs `manifest.json#version` and appends a `versions.json` entry
   mapping the new version to the current `minAppVersion`, then stages
   both files:

   ```bash
   pnpm version patch -m "chore(release): %s"   # or minor / major / an explicit x.y.z
   ```

   This also creates the version commit and the `vX.Y.Z` tag npm makes by
   default. The `-m` message keeps the commit within Conventional Commits,
   which commitlint checks.

4. Push the **plain** version tag (no `v` prefix) — this is what the
   catalogue requires:

   ```bash
   git push origin main
   git tag 0.1.1            # exact manifest version, NO leading v
   git push origin 0.1.1
   ```

   Push `main` together with the release commit, not ahead of it: the
   directory reads `manifest.json` from the HEAD of the default branch, so a
   `minAppVersion` raised on `main` would otherwise reach it while
   `manifest.json` still names the previous version, whose release (and
   `versions.json` entry) allows older Obsidian builds.

   The `Release` GitHub Action builds `main.js`, validates that the tag
   matches both `manifest.json` and `versions.json`, generates a signed
   build provenance attestation for the three assets (`actions/attest`, as
   in Obsidian's official release template), and publishes a GitHub release
   with `main.js`, `manifest.json`, `styles.css` attached and the version's
   `CHANGELOG.md` section as its body.

   > `pnpm version` also leaves a local `vX.Y.Z` tag behind — **don't push
   > it**. The workflow triggers on the flat form only; pushing both would
   > publish two releases for one version (0.3.0 did, and the stray tag had
   > to be deleted).

   Two deliberate differences from Obsidian's template: the tag is a plain
   lightweight tag rather than `git tag -a`, and the release is published
   at once with its notes instead of as a draft to fill in by hand.

5. After the workflow finishes, check the release:
   - it has `main.js`, `manifest.json` and `styles.css`, and its body is the
     version's changelog section;
   - the attestation verifies, from a directory holding the downloaded
     assets:

     ```bash
     gh attestation verify main.js -R kremdigital/TeamVaultPlugin
     ```

   - on the portal, the entry shows the new version. If it doesn't yet, open
     the entry's **...** menu → **Check for new releases**.

## Build verification

After every release the directory builds the plugin from the source at the
release tag and checks that the result matches the `main.js` attached to the
release. The scanner runs the first of the `build`, `build:plugin` and
`compile` scripts it finds — here `build` (`tsc --noEmit && node
esbuild.config.mjs`), the production build.

So the build has to be deterministic — the same commit must always give the
same bytes:

- Release assets come only from the workflow, which builds a clean checkout
  of the tag. Never attach a hand-built `main.js`.
- `pnpm-lock.yaml` is committed and installed with `--frozen-lockfile`, so
  dependency versions don't drift between the release build and the scan.
- The build embeds no timestamps and no absolute paths. The license notices
  appended to `main.js` (`scripts/bundle-licenses.mjs`) are sorted and
  path-free for this reason; keep it that way when touching the build.

Check it before tagging — two builds in a row give the same hash:

```bash
pnpm build && sha256sum main.js
pnpm build && sha256sum main.js
```

And after the release, compare a clean build of the tag with the asset:

```bash
git clone --depth 1 --branch X.Y.Z https://github.com/kremdigital/TeamVaultPlugin.git tv-check
cd tv-check
CI=1 pnpm install --frozen-lockfile
pnpm build
sha256sum main.js
curl -sL https://github.com/kremdigital/TeamVaultPlugin/releases/download/X.Y.Z/main.js | sha256sum
```

The directory doesn't document which package manager the scanner installs
with. An npm install ignores `pnpm-lock.yaml`, resolves newer versions within
the `package.json` ranges and gives a different `main.js`. If build
verification fails while the check above passes, start there.

## Preview the review before a release

Once the plugin has an entry on the portal, the scan can run before anything
is tagged: open the entry → **Review branch** → enter a branch, tag or commit
SHA (blank means the default branch) → **Run preview scan**. Do this for
`main` before cutting the release; it runs the same sections as the real
review (Manifest, Releases, Source code, Build verification).

Locally, `pnpm lint` runs the same rules (`eslint-plugin-obsidianmd`, pinned
to the version the directory uses). The directory raises most of them to a
warning only, but the gate keeps them at the recommended level.

## First-time catalogue submission

Obsidian moved community-plugin submissions off `obsidianmd/obsidian-releases`
PRs in 2026; the catalogue is now driven by the portal at
[community.obsidian.md](https://community.obsidian.md). The
`community-plugins.json` mirror still exists, but PRs against it are
disabled — the portal is the single entry point.

Once a `X.Y.Z` GitHub release exists and `manifest.json` on `main` matches
it:

1. Sign in to <https://community.obsidian.md> with your **Obsidian
   account** (not GitHub).
2. Under **GitHub** in the profile, select **Connect** and authorize the
   **kremdigital** GitHub account — this is what proves you own
   `kremdigital/TeamVaultPlugin`. `kremdigital` is a personal GitHub account,
   not an organization, so there is no organization membership to make
   public: be signed in to GitHub as `kremdigital` when you connect.
3. Sidebar → **Plugins** → **New plugin** → enter
   `https://github.com/kremdigital/TeamVaultPlugin`; as **Owner**, choose
   yourself (or an organization created on the portal).
4. Review the Developer policies, agree, submit.
5. In the profile, turn on **Action required notifications** to get an email
   when a scan finds something that needs fixing to stay listed.

The automated review then checks:

- `manifest.json` is present at the repo root and valid — the directory
  reads it from the HEAD of the default branch.
- A GitHub release exists whose tag equals `manifest.version`.
- That release has `main.js` + `manifest.json` attached.
- The `id` is unique and not already taken, and does not contain the
  substring `obsidian` (we renamed from `obsidian-team` → `team-vault`
  in v0.2.0 for exactly this reason).
- The source code (the `eslint-plugin-obsidianmd` rules, known
  vulnerabilities, obfuscation) and build verification (above).

Each result is an error, a warning, a recommendation or a pass. Warnings
don't block the listing, but the plugin can't be installed from Obsidian
until every error is resolved.

Review is automatic and runs against **every** version, not just the
first submission: developer policies, code quality, known vulnerabilities.
Popular and featured plugins additionally get a human pass.

Things to keep true for this plugin:

- **`isDesktopOnly: true`** is correct — the filesystem watcher and the
  operation log use Node APIs that mobile doesn't expose.
- **No native modules, ever.** The directory installs `main.js`,
  `manifest.json` and `styles.css` and nothing else, so anything that
  expects the plugin's own `node_modules/` fails on every real install.
  That's what forced the 0.3.0 rewrite of the operation log away from
  `better-sqlite3`. Check `grep -o 'require("[^"]*")' main.js` after a
  build: only `obsidian` and `node:*` may appear.
- **`pnpm audit --prod` must be clean** — the scanner looks for known
  vulnerabilities.
- The plugin talks to a server and needs an API key, so the README must
  keep its "Network use and privacy" section: which host is contacted,
  what is sent, that there is no telemetry. That disclosure is what makes
  the network use permissible under the Developer policies.

To address feedback: update the repo, cut a new patch release
(`pnpm version patch` + tag), and the portal automatically re-reviews. To
recheck at once instead of waiting for the periodic check, open the entry's
**...** menu → **Request review**.

## Scorecard

The listing page shows a Scorecard with two ratings.

**Health** — hygiene, maintenance, responsiveness and adoption. Hygiene
counts a README, a license, a contributing guide and a description: the
repository has `README.md`, `LICENSE` and `CONTRIBUTING.md`, but the GitHub
description is set in the repository's **About** settings, not in a file —
keep it filled in (topics too). Maintenance and responsiveness follow recent
commits and releases, closed issues and active contributors.

**Review** — the latest scan: passed checks (no known vulnerable
dependencies, no obfuscated code, verified GitHub artifact attestations, the
Obsidian APIs used), disclosures and other notes. Disclosures aren't
failures, they tell users what the plugin does. Expected here:

- network requests — to the server the user configures, and nowhere else
  (the README's "Network use and privacy" section says the same);
- clipboard access — the **Copy** button in the log window;
- browser storage — IndexedDB for the offline Yjs documents, and reads of
  `localStorage`.

The attestation check needs the `Generate artifact attestation` step of
`release.yml`, which arrived after 0.3.4: earlier releases have no
attestation.

`SECURITY.md` tells users how to report a vulnerability — Obsidian's plugin
security page sends them to the author's security policy. It points to
GitHub's private vulnerability reporting, which has to be enabled in the
repository's security settings (**Private vulnerability reporting** →
**Enable**); without it the **Report a vulnerability** button doesn't
appear.

## Checklist before tagging

- [ ] `manifest.json` version == `package.json` version == new tag.
- [ ] `versions.json` has an entry for the new version.
- [ ] `CHANGELOG.md` has a `## [X.Y.Z] — YYYY-MM-DD` section for the new
      version (`node scripts/release-notes.mjs X.Y.Z` prints it), in English.
- [ ] All gates green.
- [ ] `minAppVersion` still accurate for any new API usage.
- [ ] Two `pnpm build` runs give the same `sha256sum main.js`.
- [ ] `grep -o 'require("[^"]*")' main.js` lists only `obsidian` and
      `node:*`.
- [ ] A preview scan of `main` on the portal (**Review branch**) has no
      errors — once the entry exists.
