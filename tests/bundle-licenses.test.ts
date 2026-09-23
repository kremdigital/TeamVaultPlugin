/**
 * `scripts/bundle-licenses.mjs` — the license notices esbuild.config.mjs
 * appends to main.js for every third-party package bundled into it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  LICENSE_FILE_PATTERN,
  bundledPackageDirs,
  collectBundledLicenses,
  formatLicenseComment,
  packageDirOf,
  readPackageLicense,
} from '../scripts/bundle-licenses.mjs';

const ROOT = join(__dirname, '..');

type Inputs = Record<string, { bytesInOutput: number }>;

/** The slice of an esbuild metafile the collector reads. */
function metafile(inputs: Inputs, outfile = 'main.js') {
  return { inputs: {}, outputs: { [outfile]: { inputs, imports: [], exports: [], bytes: 0 } } };
}

function writePackage(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  const abs = join(root, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'package.json'), JSON.stringify(pkg));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(abs, name), text);
}

describe('packageDirOf', () => {
  it('maps a file in the pnpm store to its package root', () => {
    expect(
      packageDirOf('node_modules/.pnpm/diff@9.0.0/node_modules/diff/libesm/diff/base.js'),
    ).toBe('node_modules/.pnpm/diff@9.0.0/node_modules/diff');
  });

  it('maps a file in a flat npm layout', () => {
    expect(packageDirOf('node_modules/yjs/dist/yjs.mjs')).toBe('node_modules/yjs');
  });

  it('keeps the scope of a scoped package', () => {
    expect(
      packageDirOf(
        'node_modules/.pnpm/@socket.io+component-emitter@3.1.2/node_modules/@socket.io/component-emitter/lib/esm/index.js',
      ),
    ).toBe(
      'node_modules/.pnpm/@socket.io+component-emitter@3.1.2/node_modules/@socket.io/component-emitter',
    );
  });

  it('takes the innermost package of a nested copy', () => {
    expect(packageDirOf('node_modules/a/node_modules/b/index.js')).toBe(
      'node_modules/a/node_modules/b',
    );
  });

  it('ignores first-party files and virtual modules', () => {
    expect(packageDirOf('src/main.ts')).toBeNull();
    expect(packageDirOf('(disabled):node_modules/ws/browser.js')).toBeNull();
    expect(packageDirOf('virtual:node_modules/x/index.js')).toBeNull();
  });

  it('keeps absolute paths — a Windows drive letter is not a namespace', () => {
    // esbuild reports a file on another drive than the project as absolute.
    expect(packageDirOf('D:/deps/node_modules/diff/libcjs/index.js')).toBe(
      'D:/deps/node_modules/diff',
    );
    expect(packageDirOf('D:\\deps\\node_modules\\@scope\\pkg\\index.js')).toBe(
      'D:/deps/node_modules/@scope/pkg',
    );
    expect(packageDirOf('/home/u/deps/node_modules/yjs/dist/yjs.mjs')).toBe(
      '/home/u/deps/node_modules/yjs',
    );
  });
});

describe('bundledPackageDirs', () => {
  it('lists each package once and skips code that was tree-shaken away', () => {
    const dirs = bundledPackageDirs(
      metafile({
        'src/main.ts': { bytesInOutput: 100 },
        'node_modules/yjs/dist/a.mjs': { bytesInOutput: 10 },
        'node_modules/yjs/dist/b.mjs': { bytesInOutput: 20 },
        'node_modules/unused/index.js': { bytesInOutput: 0 },
      }),
      'main.js',
    );
    expect(dirs).toEqual(['node_modules/yjs']);
  });

  it('throws for an output the metafile does not have', () => {
    expect(() => bundledPackageDirs(metafile({}), 'other.js')).toThrow('no output "other.js"');
  });

  it('fails on a bundled dependency file it cannot map to a package', () => {
    expect(() =>
      bundledPackageDirs(metafile({ 'node_modules/': { bytesInOutput: 1 } }), 'main.js'),
    ).toThrow('cannot tell which package');
  });
});

describe('LICENSE_FILE_PATTERN', () => {
  it.each(['LICENSE', 'license', 'LICENSE.md', 'License.txt', 'LICENCE', 'COPYING', 'LICENSE-MIT'])(
    'matches %s',
    (name) => {
      expect(LICENSE_FILE_PATTERN.test(name)).toBe(true);
    },
  );

  it.each(['README.md', 'package.json', 'licenses.json', 'unlicense'])(
    'does not match %s',
    (name) => {
      expect(LICENSE_FILE_PATTERN.test(name)).toBe(false);
    },
  );
});

describe('readPackageLicense / collectBundledLicenses', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bundle-licenses-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads name, version, license and every license file, sorted, with LF endings', () => {
    writePackage(
      root,
      'node_modules/dual',
      { name: 'dual', version: '1.2.3', license: '(MIT OR Apache-2.0)' },
      {
        'LICENSE-MIT': `${String.fromCharCode(0xfeff)}MIT text\r\nline two\r\n`,
        'LICENSE-APACHE': 'Apache text\n',
        'README.md': 'not a license',
      },
    );
    expect(readPackageLicense(root, 'node_modules/dual')).toEqual({
      name: 'dual',
      version: '1.2.3',
      license: '(MIT OR Apache-2.0)',
      files: [
        { file: 'LICENSE-APACHE', text: 'Apache text' },
        { file: 'LICENSE-MIT', text: 'MIT text\nline two' },
      ],
    });
  });

  it('understands the legacy license object and licenses array', () => {
    writePackage(root, 'node_modules/old', {
      name: 'old',
      version: '0.1.0',
      license: { type: 'BSD-2-Clause' },
    });
    writePackage(root, 'node_modules/older', {
      name: 'older',
      version: '0.0.1',
      licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }],
    });
    writePackage(root, 'node_modules/none', { name: 'none', version: '1.0.0' });
    expect(readPackageLicense(root, 'node_modules/old').license).toBe('BSD-2-Clause');
    expect(readPackageLicense(root, 'node_modules/older').license).toBe('MIT OR GPL-2.0');
    expect(readPackageLicense(root, 'node_modules/none').license).toBe('unknown');
  });

  it('collects bundled packages once per name@version, sorted by name', () => {
    writePackage(root, 'node_modules/zeta', { name: 'zeta', version: '1.0.0', license: 'MIT' });
    writePackage(root, 'node_modules/@scope/alpha', {
      name: '@scope/alpha',
      version: '2.0.0',
      license: 'ISC',
    });
    writePackage(root, 'node_modules/zeta/node_modules/beta', {
      name: 'beta',
      version: '3.0.0',
      license: 'MIT',
    });
    const packages = collectBundledLicenses(
      metafile({
        'node_modules/zeta/index.js': { bytesInOutput: 1 },
        'node_modules/zeta/node_modules/beta/index.js': { bytesInOutput: 1 },
        'node_modules/@scope/alpha/index.js': { bytesInOutput: 1 },
      }),
      'main.js',
      root,
    );
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      '@scope/alpha@2.0.0',
      'beta@3.0.0',
      'zeta@1.0.0',
    ]);
    // Nothing machine-specific may reach the bundle.
    expect(JSON.stringify(packages)).not.toContain(root);
    expect(JSON.stringify(packages)).not.toContain('node_modules');
  });

  it('reads a package the metafile names by an absolute path', () => {
    writePackage(root, 'elsewhere/node_modules/far', {
      name: 'far',
      version: '1.0.0',
      license: 'MIT',
    });
    const absolute = join(root, 'elsewhere/node_modules/far/index.js').replace(/\\/g, '/');
    const packages = collectBundledLicenses(
      metafile({ [absolute]: { bytesInOutput: 1 } }),
      'main.js',
      join(root, 'project'),
    );
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(['far@1.0.0']);
  });

  it('finds the BSD-3-Clause notice of the real `diff` package as installed', () => {
    // The metafile path esbuild reports for the real install (pnpm store or
    // npm's flat node_modules — whichever this checkout uses).
    const diffRoot = relative(ROOT, realpathSync(join(ROOT, 'node_modules', 'diff'))).replace(
      /\\/g,
      '/',
    );
    const [diff] = collectBundledLicenses(
      metafile({ [`${diffRoot}/libcjs/index.js`]: { bytesInOutput: 1 } }),
      'main.js',
      ROOT,
    );
    expect(diff?.name).toBe('diff');
    expect(diff?.license).toBe('BSD-3-Clause');
    expect(diff?.files.map((f) => f.file)).toEqual(['LICENSE']);
    expect(diff?.files[0]?.text).toContain('Kevin Decker');
    expect(diff?.files[0]?.text).toContain('Redistributions in binary form must reproduce');
  });
});

describe('formatLicenseComment', () => {
  const mit = {
    name: 'mit-pkg',
    version: '1.0.0',
    license: 'MIT',
    files: [{ file: 'LICENSE', text: 'Copyright (c) Someone\n\nPermission is hereby granted' }],
  };
  const bare = { name: 'bare-pkg', version: '0.1.0', license: 'ISC', files: [] };

  it('is one legal comment: the package list, then each license text in full', () => {
    const comment = formatLicenseComment([mit, bare]);
    expect(comment.startsWith('/*! ')).toBe(true);
    expect(comment.endsWith('\n*/\n')).toBe(true);
    // Nothing closes the comment before its end.
    expect(comment.indexOf('*/')).toBe(comment.length - 3);
    expect(comment).toContain('- bare-pkg@0.1.0 (ISC) - no license file in the package\n');
    expect(comment).toContain('- mit-pkg@1.0.0 (MIT)\n');
    expect(comment.indexOf('- bare-pkg@0.1.0')).toBeLessThan(comment.indexOf('- mit-pkg@1.0.0'));
    expect(comment).toContain('mit-pkg@1.0.0 (MIT): LICENSE');
    expect(comment).toContain('Copyright (c) Someone\n\nPermission is hereby granted');
    expect(comment).toContain('The package ships no license file; package.json declares ISC.');
  });

  it('is the same whatever order the packages come in', () => {
    expect(formatLicenseComment([bare, mit])).toBe(formatLicenseComment([mit, bare]));
  });

  it('escapes a `*/` inside a license text so it cannot end the comment early', () => {
    const tricky = { ...mit, files: [{ file: 'LICENSE', text: 'a */ alert(1) /* b' }] };
    const comment = formatLicenseComment([tricky]);
    expect(comment.indexOf('*/')).toBe(comment.length - 3);
    expect(comment).toContain('a *\\/ alert(1) /* b');
  });
});
