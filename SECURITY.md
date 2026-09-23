# Security policy

## Supported versions

Only the latest release of Team Vault gets security fixes. A fix ships as a
new release, and Obsidian offers it as a regular plugin update — there are no
backports to older versions. If you're on an older version, update first and
check whether the problem is still there.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Anything older | No        |

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub Security
Advisories for this repository:

1. Open <https://github.com/kremdigital/TeamVaultPlugin/security/advisories/new>
   (the **Security** tab → **Report a vulnerability**).
2. Describe the problem and how to reproduce it.

Don't open a public issue, pull request or discussion for a vulnerability,
and don't disclose it anywhere until a fixed release is out. If the
**Report a vulnerability** button isn't available, open an issue that asks
for a private channel, without any details of the problem.

A useful report includes:

- the plugin version (Settings → Community plugins), the Obsidian version and
  the operating system;
- the Team Vault server version, if the server takes part;
- steps to reproduce, or a proof of concept;
- what an attacker gains: which files, keys or data are exposed, and who has
  to be the attacker (a project member, the server, anyone on the network);
- relevant lines from `sync.log` (Settings → Team Vault → Behavior → Open log)
  with API keys, note contents and private paths removed.

The report stays private in the advisory while the fix is prepared. The fix
ships as a new release; after that the advisory can be published, crediting
you unless you'd rather stay anonymous.

## Scope

In scope — anything where the plugin itself lets someone do more than they
should, for example:

- a server or a project member making the plugin read, write or delete files
  outside the bound vault, or inside its config folder, `.trash` or `.git`;
- the API key or the contents of the config folder leaving the machine;
- the plugin sending vault data to any host other than the server you
  configured.

Not a vulnerability of the plugin:

- **The Team Vault server.** The server is a separate project: report its
  vulnerabilities in
  [kremdigital/TeamVaultServer](https://github.com/kremdigital/TeamVaultServer).
  If the server you connect to is run by someone else, how it is operated —
  its configuration, access control, logging, backups, what its operator does
  with the data — is between you and that operator.
- **What the server is meant to receive.** The server you configure gets the
  contents of the bound vault, and the members of the project see them; that
  is what syncing is. The plugin doesn't try to hide your notes from a server
  you chose to trust.
- **Local access to your machine.** The API key is stored in plain text in
  the plugin's `data.json`, inside the vault's config folder, as the README
  says. Someone who can read that folder, or run code in Obsidian (including
  another plugin), can read the key.
- **Obsidian itself** — report those to Obsidian support.
- **Dependencies.** A vulnerability in a package bundled into `main.js` is in
  scope if the plugin's use of it is affected; development-only tooling isn't
  shipped to users.
