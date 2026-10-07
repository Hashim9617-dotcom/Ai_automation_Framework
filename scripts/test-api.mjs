#!/usr/bin/env node
/**
 * Runs the API suite's BROWSERLESS half, with the real `.env` kept out of it.
 *
 * `pnpm verify` runs this on every commit. `pnpm test:api` is the live half and
 * keeps the `@smoke` tests, which ask the real application whether it is up.
 *
 * ## What this closes (SEC-3e, third instance)
 *
 * `test:api:internal` was `playwright test --project=api --grep-invert @smoke` with
 * no `AITP_FIXTURE_ONLY`, so the real `.env` was merged into the runner. Measured
 * 2026-10-06, in one run of eleven tests:
 *
 *     Resolved environment {"environment":"app","baseUrl":"https://<dms host>",
 *                           "storageState":"...\artifacts\dms\auth\app.json"}
 *
 * six times, interleaved with the `local` resolutions the tests actually asked for.
 *
 * **The api tests were not at fault** — every one of them passes
 * `environment: 'local'`. The source is `loadInventory()` in `command.service.ts`:
 * it spawns `playwright test --list`, that child loads `playwright.config.ts`, and
 * the config resolves the AMBIENT `TEST_ENV` rather than the environment the request
 * asked for. The DMS session file path was computed and logged; nothing read it, and
 * nothing requested that host, because `--list` launches no browser and the one test
 * that would is excluded below.
 *
 * Third instance of one pattern, which is why it gets a partition rather than a
 * patch: `NODE_PATH` inherited from the runner (a boot test that passed while
 * `pnpm api:dev` could not start), `TEST_ENV` inherited by the inventory listing (a
 * request for `local` answered from the customer suite), and now the environment
 * inherited by that listing's own config load. Every time, **a child re-resolved
 * the environment from ambient state instead of from what its caller asked for.**
 *
 * ## Why the `@smoke` exclusion stays, and is not redundant with the partition
 *
 * Measured with `--list` under `AITP_FIXTURE_ONLY=1`:
 *
 *     --project=api                       -> 13 tests in 4 files
 *     --project=api --grep-invert @smoke  -> 11 tests in 3 files
 *
 * The partition decides which ENVIRONMENT a project resolves; the tag decides which
 * TESTS want a live one. Dropping the grep would collect `app-health.spec.ts` into a
 * fixture run, where it would ask the bundled demo app — or nothing at all — whether
 * "the application under test" is up, and report a pass either way.
 *
 * ## Why a script rather than an inline variable
 *
 * `AITP_FIXTURE_ONLY=1 playwright test …` in package.json is a syntax error on
 * Windows, which this repo is developed on — the same reason `test-unit.mjs` and
 * `test-demo.mjs` exist. The flag cannot be set anywhere later: measured 2026-10-01,
 * `playwright.config.ts` resolves environments while the config loads, in the PARENT
 * process, and every worker inherits that. Not fixable in a test, a fixture, or
 * `globalSetup` (which Playwright runs for every invocation and cannot tell a
 * fixture surface from a live one). The invocation is the only layer that knows.
 *
 * **`TEST_ENV` is deliberately NOT set**, for the reason `test-unit.mjs` gives: it
 * would make this file a second source for a value `.env` already holds. `TEST_ENV`
 * is on the fixture-safe allowlist, so whatever `.env` says still reaches the run —
 * and the `api` project pins nothing from it.
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
  [cli, 'test', '--project=api', '--grep-invert', '@smoke', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);

if (result.error) {
  console.error(`refusing: could not start Playwright — ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
