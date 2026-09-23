/**
 * Persisted plugin settings.
 *
 * The shape lives in `data.json` (Obsidian's per-plugin storage). We treat the
 * file as untrusted on load — `mergeWithDefaults` repairs missing fields so
 * older configs continue to work after upgrades.
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
 * Obsidian itself runs in (`i18n/language.ts` resolves it). Versions up to
 * 0.3.4 always saved `ru`, so their `data.json` keeps an explicit Russian.
 */
export type LanguageSetting = 'auto' | Language;

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
  servers: [],
  bindings: [],
  debounceMs: 500,
  showSyncNotifications: true,
  logLevel: 'info',
  language: 'auto',
  clientId: '',
};

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

function normalizeServer(raw: unknown): ServerConfig | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id, '');
  const url = asString(raw.url, '');
  const apiKey = asString(raw.apiKey, '');
  if (!id || !url || !apiKey) return null;
  return {
    id,
    name: asString(raw.name, url),
    url,
    apiKey,
    addedAt: asNumber(raw.addedAt, Date.now()),
  };
}

function normalizeBinding(raw: unknown): VaultBinding | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id, '');
  const serverId = asString(raw.serverId, '');
  const projectId = asString(raw.projectId, '');
  if (!id || !serverId || !projectId) return null;
  return {
    id,
    serverId,
    projectId,
    projectName: asString(raw.projectName, ''),
    localFolder: asString(raw.localFolder, '/'),
    enabled: asBoolean(raw.enabled, true),
    lastSyncedAt: asNumber(raw.lastSyncedAt, 0),
    lastVectorClock: asVectorClock(raw.lastVectorClock),
  };
}

/**
 * Merge user-provided settings (typically from `loadData()`) with defaults.
 * Unknown / malformed fields fall back to defaults — never throw.
 */
export function mergeWithDefaults(raw: unknown): PluginSettings {
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS };
  const servers = Array.isArray(raw.servers)
    ? raw.servers.map(normalizeServer).filter((s): s is ServerConfig => s !== null)
    : [];
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings.map(normalizeBinding).filter((b): b is VaultBinding => b !== null)
    : [];
  return {
    servers,
    bindings,
    debounceMs: Math.max(0, asNumber(raw.debounceMs, DEFAULT_SETTINGS.debounceMs)),
    showSyncNotifications: asBoolean(
      raw.showSyncNotifications,
      DEFAULT_SETTINGS.showSyncNotifications,
    ),
    logLevel: asEnum(raw.logLevel, LOG_LEVELS, DEFAULT_SETTINGS.logLevel),
    language: parseLanguageSetting(raw.language),
    clientId: asString(raw.clientId, DEFAULT_SETTINGS.clientId),
  };
}
