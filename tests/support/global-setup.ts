import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadEnvironment, pruneDirectories } from '@aitp/execution-engine';
import { rootLogger } from '@aitp/shared';

const log = rootLogger.child('global-setup');

/**
 * Failure archives (artifacts/runs/<runId>/, written by AitpReporter.onEnd)
 * accumulate one directory per failing or flaky run, each holding that run's
 * full reports + test-results — traces and videos included, so tens of MB
 * apiece. Nightly runs would grow that without bound and eventually fill the
 * disk, which surfaces as a run dying on ENOSPC one morning with no obvious
 * cause.
 *
 * Policy: keep the newest MAX_ARCHIVED_RUNS, and drop anything older than
 * MAX_ARCHIVE_AGE_DAYS. Both rules prune, so the count is a genuine hard cap
 * rather than a suggestion. Note the tradeoff that buys: an archive from a
 * rare flake that nobody investigated is deleted at 14 days even if it's the
 * only copy of that evidence. Raising MAX_ARCHIVE_AGE_DAYS trades disk for a
 * longer window to notice.
 *
 * Deliberately NOT the same policy as inspection captures (scripts/inspect-app.ts),
 * which are provenance rather than diagnostics and are never aged out — see
 * the note there.
 */
const MAX_ARCHIVED_RUNS = 10;
const MAX_ARCHIVE_AGE_DAYS = 14;

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
 * the artifacts it needs are still on disk. Pruning those archives is the
 * opposite case and belongs here: it only needs the directory listing, which
 * survives everything.
 */
export default async function globalSetup(): Promise<void> {
  const env = loadEnvironment();
  const artifacts = path.join(process.cwd(), 'artifacts');

  if (process.env.CLEAN_ARTIFACTS !== 'false') {
    rmSync(path.join(artifacts, 'reports'), { recursive: true, force: true });
    rmSync(path.join(artifacts, 'test-results'), { recursive: true, force: true });
  }
  mkdirSync(path.join(artifacts, 'reports'), { recursive: true });

  // Outside the CLEAN_ARTIFACTS guard on purpose: that flag suppresses wiping
  // the *current* run's inputs while debugging, but the archive cap is a disk
  // safety net that has to hold on every run, however the suite was invoked.
  const { pruned, retained } = pruneDirectories(path.join(artifacts, 'runs'), {
    keep: MAX_ARCHIVED_RUNS,
    maxAgeDays: MAX_ARCHIVE_AGE_DAYS,
  });
  if (pruned.length > 0) {
    log.info('Pruned old failure archives', {
      pruned: pruned.length,
      retained,
      policy: `keep newest ${MAX_ARCHIVED_RUNS}, drop older than ${MAX_ARCHIVE_AGE_DAYS}d`,
      runIds: pruned,
    });
  }

  log.info('Suite starting', {
    environment: env.name,
    baseUrl: env.baseUrl,
    selfHealing: env.features.selfHealing,
    aiRootCause: env.features.aiRootCause,
  });
}
