import { expect, test } from '@playwright/test';
import {
  assertKitIntegrity,
  loadEnvironment,
  maintainerMarkerPath,
  resolveEnvName,
} from '@aitp/execution-engine';
import { findRepoRoot, rootLogger } from '@aitp/shared';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const log = rootLogger.child('live-setup');

/**
 * The setup project every LIVE project depends on, and no fixture project does.
 *
 * SEC-3a. `globalSetup` cannot carry this: measured 2026-09-21, Playwright runs
 * it for every invocation regardless of `--project`, and the `FullConfig` it
 * receives lists all six projects whichever one was selected — so it cannot tell
 * a fixture surface from a live one. A setup project can, because a project's
 * `dependencies` run only when that project is selected. Measured the same day,
 * both halves:
 *
 *   --project=withDep   its `setup` dependency RAN
 *   --project=noDep     another project's dependency did NOT run
 *
 * So this file is the first place in the run that knows a live surface was
 * asked for, which is the only place the refusal can sit.
 */

/** Written so an ABSENCE can be checked by looking at something complete. */
export const LIVE_SETUP_MARKER = path.join('artifacts', 'live-setup-ran.txt');

/**
 * THE INTEGRITY CHECK, FOR EVERY LIVE BROWSER RUN (C: kit lock).
 *
 * `pnpm test`, `test:regression`, `test:headed`, `test:ui` and `test:smoke:live` all
 * drive the customer's application, so a modified kit must not produce a pass through
 * them either — and the five QA scripts are not the only door.
 *
 * THIS FILE IS THE RIGHT HOOK, and the reason is already measured in the docstring
 * above: a setup project's dependency runs only when a live project is selected.
 * `globalSetup` cannot carry it — Playwright runs that for every invocation and it
 * cannot tell a fixture surface from a live one, so the check would fire for
 * `pnpm test:unit` and `pnpm test:demo` as well, and `pnpm verify` would then depend
 * on the manifest being current at every commit rather than at every release.
 *
 * Consequence worth knowing: the nightly Jenkins job runs `--project=chromium`, so it
 * DOES reach this. In a clean clone of a commit whose manifest is current it passes.
 * If a commit lands without `pnpm kit:manifest`, that job refuses — which is the
 * check working, and `pnpm kit:manifest --check` is how to catch it beforehand.
 */
test('the kit has not been modified', () => {
  // wrong: a live run against a customer system from a kit somebody edited, and its
  // report reads exactly like a run from an unmodified one.
  const kitRoot = findRepoRoot();
  const result = assertKitIntegrity({
    root: kitRoot,
    markerPath: maintainerMarkerPath(kitRoot),
    write: (line) => log.info(line.trim()),
  });
  expect(result.ok).toBe(true);
});
test('the live environment is named explicitly', () => {
  // wrong: this passes with no environment named, `resolveEnvName()` assumes a
  // live system, and a run nobody pointed anywhere logs into a customer's.
  const name = resolveEnvName();
  const env = loadEnvironment();

  mkdirSync(path.dirname(LIVE_SETUP_MARKER), { recursive: true });
  writeFileSync(LIVE_SETUP_MARKER, `${name} ${env.baseUrl}\n`, 'utf8');

  log.info('Live suite starting', {
    environment: env.name,
    baseUrl: env.baseUrl,
    selfHealing: env.features.selfHealing,
    aiRootCause: env.features.aiRootCause,
  });
});
