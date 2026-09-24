import { checkVaultPath, isAlwaysIgnored, isIgnoredAbsolutePath } from '@/watcher/path-utils';

/**
 * The path gate compared names by `toLowerCase` of the NFC form. A disk does
 * more than that when it ignores case: APFS (macOS, case-insensitive by
 * default) folds by full Unicode case folding, HFS+ also skips some invisible
 * code points. So the server could name the config folder, `.git` or `.trash`
 * in a spelling the gate read as another folder while macOS opened the real
 * one — `.obſidian/plugins/team-vault/data.json` read the plugin's settings,
 * API key included, into a note and sent it to the project.
 *
 * And some names synced that a Windows teammate's disk can't hold as spelled:
 * a trailing dot or space (Explorer and the shell drop it, so trashing
 * `Notes.` trashed `Notes`) and `* ? < > " |` or a control character (the
 * write fails). They are now refused in both directions, like `:`.
 *
 * Look-alike and invisible characters are spelled by code point so the test
 * reads unambiguously.
 */
const u = (codePoint: number): string => String.fromCodePoint(codePoint);

const LONG_S = u(0x17f); // ſ — APFS folds it to `s`
const SHARP_S = u(0xdf); // ß — APFS: `ss`
const CAPITAL_SHARP_S = u(0x1e9e); // ẞ — APFS: `ss`, `toLowerCase`: `ß`
const KELVIN = u(0x212a); // Kelvin sign — `k`
const LIGATURE_FI = u(0xfb01); // ﬁ — APFS: `fi`
const LIGATURE_ST = u(0xfb06); // ﬆ — APFS: `st`
const DOTLESS_I = u(0x131); // ı — no disk merges it with `i`; the gate does anyway
const ZWNJ = u(0x200c); // zero-width non-joiner — HFS+ skips it
const LRM = u(0x200e); // left-to-right mark — HFS+ skips it
const BOM = u(0xfeff); // zero-width no-break space — HFS+ skips it
const FULLWIDTH_DOT = u(0xff0e); // ． — NFKC: `.`
const FULLWIDTH_GIT = [0xff27, 0xff29, 0xff34].map(u).join(''); // ＧＩＴ — NFKC: `GIT`
const FULLWIDTH_TILDE = u(0xff5e); // ～ — NFKC: `~`
const FULLWIDTH_ONE = u(0xff11); // １ — NFKC: `1`

type Reason = ReturnType<typeof checkVaultPath>;

/** Refused by the server gate, the Obsidian watcher and chokidar alike. */
function expectRefused(path: string, reason: Reason, configDir?: string): void {
  const opts = configDir === undefined ? {} : { configDir };
  expect(checkVaultPath(path, { bindingFolder: '/', ...opts })).toBe(reason);
  expect(isAlwaysIgnored(path, configDir)).toBe(true);
  expect(isIgnoredAbsolutePath(`/Users/u/vault/${path}`, '/Users/u/vault', configDir)).toBe(true);
}

function expectSynced(path: string, configDir?: string): void {
  const opts = configDir === undefined ? {} : { configDir };
  expect(checkVaultPath(path, { bindingFolder: '/', ...opts })).toBeNull();
  expect(isAlwaysIgnored(path, configDir)).toBe(false);
}

describe('spellings a case-insensitive disk opens as a refused folder', () => {
  it.each([
    // APFS: full case folding
    `.ob${LONG_S}idian/plugins/team-vault/data.json`,
    `.OB${LONG_S}IDIAN/plugins/team-vault/data.json`,
    // HFS+: skipped code points
    `.obs${ZWNJ}idian/plugins/team-vault/data.json`,
    `${BOM}.obsidian/plugins/team-vault/data.json`,
    // a volume that normalizes names by NFKC
    `${FULLWIDTH_DOT}obsidian/plugins/team-vault/data.json`,
  ])('refuses the default config folder spelled %j', (path) => {
    expectRefused(path, 'ignored');
  });

  it.each([
    `.tra${LONG_S}h/deleted.md`,
    `.TRA${LONG_S}H/deleted.md`,
    `.tra${ZWNJ}sh/deleted.md`,
    `notes/.trash${LRM}/deleted.md`,
  ])('refuses Obsidian trash spelled %j', (path) => {
    expectRefused(path, 'ignored');
  });

  it.each([
    `.g${ZWNJ}it/hooks/post-checkout`,
    `.git${LRM}/hooks/post-checkout`,
    `.g${DOTLESS_I}t/hooks/post-checkout`,
    `.${FULLWIDTH_GIT}/hooks/post-checkout`,
    `notes/${FULLWIDTH_DOT}git/config`,
  ])('refuses a repository spelled %j', (path) => {
    expectRefused(path, 'ignored');
  });

  it.each([
    ['.mysettings', `.my${LONG_S}ettings/plugins/team-vault/data.json`],
    ['.mysettings', `.MYSETTING${LONG_S}/plugins/team-vault/data.json`],
    ['.mysettings', `.my${ZWNJ}settings/plugins/team-vault/data.json`],
    ['.config', `.con${LIGATURE_FI}g/plugins/team-vault/data.json`],
    ['.klasse', `.kla${SHARP_S}e/plugins/team-vault/data.json`],
    ['.klasse', `.kla${CAPITAL_SHARP_S}e/plugins/team-vault/data.json`],
    ['.klasse', `.${KELVIN}LASSE/plugins/team-vault/data.json`],
    // the folder set in Obsidian holds the look-alike, the server the plain name
    [`.kla${SHARP_S}e`, '.klasse/plugins/team-vault/data.json'],
    [`.kla${SHARP_S}e`, `.KLA${CAPITAL_SHARP_S}E/plugins/team-vault/data.json`],
    [`.con${LIGATURE_FI}g`, '.CONFIG/plugins/team-vault/data.json'],
  ])('refuses the custom config folder %j spelled %j', (configDir, path) => {
    expectRefused(path, 'ignored', configDir);
  });

  it('refuses a service file spelled with a ligature', () => {
    expectRefused(`notes/.DS_${LIGATURE_ST}ore`, 'ignored');
  });
});

describe('names Windows would store under another name, or not at all', () => {
  it.each([
    'Notes./idea.md',
    'Notes /idea.md',
    'Notes.../idea.md',
    'notes/idea.md.',
    'notes/idea.md ',
    '.../idea.md',
    ' /idea.md',
    '.obsidian./plugins/team-vault/data.json',
    '.obsidian /plugins/team-vault/data.json',
    '.git./hooks/post-checkout',
  ])('refuses %j, whose trailing dot or space Windows drops', (path) => {
    expectRefused(path, 'invalid');
    expect(isIgnoredAbsolutePath(`D:\\vault\\${path.replace(/\//g, '\\')}`, 'D:\\vault')).toBe(
      true,
    );
  });

  it.each([
    'Why?.md',
    'What now?/idea.md',
    'notes/a*b.md',
    'notes/<draft>.md',
    'notes/say "hi".md',
    'notes/yes|no.md',
    `notes/tab${u(0x09)}here.md`,
    `notes/bell${u(0x07)}.md`,
    `notes/nul${u(0x00)}.md`,
    `notes/unit${u(0x1f)}sep.md`,
  ])('refuses %j, a name Windows cannot store', (path) => {
    expectRefused(path, 'invalid');
  });

  it('refuses a short name spelled with a letter that case folding expands', () => {
    // `STRAßE~1` is 8 characters as spelled, and NTFS's short names may hold
    // `ß`: the folded `strasse~1` would be too long to look like one.
    expectRefused(`STRA${SHARP_S}E~1/idea.md`, 'invalid');
  });

  it('keeps names Windows stores as spelled', () => {
    expectSynced('Mr. Smith.md');
    expectSynced('v1.2 notes/idea.md');
    expectSynced('notes/ leading space.md');
    expectSynced("notes/#tag & [link] (1) {x} !@$%^'+=.md");
    expectSynced('notes/100% done; ok, fine.md');
    expectSynced('notes/idea.md');
  });
});

describe('ordinary notes are not affected by the stricter comparison', () => {
  it.each([
    `Stra${SHARP_S}e/Notizen.md`,
    'STRASSE/idea.md',
    `${u(0x130)}stanbul/${DOTLESS_I}spanak.md`,
    'Ελληνικά/Σημειώσεις ς.md',
    `notes/${u(0x645)}${u(0x6cc)}${ZWNJ}${u(0x62e)}${u(0x648)}${u(0x627)}${u(0x647)}${u(0x645)}.md`,
    `${u(0x65e5)}${u(0x8a18)}${FULLWIDTH_TILDE}/memo${FULLWIDTH_TILDE}${FULLWIDTH_ONE}.md`,
    `${LIGATURE_FI}nance/${LIGATURE_FI}le.md`,
    `notes/${KELVIN}elvin.md`,
    `${FULLWIDTH_DOT}notes/idea.md`,
    '.obsidian-notes/idea.md',
  ])('syncs %j', (path) => {
    expectSynced(path);
  });

  it('keeps a folder named like the custom config folder below the vault root', () => {
    // Obsidian reads its settings from `<vault>/<configDir>` only.
    expectSynced(`notes/.my${LONG_S}ettings/app.json`, '.mysettings');
    expectSynced('notes/.mysettings/app.json', '.mysettings');
  });
});
