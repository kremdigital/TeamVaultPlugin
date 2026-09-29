import base from './jest.config.mjs';

/**
 * End-to-end suite (`pnpm test:e2e`): the plugin's engine against the sync
 * stand of the server next door (`tests/e2e/global-setup.ts`). Not part of
 * `pnpm test`: it needs PostgreSQL running and a server checkout with its
 * dependencies (`TV_SERVER_DIR`, `../server` by default). See RELEASING.md.
 *
 * One stand for the run and real timers: the scenarios run one at a time.
 */
/** @type {import('jest').Config} */
export default {
  ...base,
  testMatch: ['<rootDir>/tests/e2e/**/*.e2e.ts'],
  globalSetup: '<rootDir>/tests/e2e/global-setup.ts',
  globalTeardown: '<rootDir>/tests/e2e/global-teardown.ts',
  testTimeout: 90_000,
  maxWorkers: 1,
};
