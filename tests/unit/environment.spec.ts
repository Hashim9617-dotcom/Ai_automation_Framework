import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveEnvName, resetEnvironmentCache } from '@aitp/execution-engine';

/**
 * Regression coverage for the bug that cost days to track down: TEST_ENV
 * usually lives in .env, not the shell, but resolveEnvName() (and the two
 * functions that used to inline this logic) defaulted a parameter to
 * `process.env.TEST_ENV ?? 'qa'` — evaluated before .env was ever loaded — so
 * a TEST_ENV set only in .env was silently ignored in favour of 'qa'.
 */
test.describe('resolveEnvName', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  test.beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'aitp-env-test-'));
    writeFileSync(path.join(tempDir, 'pnpm-workspace.yaml'), '');
    delete process.env.TEST_ENV;
    process.env.AITP_REPO_ROOT = tempDir;
    resetEnvironmentCache();
  });

  test.afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    resetEnvironmentCache();
  });

  test('honours TEST_ENV set only in .env, not the shell', () => {
    writeFileSync(path.join(tempDir, '.env'), 'TEST_ENV=app\n');

    // Nothing exported in the shell — this is the exact scenario that used
    // to silently fall back to 'qa'.
    expect(process.env.TEST_ENV).toBeUndefined();
    expect(resolveEnvName()).toBe('app');
  });

  test('a shell-exported TEST_ENV still wins over .env', () => {
    writeFileSync(path.join(tempDir, '.env'), 'TEST_ENV=app\n');
    process.env.TEST_ENV = 'staging';

    expect(resolveEnvName()).toBe('staging');
  });

  test('falls back to "qa" when TEST_ENV is set nowhere', () => {
    writeFileSync(path.join(tempDir, '.env'), 'BASE_URL=https://example.test\n');

    expect(resolveEnvName()).toBe('qa');
  });
});
