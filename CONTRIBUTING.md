# Contributing to Team Vault

Thanks for helping. This is the Obsidian plugin; the server lives in
[kremdigital/TeamVaultServer](https://github.com/kremdigital/TeamVaultServer).

- **Security issues** — don't open a public issue; see
  [SECURITY.md](./SECURITY.md).
- **Bugs** — open an issue with the plugin and Obsidian versions, the
  operating system, steps to reproduce, and the relevant lines from
  `sync.log` (Settings → Team Vault → Behavior → Open log → Copy). Remove API
  keys, note contents and private paths before posting.
- **Larger changes** — open an issue first, so we can agree on the approach
  before you write the code.

## Setup

You need Node.js 22.13 or newer (20.19+ and 24+ work too — the range ESLint
10 runs on) and pnpm 10, as in the release workflow. Install exactly what the
lockfile pins:

```bash
CI=1 pnpm install --frozen-lockfile
```

`CI=1` keeps pnpm non-interactive; `--frozen-lockfile` fails instead of
rewriting `pnpm-lock.yaml`. The `prepare` script installs the husky Git hooks:
`pre-commit` runs lint-staged (ESLint and Prettier on staged files), and
`commit-msg` runs commitlint.

To try the plugin in Obsidian, build it into a test vault — see
**Development** in the [README](./README.md#development) and
[`.env.example`](./.env.example). Use a vault bound to a test project: the
plugin syncs whatever vault it runs in.

## Gates

Every change has to pass all four gates — run them from the repository root
before you push:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

- `pnpm lint` runs ESLint with
  [eslint-plugin-obsidianmd](https://github.com/obsidianmd/eslint-plugin), the
  rules of the Obsidian community directory's automated review, over the whole
  repository. It refuses to run from any other directory, because the plugin
  reads `manifest.json` from the working directory.
- `pnpm format` fixes what `pnpm format:check` complains about.
- The release workflow runs the same gates, so a red gate blocks a release.

If you change what gets bundled, also run `pnpm build` and check the
requires left in `main.js`:

```bash
grep -o 'require("[^"]*")' main.js
```

Only `obsidian` and `node:*` modules may appear. The directory installs
`main.js`, `manifest.json` and `styles.css` and nothing else, so native
modules and runtime `require`s of packages from `node_modules` break every
real install.

## Tests are required

- A new feature comes with unit and/or integration tests in `tests/`.
- A bug fix comes with a regression test that fails without the fix and
  passes with it.
- Tests don't use `jest.mock()`. Obsidian's API is replaced by the manual mock
  in `tests/__mocks__/obsidian.ts`; everything else — clocks, sockets, the
  vault, watchers — is passed in as a fake.
- A change that only makes sense in a running Obsidian (UI, focus, plugin
  reload) also gets a scenario in [MANUAL-TEST.md](./MANUAL-TEST.md).

## Code conventions

- TypeScript, formatted by Prettier (`.prettierrc`). Comments are in English
  and explain why, not what.
- Every user-visible string goes through `t()` and has a key in both
  `src/i18n/en.json` and `src/i18n/ru.json` — a test checks that the two
  catalogs match and cover every key used in `src/`. UI text is in sentence
  case.
- Timers, `crypto` and the clipboard go through `window` / `activeWindow`, as
  the Obsidian plugin guidelines ask, so the plugin works in popout windows.
- `isDesktopOnly` stays `true`: the filesystem watcher and the operation log
  use Node APIs that mobile doesn't have.
- A change to the sync contract (REST, Socket.IO events, the Yjs exchange,
  operation-log semantics) has to be matched on the server side and in the
  server's
  [sync protocol description](https://github.com/kremdigital/TeamVaultServer/blob/main/docs/sync-protocol.md)
  — say so in the pull request.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
— `type(scope): subject`, for example `fix(watcher): ignore .trash on rename`.
commitlint (`@commitlint/config-conventional`) checks every message in the
`commit-msg` hook. Don't bypass the hooks with `--no-verify`.

## Changelog

Add a line for any user-visible change under `## [Unreleased]` at the top of
[CHANGELOG.md](./CHANGELOG.md), in English, in the matching Keep a Changelog
group (Added, Changed, Removed, Fixed, Security).

## Releases

Releases are cut by the maintainer, following [RELEASING.md](./RELEASING.md).
Please don't bump the version in `package.json`, `manifest.json` or
`versions.json`, and don't push tags.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE), like the rest of the project.
