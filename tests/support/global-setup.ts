import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadEnvironment } from '@aitp/execution-engine';
import { rootLogger } from '@aitp/shared';

const log = rootLogger.child('global-setup');

/**
 * Runs once before the whole suite. Keep it cheap: anything per-test belongs in
 * a fixture. Authentication state seeding (storageState) also goes here once the
 * real application is wired in.
 *
 * Deliberately does NOT try to archive the previous run's artifacts here —
 * Playwright wipes its own `outputDir` (test-results) internally before this
 * hook ever runs, so by the time this code executes there is nothing left of
 * the previous run's traces/videos to save. That archival instead happens at
 * the END of a run, in AitpReporter.onEnd (packages/reporting-engine), while
 * the artifacts it needs are still on disk.
 */
export default async function globalSetup(): Promise<void> {
  const env = loadEnvironment();
  const artifacts = path.join(process.cwd(), 'artifacts');

  if (process.env.CLEAN_ARTIFACTS !== 'false') {
    rmSync(path.join(artifacts, 'reports'), { recursive: true, force: true });
    rmSync(path.join(artifacts, 'test-results'), { recursive: true, force: true });
  }
  mkdirSync(path.join(artifacts, 'reports'), { recursive: true });

  log.info('Suite starting', {
    environment: env.name,
    baseUrl: env.baseUrl,
    selfHealing: env.features.selfHealing,
    aiRootCause: env.features.aiRootCause,
  });
}
