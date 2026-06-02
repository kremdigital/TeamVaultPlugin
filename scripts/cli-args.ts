/**
 * CLI argument parser for `cli-emulator`.
 *
 * We hand-roll instead of pulling in `yargs` / `commander` because the
 * surface is tiny (5 commands, a handful of options) and we want the
 * tooling to stay easy to understand for a contributor with no CLI
 * library familiarity.
 *
 * Usage forms:
 *
 *   cli-emulator list-projects --server <url> --api-key <key>
 *   cli-emulator list-files    --server <url> --api-key <key> --project <id>
 *   cli-emulator pull          --server <url> --api-key <key> --project <id> --folder <path>
 *   cli-emulator push          --server <url> --api-key <key> --project <id> --folder <path>
 *   cli-emulator watch         --server <url> --api-key <key> --project <id>
 */

export type Command = 'list-projects' | 'list-files' | 'pull' | 'push' | 'watch' | 'help';

export interface CliArgs {
  command: Command;
  server: string;
  apiKey: string;
  projectId?: string;
  folder?: string;
  /** Override device id; defaults to a stable random one. */
  clientId?: string;
}

const KNOWN_COMMANDS: ReadonlySet<Command> = new Set([
  'list-projects',
  'list-files',
  'pull',
  'push',
  'watch',
  'help',
]);

const REQUIRES_PROJECT: ReadonlySet<Command> = new Set(['list-files', 'pull', 'push', 'watch']);

const REQUIRES_FOLDER: ReadonlySet<Command> = new Set(['pull', 'push']);

export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgsError';
  }
}

/**
 * Parse argv (post-command-name; the runner strips `node script.ts`
 * before calling). Throws `CliArgsError` with a user-readable message
 * on any malformed input.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.length === 0) {
    return { command: 'help', server: '', apiKey: '' };
  }
  const [head, ...rest] = argv;
  if (!head) return { command: 'help', server: '', apiKey: '' };
  if (!KNOWN_COMMANDS.has(head as Command)) {
    throw new CliArgsError(`Unknown command: ${head}`);
  }
  const command = head as Command;
  if (command === 'help') {
    return { command: 'help', server: '', apiKey: '' };
  }

  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      throw new CliArgsError(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) {
      throw new CliArgsError(`Missing value for --${key}`);
    }
    opts[key] = value;
    i++;
  }

  const server = opts['server'];
  const apiKey = opts['api-key'];
  if (!server) throw new CliArgsError('Missing required --server');
  if (!apiKey) throw new CliArgsError('Missing required --api-key');

  if (REQUIRES_PROJECT.has(command) && !opts['project']) {
    throw new CliArgsError(`Command "${command}" requires --project`);
  }
  if (REQUIRES_FOLDER.has(command) && !opts['folder']) {
    throw new CliArgsError(`Command "${command}" requires --folder`);
  }

  const out: CliArgs = { command, server, apiKey };
  if (opts['project']) out.projectId = opts['project'];
  if (opts['folder']) out.folder = opts['folder'];
  if (opts['client-id']) out.clientId = opts['client-id'];
  return out;
}

export const HELP_TEXT = `Team Vault — CLI emulator

Talks to the sync server with the same protocol the Obsidian plugin uses,
so you can debug the wire format / API key / project setup without
opening Obsidian.

Usage:
  cli-emulator <command> --server <url> --api-key <key> [options]

Commands:
  list-projects                Print every project the API key can see.
  list-files   --project <id>  Print every file in the project.
  pull         --project <id> --folder <path>
                               Download every file in the project into
                               the local folder. Existing files are
                               overwritten.
  push         --project <id> --folder <path>
                               Upload every file under the local folder
                               to the project. Conflicts surface as
                               409 errors and are reported.
  watch        --project <id>  Stay connected and print every server
                               event (file:created, yjs:update, …).

Options:
  --server     URL of the sync server (e.g. https://sync.example.com).
  --api-key    The plugin API key from the server's "API Keys" page.
  --project    Server-side project id.
  --folder     Local folder path (relative or absolute).
  --client-id  Override the device id (default: random).
  help         Show this message.
`;
