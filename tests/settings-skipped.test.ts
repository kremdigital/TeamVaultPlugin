import {
  describeSkipped,
  mergeWithDefaults,
  parseSettings,
  settingsToSave,
  type SkippedSettings,
} from '@/settings/settings';

/**
 * Servers and bindings of `data.json` the plugin can't use are set aside, not
 * dropped: the load reports them (the orphan sweep must not run on a partial
 * list of bindings) and a save writes them back as the file had them.
 */

const server = {
  id: 's1',
  name: 'Work',
  url: 'https://sync.example.com',
  apiKey: 'osk_1',
  addedAt: 1,
};
const binding = (id: string): Record<string, unknown> => ({
  id,
  serverId: 's1',
  projectId: `p-${id}`,
  projectName: 'Notes',
  localFolder: `/${id}`,
  enabled: true,
  lastSyncedAt: 1,
  lastVectorClock: { c1: 3 },
});

/** Save, then read back what `saveData` would have written. */
function roundTrip(raw: Record<string, unknown>): Record<string, unknown> {
  const { settings, skipped } = parseSettings(raw);
  return JSON.parse(JSON.stringify(settingsToSave(settings, skipped))) as Record<string, unknown>;
}

describe('parseSettings', () => {
  it('skips nothing in settings the plugin saved itself', () => {
    const raw = {
      settingsVersion: 2,
      servers: [server],
      bindings: [binding('b1'), binding('b2')],
      clientId: 'c1',
    };
    const parsed = parseSettings(raw);
    expect(parsed.skipped).toBeNull();
    expect(parsed.settings.bindings.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(parseSettings({}).skipped).toBeNull();
    expect(parseSettings(null).skipped).toBeNull();
  });

  it('reports each unusable entry with its position, id and the fields at fault', () => {
    const { projectId: _projectId, ...noProject } = binding('b2');
    const parsed = parseSettings({
      servers: [{ id: 's2', url: 'https://x' }, server, 'junk'],
      bindings: [binding('b1'), noProject, { id: 7, serverId: '', projectId: 'p' }, null],
    });
    expect(parsed.settings.servers.map((s) => s.id)).toEqual(['s1']);
    expect(parsed.settings.bindings.map((b) => b.id)).toEqual(['b1']);
    const skipped = parsed.skipped!;
    expect(describeSkipped(skipped)).toEqual({
      servers: [
        { index: 0, id: 's2', invalid: ['apiKey'] },
        { index: 2, invalid: ['entry'] },
      ],
      bindings: [
        { index: 1, id: 'b2', invalid: ['projectId'] },
        { index: 2, invalid: ['id', 'serverId'] },
        { index: 3, invalid: ['entry'] },
      ],
    });
  });

  it('reports a list that is not a list, null included', () => {
    const parsed = parseSettings({ servers: [server], bindings: { b1: binding('b1') } });
    expect(parsed.settings.bindings).toEqual([]);
    expect(describeSkipped(parsed.skipped!)).toEqual({ bindings: 'not a list (object)' });
    expect(describeSkipped(parseSettings({ servers: null }).skipped!)).toEqual({
      servers: 'not a list (null)',
    });
  });

  it('gives the same settings as mergeWithDefaults', () => {
    const raw = { servers: [server, {}], bindings: [binding('b1'), 'x'], logLevel: 'debug' };
    expect(parseSettings(raw).settings).toEqual(mergeWithDefaults(raw));
  });
});

describe('settingsToSave', () => {
  it('saves settings with nothing skipped as they are', () => {
    const { settings } = parseSettings({ servers: [server], bindings: [binding('b1')] });
    expect(settingsToSave(settings, null)).toBe(settings);
  });

  it('writes skipped entries back where the file had them', () => {
    const { projectId: _projectId, ...noProject } = binding('b2');
    const raw = {
      servers: [{ id: 's2', url: 'https://home', name: 'Home' }, server],
      bindings: [noProject, binding('b1'), 'junk', binding('b3'), { id: 'b4' }],
    };
    const saved = roundTrip(raw);
    expect(saved.servers).toEqual(raw.servers);
    expect(saved.bindings).toEqual(raw.bindings);
    // And the next load skips them again, no more and no less.
    const again = parseSettings(saved);
    expect(describeSkipped(again.skipped!)).toEqual(describeSkipped(parseSettings(raw).skipped!));
  });

  it('keeps skipped entries after the readable list has changed', () => {
    const raw = { bindings: [binding('b1'), binding('b2'), { id: 'bad' }] };
    const { settings, skipped } = parseSettings(raw);
    // The user removes both good bindings, then adds a new one.
    settings.bindings = [];
    let saved = settingsToSave(settings, skipped) as Record<string, unknown>;
    expect(saved.bindings).toEqual([{ id: 'bad' }]);
    settings.bindings.push(parseSettings({ bindings: [binding('b9')] }).settings.bindings[0]!);
    saved = settingsToSave(settings, skipped) as Record<string, unknown>;
    expect(saved.bindings).toEqual([binding('b9'), { id: 'bad' }]);
  });

  it('keeps a list that is not a list as it is, until there is something to add', () => {
    const odd = { b1: binding('b1') };
    const { settings, skipped } = parseSettings({ bindings: odd });
    expect((settingsToSave(settings, skipped) as Record<string, unknown>).bindings).toBe(odd);
    settings.bindings.push(parseSettings({ bindings: [binding('b9')] }).settings.bindings[0]!);
    const saved = settingsToSave(settings, skipped) as Record<string, unknown>;
    expect(saved.bindings).toEqual([binding('b9'), odd]);
    // Read again, the old value is a skipped entry of the list now.
    expect(describeSkipped(parseSettings(saved).skipped!)).toEqual({
      bindings: [{ index: 1, invalid: ['id', 'serverId', 'projectId'] }],
    });
  });

  it('keeps a null list as it is, but never adds it to a list as an entry', () => {
    const { settings, skipped } = parseSettings({ servers: [server], bindings: null });
    expect((settingsToSave(settings, skipped) as Record<string, unknown>).bindings).toBeNull();
    settings.bindings.push(parseSettings({ bindings: [binding('b9')] }).settings.bindings[0]!);
    const saved = settingsToSave(settings, skipped) as Record<string, unknown>;
    expect(saved.bindings).toEqual([binding('b9')]);
    expect(parseSettings(JSON.parse(JSON.stringify(saved))).skipped).toBeNull();
  });

  it('leaves the other fields to the settings', () => {
    const saved = roundTrip({ bindings: [{ id: 'bad' }], logLevel: 'banana', syncOnStartup: true });
    expect(saved.logLevel).toBe('info');
    expect(saved).not.toHaveProperty('syncOnStartup');
    expect(saved.servers).toEqual([]);
  });
});

describe('describeSkipped', () => {
  it('never carries an entry itself — a server entry holds an API key', () => {
    const skipped: SkippedSettings = parseSettings({
      servers: [{ id: 's2', url: 'https://home.example.com', apiKey: 5, name: 'osk_secret' }],
      bindings: [{ id: 'b1', serverId: 's1', projectName: 'Private project' }],
    }).skipped!;
    const text = JSON.stringify(describeSkipped(skipped));
    expect(text).not.toContain('home.example.com');
    expect(text).not.toContain('osk_secret');
    expect(text).not.toContain('Private project');
    expect(text).toContain('"invalid":["apiKey"]');
  });
});
