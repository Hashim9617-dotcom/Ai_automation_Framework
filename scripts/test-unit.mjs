#!/usr/bin/env node
/**
 * Runs the unit suite, with the real `.env` kept out of it.
 *
 * A script rather than `AITP_FIXTURE_ONLY=1 playwright test …` in package.json,
 * because that form is a syntax error on Windows and this repo is developed on it —
 * the same reason `test-demo.mjs` exists. `cross-env` would also do it; a short
 * script does not add a dependency to install a variable.
 *
 * ## Why the flag is set HERE and nowhere else (SEC-3e)
 *
 * Measured 2026-10-01 with a probe spec inside the unit project:
 *
 *     PROBE added-by-ensureDotenv: (none)
 *     PROBE real-keys-present: APP_PASSWORD,APP_USERNAME,BASE_URL,ANTHROPIC_API_KEY
 *
 * Nothing was added by the time the test ran — the keys were already there, because
 * `playwright.config.ts` resolves environments while the config loads, in the PARENT
 * process, and every worker inherits that. So this cannot be fixed inside a test, or
 * by a fixture, or by remembering.
 *
 * It cannot be fixed in `globalSetup` either: measured 2026-09-21 (SEC-3a),
 * Playwright runs that for every invocation and hands it every project whichever was
 * selected, so it cannot tell a fixture surface from a live one.
 *
 * The invocation is the only layer that knows. Hence a script.
 *
 * **`TEST_ENV` is deliberately NOT set.** The unit project needs no environment, and
 * pinning one here would make this file a second source for a value `.env` already
 * holds — the disagreement `resolveEnvName` exists to prevent. Whatever `.env` says
 * still reaches the run, because `TEST_ENV` is on the fixture-safe allowlist.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const env = { ...process.env, AITP_FIXTURE_ONLY: '1' };

// Playwright's own CLI entry, run by this Node — not `npx`, whose Windows shim is a
// `.cmd` that Node 24 refuses to spawn without a shell.
let cli;
try {
  cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
} catch (error) {
  console.error(`refusing: could not find Playwright — ${error.message}`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [cli, 'test', '--project=unit', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);

if (result.error) {
  console.error(`refusing: could not start Playwright — ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
