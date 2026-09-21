import { test } from '@playwright/test';
import { loadEnvironment, resolveEnvName } from '@aitp/execution-engine';
import { rootLogger } from '@aitp/shared';
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
