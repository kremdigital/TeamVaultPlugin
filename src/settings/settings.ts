/**
 * Persisted plugin settings.
 *
 * The shape lives in `data.json` (Obsidian's per-plugin storage). We treat the
 * file as untrusted on load — `parseSettings` repairs missing fields so
 * older configs continue to work after upgrades, and sets aside the servers
 * and bindings it can't use rather than dropping them.
 *
 * ⚠️ API keys are stored in plain text inside `data.json`, exactly like every
 * other Obsidian plugin (the host gives no encrypted store). This is called
 * out in the README so users know not to commit their vault config.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
/** A UI catalog the plugin ships. */
export type Language = 'ru' | 'en';
/**
 * The interface-language setting: a catalog, or `auto` — whatever language
 * Obsidian itself runs in (`i18n/language.ts` resolves it).
 */
export type LanguageSetting = 'auto' | Language;

/**
 * Version of the `data.json` shape, saved with it. Absent up to 0.3.5.
 *
 * 2 — `language` is the user's choice. Before it, a saved `ru` was not: up to
 * 0.3.4 the plugin had no language setting and always saved Russian, and
 * 0.3.5 carried that value over as if it had been picked. So a `ru` without a
 * version loads as `auto`, the default: Russian where Obsidian runs in
 * Russian, English elsewhere.
 */
export const SETTINGS_VERSION = 2;

export interface ServerConfig {
  /** Locally generated UUID — stable across renames. */
  id: string;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Base URL, no trailing slash. */
  url: string;
  /** API key from the server's "API Keys" page. */
  apiKey: string;
  /** Unix ms when the user added this server. */
  addedAt: number;
}

export interface VaultBinding {
  id: string;
  serverId: string;
  projectId: string;
  /** Cached at bind time so we can render the UI without a server round-trip. */
  projectName: string;
  /** Path inside the vault, with leading slash. `/` means the entire vault. */
  localFolder: string;
  enabled: boolean;
  lastSyncedAt: number;
  /** Vector clock at the last successful sync — drives reconnect catch-up. */
  lastVectorClock: Record<string, number>;
}

export interface PluginSettings {
  /** See {@link SETTINGS_VERSION}. */
  settingsVersion: number;
  servers: ServerConfig[];
  bindings: VaultBinding[];
  /** Debounce window (ms) before pushing a `modify` upstream. */
  debounceMs: number;
  // No `syncOnStartup`: up to 0.3.4 the settings carried a switch by that
  // name that nothing read — the engines always catch up when they connect.
  // A `data.json` that still has it loads fine; the field is dropped on the
  // next save.
  showSyncNotifications: boolean;
  logLevel: LogLevel;
  language: LanguageSetting;
  /** Stable per-device id used as the vector clock key. Generated on first
   *  load (see `main.ts`) and persisted; never re-rolled — would break
   *  causality across reconnects. Empty string means "not yet generated";
   *  the boot path replaces it with a UUID. */
  clientId: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  settingsVersion: SETTINGS_VERSION,
  servers: [],
  bindings: [],
  debounceMs: 500,
  showSyncNotifications: true,
  logLevel: 'info',
  language: 'auto',
  clientId: '',
};

/**
 * A fresh copy of the defaults. `{ ...DEFAULT_SETTINGS }` alone would share
 * its `servers` and `bindings` arrays, and the first server added on a fresh
 * install would be pushed into `DEFAULT_SETTINGS` itself.
 */
export function defaultSettings(): PluginSettings {
  return { ...DEFAULT_SETTINGS, servers: [], bindings: [] };
}

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];
const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', 'ru', 'en'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Read a language setting — from `data.json` or the settings dropdown. */
export function parseLanguageSetting(value: unknown): LanguageSetting {
  return asEnum(value, LANGUAGE_SETTINGS, DEFAULT_SETTINGS.language);
}

function asVectorClock(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** A server needs these to connect; an entry without one is skipped. */
const SERVER_REQUIRED = ['id', 'url', 'apiKey'] as const;
/** A binding needs these to sync; an entry without one is skipped. */
const BINDING_REQUIRED = ['id', 'serverId', 'projectId'] as const;

function buildServer(raw: Record<string, unknown>): ServerConfig {
  const url = raw.url as string;
  return {
    id: raw.id as string,
    name: asString(raw.name, url),
    url,
    apiKey: raw.apiKey as string,
    addedAt: asNumber(raw.addedAt, Date.now()),
  };
}

function buildBinding(raw: Record<string, unknown>): VaultBinding {
  return {
    id: raw.id as string,
    serverId: raw.serverId as string,
    projectId: raw.projectId as string,
    projectName: asString(raw.projectName, ''),
    localFolder: asString(raw.localFolder, '/'),
    enabled: asBoolean(raw.enabled, true),
    lastSyncedAt: asNumber(raw.lastSyncedAt, 0),
    lastVectorClock: asVectorClock(raw.lastVectorClock),
  };
}

/**
 * An entry of `servers` or `bindings` in `data.json` the plugin can't use: not
 * an object, or a required field missing, empty or not a string. Only a hand
 * edit (or another tool) makes one — the plugin never saves such an entry.
 */
export interface SkippedEntry {
  /** Its position in the file's list. */
  index: number;
  /** Its `id`, when it has a readable one — to find it in the file. */
  id?: string;
  /** The required fields at fault; `['entry']` when it is not an object. */
  invalid: string[];
  /** The entry exactly as the file has it: `settingsToSave` writes it back. */
  raw: unknown;
}

/** A list of `data.json` the plugin could not read in full. */
export type SkippedList =
  | { kind: 'entries'; entries: SkippedEntry[] }
  /** The file has something other than a list there — kept as it is. */
  | { kind: 'not-a-list'; raw: unknown };

/** What `parseSettings` left out of the settings; `null` for a list read in full. */
export interface SkippedSettings {
  servers: SkippedList | null;
  bindings: SkippedList | null;
}

export interface ParsedSettings {
  settings: PluginSettings;
  /**
   * `null` when every server and binding in the file made it into
   * `settings`. Otherwise the plugin does not know all of its bindings: a
   * skipped one still has its offline queue in `state.json` and its offline
   * documents in IndexedDB, so nothing may be cleaned up as orphaned (see
   * `main.ts`), and a save must keep it in the file (`settingsToSave`).
   */
  skipped: SkippedSettings | null;
}

function parseList<T>(
  value: unknown,
  required: readonly string[],
  build: (raw: Record<string, unknown>) => T,
): { items: T[]; skipped: SkippedList | null } {
  // No key at all is an empty list; anything else that is not a list —
  // `null` included — is kept, since the plugin never writes one.
  if (value === undefined) return { items: [], skipped: null };
  if (!Array.isArray(value)) return { items: [], skipped: { kind: 'not-a-list', raw: value } };
  const items: T[] = [];
  const entries: SkippedEntry[] = [];
  value.forEach((raw: unknown, index) => {
    if (!isObject(raw)) {
      entries.push({ index, invalid: ['entry'], raw });
      return;
    }
    const invalid = required.filter((field) => typeof raw[field] !== 'string' || raw[field] === '');
    if (invalid.length === 0) {
      items.push(build(raw));
      return;
    }
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined;
    entries.push({ index, ...(id !== undefined ? { id } : {}), invalid, raw });
  });
  return { items, skipped: entries.length > 0 ? { kind: 'entries', entries } : null };
}

/**
 * Read settings from `data.json` (already parsed as JSON), repairing what
 * can be repaired: an unknown or malformed plain field falls back to its
 * default. A server or binding that can't be used is left out of the
 * settings and reported in `skipped`. Never throws.
 */
export function parseSettings(raw: unknown): ParsedSettings {
  if (!isObject(raw)) return { settings: defaultSettings(), skipped: null };
  const servers = parseList(raw.servers, SERVER_REQUIRED, buildServer);
  const bindings = parseList(raw.bindings, BINDING_REQUIRED, buildBinding);
  // A `ru` saved before the language setting existed is the old default, not
  // a choice (see SETTINGS_VERSION).
  const legacyLanguage = raw.settingsVersion === undefined && raw.language === 'ru';
  const settings: PluginSettings = {
    settingsVersion: SETTINGS_VERSION,
    servers: servers.items,
    bindings: bindings.items,
    debounceMs: Math.max(0, asNumber(raw.debounceMs, DEFAULT_SETTINGS.debounceMs)),
    showSyncNotifications: asBoolean(
      raw.showSyncNotifications,
      DEFAULT_SETTINGS.showSyncNotifications,
    ),
    logLevel: asEnum(raw.logLevel, LOG_LEVELS, DEFAULT_SETTINGS.logLevel),
    language: legacyLanguage ? 'auto' : parseLanguageSetting(raw.language),
    clientId: asString(raw.clientId, DEFAULT_SETTINGS.clientId),
  };
  const skipped =
    servers.skipped || bindings.skipped
      ? { servers: servers.skipped, bindings: bindings.skipped }
      : null;
  return { settings, skipped };
}

/** {@link parseSettings}, for when only the settings matter. */
export function mergeWithDefaults(raw: unknown): PluginSettings {
  return parseSettings(raw).settings;
}

function withSkipped(list: readonly unknown[], skipped: SkippedList | null): unknown {
  if (!skipped) return list;
  if (skipped.kind === 'not-a-list') {
    // As the file had it while there is nothing to add to it. Once there is,
    // a list — with the value as its last entry, where the next load skips
    // it again. A `null` holds nothing to keep, and as an entry it would only
    // be reported on every start.
    if (list.length === 0) return skipped.raw;
    return skipped.raw === null ? list : [...list, skipped.raw];
  }
  const out: unknown[] = [...list];
  // Each back at its old position (or last, if the list has shrunk since),
  // in file order: a save that changed nothing leaves the list as it was.
  for (const entry of skipped.entries) out.splice(Math.min(entry.index, out.length), 0, entry.raw);
  return out;
}

/**
 * What to save to `data.json`: the settings, plus every entry
 * {@link parseSettings} skipped, as the file had it. Without them the first
 * save after such a load — any settings change, or just a binding reporting
 * a sync — would erase a binding the plugin could not read, and the next
 * start would clean up its unsent changes as orphaned.
 */
export function settingsToSave(settings: PluginSettings, skipped: SkippedSettings | null): object {
  if (!skipped) return settings;
  return {
    ...settings,
    servers: withSkipped(settings.servers, skipped.servers),
    bindings: withSkipped(settings.bindings, skipped.bindings),
  };
}

/**
 * What was skipped, for the log: positions, ids and the fields at fault. Never
 * the entries themselves — a server entry holds an API key.
 */
export function describeSkipped(skipped: SkippedSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['servers', 'bindings'] as const) {
    const list = skipped[key];
    if (!list) continue;
    out[key] =
      list.kind === 'not-a-list'
        ? `not a list (${list.raw === null ? 'null' : typeof list.raw})`
        : list.entries.map(({ index, id, invalid }) => ({
            index,
            ...(id !== undefined ? { id } : {}),
            invalid,
          }));
  }
  return out;
}
