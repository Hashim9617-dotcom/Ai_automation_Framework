#!/usr/bin/env node
/**
 * Runs the demo suite against the bundled app.
 *
 * A script rather than `TEST_ENV=local playwright test …` in package.json,
 * because that form is a syntax error on Windows and this repo is developed on
 * it. `cross-env` would also do it; a six-line script does not add a dependency
 * to install a variable.
 *
 * **The environment is not a detail here, it is the corpus.**
 * `playwright.config.ts` decides which tests EXIST from `TEST_ENV`: `local`
 * ignores `tests/app/**`, anything else ignores `tests/demo/**`. Run without it
 * and the demo suite is not "failing" — it does not exist, and Playwright exits
 * 0 having run nothing.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const env = { ...process.env, TEST_ENV: 'local' };

// Asserts its own premise: a run that sets up an input must check the input
// arrived. Without this a typo leaves TEST_ENV unset, zero demo tests are
// collected, and the exit code says everything passed.
if (env.TEST_ENV !== 'local') {
  console.error('refusing: TEST_ENV did not take the value this script exists to set');
  process.exit(2);
}

// Playwright's own CLI entry, run by this Node — not `npx`, whose Windows shim
// is a `.cmd` that Node 24 refuses to spawn without a shell, and not a shell,
// whose quoting rules differ between the two platforms this has to work on.
let cli;
try {
  cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
} catch (error) {
  console.error(`refusing: could not find Playwright — ${error.message}`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [cli, 'test', 'tests/demo', '--project=chromium', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);

if (result.error) {
  console.error(`refusing: could not start Playwright — ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
