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
 * ignores `tests/app/**`, anything else ignores `tests/demo/**`.
 *
 * ## A correction, because the first version of this comment was wrong
 *
 * It said that without `TEST_ENV` the suite "does not exist and Playwright exits
 * 0 having run nothing", and a guard was nearly built on that. Measured
 * properly, Playwright prints `Error: No tests found.` and **exits 1**. There is
 * no silent hole, so there is no guard here: one that closes nothing is the very
 * thing this repo keeps finding and deleting.
 *
 * (`--pass-with-no-tests` would reopen it. Nothing passes it, and if anything
 * ever does, this is the note that says what it costs.)
 *
 * What DOES happen without `TEST_ENV` is worse and is not about counting: the
 * run resolves the `app` environment and starts global setup against the
 * customer system. That is an SEC-2-shaped problem, and it is open.
 *
 * Two things found while building the guard that was withdrawn, kept because
 * both can come back:
 *
 * - The check that used to sit here compared `env.TEST_ENV` to `'local'` on the
 *   line after setting it literally. It could never fail. "Assert your own
 *   effect" means asserting the effect on the THING YOU AFFECTED — here that is
 *   what the child process resolved, not what this file just assigned.
 * - A first draft counted tests from a separate `--list` pass. A listing is a
 *   second process with its own environment, and the failure being guarded was
 *   exactly those two diverging: the listing would count twelve while the run
 *   executed none. Any future count must come from the run itself.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const env = { ...process.env, TEST_ENV: 'local' };

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
