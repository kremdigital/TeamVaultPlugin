import { createHash } from 'node:crypto';
import { transformSync, version } from 'esbuild';

/**
 * Jest transformer for the plain-Node `.mjs` scripts in `scripts/` (release
 * notes, bundle licenses), so tests can import them directly.
 *
 * The suite runs as CommonJS (no `--experimental-vm-modules`) and nothing
 * transformed `.mjs` files, so such an import failed with "Cannot use
 * import statement outside a module". esbuild — already the plugin's
 * bundler — rewrites the module to CJS. `import.meta` has no CJS equivalent
 * and comes out empty; the scripts rely on that to tell "run as a CLI" from
 * "imported by a test".
 */
const options = {
  loader: 'js',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  // The empty `import.meta` warning is expected here (see above).
  logLevel: 'error',
};

export default {
  process(source, filename) {
    return { code: transformSync(source, { ...options, sourcefile: filename }).code };
  },
  // Jest's default key ignores the transformer itself; an esbuild upgrade or
  // an options change must not serve stale cached output.
  getCacheKey(source, filename) {
    return createHash('sha256')
      .update(`${version}\0${JSON.stringify(options)}\0${filename}\0${source}`)
      .digest('hex');
  },
};
