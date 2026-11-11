import {
  RunStatus,
  TestOutcome,
  type AuthoredRunResult,
  type Run,
  type RowResult,
  type RunTarget,
  type TestResult,
} from '@aitp/shared';

/**
 * A SHEET RUN, in the shape the email body already reads.
 *
 * ## Why an adapter rather than a second renderer
 *
 * `pnpm run-sheet` produces an `AuthoredRunResult` — rows with a `RowStatus` — and a
 * Playwright suite produces a `Run` with `TestResult`s. Two renderers would mean two
 * places where "what does a failure look like in a mail" is decided, and the second
 * one would drift: the comparison, the subject, the Outlook constraints and the
 * escaping would all be re-derived, and a drifted copy reads exactly like a correct
 * one (§AE).
 *
 * So a sheet run is mapped ONCE, here, and everything downstream is shared.
 *
 * ## The six statuses do not collapse to two
 *
 * This is the part worth getting right, because the obvious mapping destroys the
 * whole point of the sheet pipeline. `refused`, `held` and `unreadable` are NOT
 * failures — they are the platform saying it did not run the row, and why. Reporting
 * them as failures would tell an app team that 662 rows broke when nothing ran at
 * all, which is the category error this repo keeps separate statuses to prevent.
 *
 * They map to `skipped`, which is the only outcome in `TestOutcome` that means "not
 * executed". The row's own status and reason travel in the TITLE, so the mail still
 * says `held` rather than flattening it to "skipped" — the colour is coarse, the
 * words are not.
 */

/** Which sheet statuses are genuine failures of the application under test. */
const FAILING: ReadonlySet<string> = new Set(['failed']);

/**
 * Statuses where the platform, not the application, is the subject.
 *
 * `stale-capture` is here deliberately: the row resolved and the target was not on
 * the page, which is a fact about the capture's age and not about the app. Calling
 * it a failure sends the app team hunting for a bug that does not exist (§3).
 */
const NOT_EXECUTED: ReadonlySet<string> = new Set([
  'refused',
  'held',
  'unreadable',
  'given-not-reached',
  'stale-capture',
]);

function outcomeOf(status: string): TestOutcome {
  if (FAILING.has(status)) return TestOutcome.Failed;
  if (NOT_EXECUTED.has(status)) return TestOutcome.Skipped;
  return TestOutcome.Passed;
}

/**
 * One row as one execution.
 *
 * The title is `<module> › <ROWID> <title>` so the body's own extraction finds the
 * module and the case id without a second code path — the sheet's `rowId` is
 * `SI_002 / TC_001`, and its FIRST half is what matches the id shape, so the
 * composite is kept in the name where a reader can still see all of it.
 */
function rowToResult(row: RowResult): TestResult {
  const status = row.status as string;
  const executed = !NOT_EXECUTED.has(status);
  const detail = row.detail?.trim() ?? '';
  return {
    id: row.rowId,
    // The status is in the name, not only in the colour: `held` and `refused` are
    // both "skipped" to a mail client and are completely different to a reader.
    title: `${row.module || '(no module)'} › ${row.testCaseId} ${row.title}${
      executed ? '' : ` [${status}]`
    }`,
    file: `sheet row ${row.sheetRow}`,
    project: 'run-sheet',
    tags: [],
    outcome: outcomeOf(status),
    // A sheet row has no measured duration — there is no per-row clock in the
    // executor. ZERO is the honest value, and the body prints `0 ms` rather than
    // inventing a number that would be averaged by somebody later.
    durationMs: 0,
    retry: 0,
    ...(detail === ''
      ? {}
      : {
          error: {
            // `detail` carries the reason for every non-passing status, which is
            // exactly the one line the body shows. No RCA: nothing has analysed a
            // sheet row, and an empty RCA block would imply something had.
            message: detail,
          },
        }),
    steps: [],
    attachments: [],
  };
}

export interface AuthoredRunAsRunInput {
  authored: AuthoredRunResult;
  target: RunTarget;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** A sheet run as a `Run`, for the one email renderer. */
export function authoredRunAsRun(input: AuthoredRunAsRunInput): Run {
  const results = input.authored.results.map(rowToResult);
  const failed = results.filter((result) => result.outcome === TestOutcome.Failed).length;
  const skipped = results.filter((result) => result.outcome === TestOutcome.Skipped).length;
  const passed = results.length - failed - skipped;

  // DERIVED FROM THE MAPPED RESULTS, never copied from the tally. The tally has six
  // buckets and this summary has four, so copying would require deciding the mapping
  // twice — and the two would then be able to disagree about the same run, which is
  // the drift this adapter exists to prevent.
  const executed = results.length - skipped;
  return {
    id: input.authored.runId,
    status: failed > 0 ? RunStatus.Failed : RunStatus.Passed,
    request: {
      environment: input.target.environment,
      browsers: ['chromium'],
      headed: false,
      metadata: {},
    },
    createdAt: input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    summary: {
      total: results.length,
      passed,
      failed,
      skipped,
      flaky: 0,
      durationMs: input.durationMs,
      passRate: executed === 0 ? 0 : Number(((passed / executed) * 100).toFixed(2)),
    },
    target: input.target,
    artifacts: {},
    results,
  };
}
