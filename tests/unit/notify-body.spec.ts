import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  FailureCategory,
  RunStatus,
  TestOutcome,
  boundEndpoints,
  describeTarget,
  emptySummary,
  findRepoRoot,
  summariseEndpoints,
  type Run,
  type TestResult,
} from '@aitp/shared';
import {
  MAX_LISTED_ENDPOINTS,
  compareRuns,
  describeRunForHistory,
  errorHeadline,
  moduleFrom,
  failureRows,
  previousRunRecord,
  recordRun,
  renderReportEmailHtml,
  renderReportEmailText,
  testCaseIdFrom,
  testNameFrom,
  verdictOf,
  zipDirectory,
  type ReportEmailInput,
} from '@aitp/reporting-engine';
import { stripComments } from '../support/strip-comments';

/**
 * THE EMAIL BODY, AND WHAT MUST NOT BE IN IT.
 *
 * ## Why a second renderer rather than a flag on the existing one
 *
 * `renderRunSummaryHtml` is a web page: a `<style>` block, flexbox tiles, CSS custom
 * properties, `prefers-color-scheme`. Outlook for Windows renders mail through
 * Word's engine and silently drops every one of those, so the page would arrive as
 * an unstyled stack of text with the summary tiles in a vertical column and nobody
 * would know why. B1 asserts the constraints structurally, because "it renders in
 * Outlook" is not checkable from here and "it contains no construct Outlook drops"
 * is.
 *
 * ## The sentinel is the control that matters
 *
 * B9 plants a secret in `process.env` AND in a `.env` file inside the report
 * directory, then asserts it reaches neither the body nor the zip. Both halves are
 * needed: the body's protection is that it reads no environment at all (asserted as
 * a scan in B10, because that is a claim about code), and the zip's is the exclusion
 * denylist — two different mechanisms, one requirement.
 */

const ROOT = findRepoRoot();

function resultOf(overrides: Partial<TestResult> & Pick<TestResult, 'id' | 'title'>): TestResult {
  return {
    file: 'tests/apps/ecom/departments.spec.ts',
    project: 'chromium',
    tags: [],
    outcome: TestOutcome.Passed,
    durationMs: 1200,
    retry: 0,
    steps: [],
    attachments: [],
    ...overrides,
  };
}

/** A run. Typed, not cast (§AD), so a field the renderer reads cannot be forgotten. */
function runOf(results: TestResult[], status: RunStatus = RunStatus.Passed): Run {
  const failed = results.filter(
    (r) => r.outcome === TestOutcome.Failed || r.outcome === TestOutcome.TimedOut,
  ).length;
  return {
    id: 'run_feed0001',
    status,
    request: { environment: 'qa', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt: '2026-11-10T09:00:00.000Z',
    startedAt: '2026-11-10T09:00:01.000Z',
    finishedAt: '2026-11-10T09:02:11.000Z',
    summary: {
      ...emptySummary(),
      total: results.length,
      passed: results.length - failed,
      failed,
      durationMs: 130_000,
      passRate:
        results.length === 0
          ? 0
          : Number((((results.length - failed) / results.length) * 100).toFixed(2)),
    },
    target: describeTarget('qa', 'https://qa.example.test', 'ecom'),
    artifacts: {},
    results,
  };
}

function inputOf(run: Run, overrides: Partial<ReportEmailInput> = {}): ReportEmailInput {
  return {
    run,
    application: 'ecom',
    environment: 'qa',
    baseUrl: 'https://qa.example.test',
    ranBy: 'me@contoso.com',
    comparison: null,
    ...overrides,
  };
}

test.describe('the report email body @unit', () => {
  test('B15: a FLAKY test shows the error from the attempt that failed', () => {
    // wrong: reading the error off the attempt that DECIDED the outcome, which for a
    // flaky test is the one that passed and has no error. Found by reading a preview,
    // not by reasoning: the row said `(no error message recorded)` and the one piece
    // of information somebody opens that section for was on an earlier row of
    // `run.results`, being thrown away.
    const failedAttempt = resultOf({
      id: 'same',
      title: 'Categories › CAT-001 list loads',
      outcome: TestOutcome.Failed,
      error: { message: 'the grid never rendered' },
      retry: 0,
    });
    const passingRetry = resultOf({
      id: 'same',
      title: 'Categories › CAT-001 list loads',
      outcome: TestOutcome.Flaky,
      retry: 1,
    });
    const rows = failureRows(runOf([failedAttempt, passingRetry]));

    expect(rows, 'a flaky test is one row, not two').toHaveLength(1);
    expect(rows[0]!.error?.message).toBe('the grid never rendered');
    // And it is MARKED as recovered, because "it failed and then worked" asks for
    // something different from "it failed" — a section calling both FAILURES with no
    // distinction sends somebody chasing a problem that is already intermittent.
    expect(rows[0]!.recovered).toBe(true);
    expect(renderReportEmailText(inputOf(runOf([failedAttempt, passingRetry])))).toContain(
      'FLAKY — a retry passed',
    );

    // The discriminating half: a test that only ever failed is NOT marked recovered,
    // so the flag is a reading rather than a constant.
    const hard = failureRows(runOf([failedAttempt]));
    expect(hard[0]!.recovered).toBe(false);
  });

  test('B17: the module is the SUITE, not the Playwright project or the spec file', () => {
    // wrong: the first `›` segment, which is what this did. It is correct for a
    // two-segment fixture title and wrong for every real run — a live run.json title
    // starts with the PROJECT, so the module table came out as `chromium` (64 cases)
    // and `live-setup` (2), and the per-execution table had been printing `chromium`
    // in its Module column since it was written. Found by reading a preview of a real
    // run; a project name looks enough like a grouping to survive review.
    //
    // Real titles, copied from a run.json rather than imagined — which is the whole
    // reason the bug existed: the fixtures were tidier than production.
    expect(
      moduleFrom(
        'chromium › apps\\ecom\\smoke.spec.ts › Ecom list pages load @ecom @smoke @readonly › APPM-001 Approval Matrix list page loads',
      ),
      'the project or the tags leaked into the module',
    ).toBe('Ecom list pages load');
    expect(moduleFrom('live-setup › support\\live-setup.ts › the kit has not been modified')).toBe(
      'live-setup',
    );
    // The two-segment shape every other test in this file uses still works, so the
    // fix did not trade one set of titles for another.
    expect(moduleFrom('Products › DEPT-001 list loads')).toBe('Products');
    // And a title with no nesting has no module rather than a guess.
    expect(moduleFrom('a test with no module')).toBeNull();
  });

  test('B16: the plain-text body carries every section, and no live URL', () => {
    // wrong: no text body at all, which is what a watch, a screen reader and a
    // gateway that strips HTML would show. Or a text body built from a SECOND
    // aggregation of the same run — two renderings that disagree on the run where it
    // mattered. It reads the same helpers as the HTML, so this asserts the sections
    // are present and that the URL is reduced to a host like the HTML's is.
    const text = renderReportEmailText(
      inputOf(runOf([resultOf({ id: 't1', title: 'Departments › DEPT-001 list loads' })]), {
        baseUrl: 'https://qa.example.test/admin/domains/Department?id=LEAK',
        includeScreenshots: false,
        trigger: 'jenkins',
      }),
    );
    for (const heading of ['BY MODULE', 'HTTP', 'API CALLS', 'SAFETY', 'SHEET DRIFT']) {
      expect(text, `the text body has no ${heading} section`).toContain(heading);
    }
    expect(text).toContain('Triggered by : jenkins');
    expect(text).toContain('Screenshots not included for this application.');
    expect(text).toContain('built by Hashim Khan');
    // The HOST only — a query string can carry a record id, and this one does.
    expect(text).toContain('qa.example.test');
    expect(text, 'a URL query reached the plain-text body').not.toContain('LEAK');
  });

  test('B18: the API calls section leads with failures and points at the CSV', () => {
    // wrong: a section ordered by call count, where the one endpoint that returned
    // 500 sits below forty static-asset rows — which is the order the data arrives
    // in, so it is what a renderer that does no sorting produces. The fixture
    // discriminates because the failing row has the FEWEST calls: under a count
    // order it would be last, so this cannot pass by accident.
    const run = runOf([resultOf({ id: 't1', title: 'Tax › TAX-001 list loads' })]);
    run.network = {
      totalRequests: 52,
      byStatus: { '200': 51, '500': 1 },
      appByStatus: { '200': 51, '500': 1 },
      thirdPartyByStatus: {},
      appWriteAttempts: 0,
      topFailingEndpoints: [],
      testsReporting: 1,
      endpoints: boundEndpoints(
        summariseEndpoints([
          {
            module: 'Tax',
            requests: [
              ...Array.from({ length: 40 }, () => ({
                method: 'GET',
                path: '/static/app.js',
                status: 200,
                sameOrigin: true,
                durationMs: 5,
              })),
              { method: 'GET', path: '/api/tax/9', status: 500, sameOrigin: true, durationMs: 90 },
            ],
          },
        ]),
      ),
    };

    const html = renderReportEmailHtml(inputOf(run));
    expect(html).toContain('API calls');
    // The failing endpoint's row comes BEFORE the busy one in the document.
    expect(html.indexOf('/api/tax/:id')).toBeGreaterThan(-1);
    expect(html.indexOf('/api/tax/:id')).toBeLessThan(html.indexOf('/static/app.js'));
    // Counts and the status mix are both there, in the agreed shape.
    expect(html).toContain(`500${'×'}1`);
    expect(html).toContain(`200${'×'}40`);
    // The templated id is what travels, never the record's own number.
    expect(html, 'a record id reached the mail').not.toContain('/api/tax/9');

    const text = renderReportEmailText(inputOf(run));
    expect(text).toContain('API CALLS');
    expect(text.indexOf('/api/tax/:id')).toBeLessThan(text.indexOf('/static/app.js'));
    expect(text).not.toContain('/api/tax/9');
  });

  test('B19: a bounded API section says how many it is NOT showing, and where they are', () => {
    // wrong: slicing and stopping. A reader with no "+N more" line believes the
    // table is the whole traffic of the run — and the CSV that has the rest is in
    // the bundle, unmentioned, so nobody opens it. The §AB shape: a number quoted
    // without the assumption it was taken under.
    const run = runOf([resultOf({ id: 't1', title: 'Tax › TAX-001 list loads' })]);
    const many = Array.from({ length: MAX_LISTED_ENDPOINTS + 7 }, (_, index) => ({
      method: 'GET',
      path: `/api/e${index}/x`,
      status: 200,
      sameOrigin: true,
      durationMs: 1,
    }));
    run.network = {
      totalRequests: many.length,
      byStatus: { '200': many.length },
      appByStatus: { '200': many.length },
      thirdPartyByStatus: {},
      appWriteAttempts: 0,
      topFailingEndpoints: [],
      testsReporting: 1,
      endpoints: boundEndpoints(summariseEndpoints([{ module: 'Tax', requests: many }])),
    };

    const html = renderReportEmailHtml(inputOf(run));
    expect(html).toContain('+7 more in api-calls.csv.');
    expect(renderReportEmailText(inputOf(run))).toContain('+7 more in api-calls.csv.');

    // And a run UNDER the cap says nothing of the sort, so the line is a fact about
    // this run rather than boilerplate that is always true.
    const small = runOf([resultOf({ id: 't1', title: 'Tax › TAX-001 list loads' })]);
    small.network = { ...run.network, endpoints: boundEndpoints(summariseEndpoints([])) };
    expect(renderReportEmailHtml(inputOf(small))).not.toContain('more in api-calls.csv');
  });

  test('B20: ABSENT endpoint records are not rendered as "no traffic"', () => {
    // wrong: an empty table, which says the run called nothing. A run with no
    // instrumented test has no endpoint record at all, and the three states — not
    // recorded, recorded and empty, recorded with rows — are three different
    // sentences to a reader deciding whether to go looking for a problem.
    const run = runOf([resultOf({ id: 't1', title: 'Tax › TAX-001 list loads' })]);
    const html = renderReportEmailHtml(inputOf(run));
    expect(html).toContain('No endpoint records in this run');
    expect(renderReportEmailText(inputOf(run))).toContain('No endpoint records in this run');
  });

  test('B1: it contains no construct Outlook silently drops', () => {
    // wrong: a `<style>` block and flexbox tiles — which is exactly what the web
    // renderer has — so the mail arrives unstyled with its summary in a vertical
    // column and nothing says why. These are asserted as ABSENCES because the
    // failure is silent by nature: Word's engine ignores what it cannot handle, it
    // does not complain.
    const html = renderReportEmailHtml(inputOf(runOf([resultOf({ id: 't1', title: 'A › b' })])));
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('display:flex');
    expect(html).not.toContain('display:grid');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('background-image');
    expect(html).not.toContain('prefers-color-scheme');
    // No remote content of any kind: Outlook blocks it by default, so an external
    // image is a broken icon and a web font is simply absent.
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/https?:\/\/(?!qa\.example\.test)/);
    // And it IS laid out with tables, which is the half that makes the above mean
    // something — a document with neither flex nor tables has no layout at all.
    expect(html).toContain('<table role="presentation"');
  });

  test('B2: the header carries application, environment, URL, who ran it, times and verdict', () => {
    // wrong: a body headed only by the run id, which is what the web page did before
    // B7 — two reports in two mails would be indistinguishable, and the one question
    // a manager asks of a test report ("which system, and did it pass?") would need
    // the attachment opened.
    const html = renderReportEmailHtml(inputOf(runOf([resultOf({ id: 't1', title: 'A › b' })])));
    expect(html).toContain('Application');
    expect(html).toContain('<strong>ecom</strong>');
    expect(html).toContain('<strong>qa</strong>');
    /**
     * The HOST, not the URL — and the full URL must be ABSENT.
     *
     * A host tells a reader dev from UAT, which is the question. A path or a query
     * can carry a record id, and a run-sheet URL does. Asserting the absence as well
     * as the presence is what makes this a rule rather than a coincidence of this
     * fixture having no path.
     */
    expect(html).toContain('qa.example.test');
    expect(html).not.toContain('https://qa.example.test');
    expect(html).toContain('me@contoso.com');
    // Both zones, from the recorded instant — the UTC half is the instant itself.
    expect(html).toContain('2026-11-10T09:00:01.000Z');
    expect(html).toContain('where the run happened');
    expect(html).toContain('2026-11-10T09:02:11.000Z');
    expect(html).toContain('2m 10s');
    expect(html).toContain('PASSED');
    // And the new sections are all there, in the order the brief asks for.
    const order = ['By module', 'HTTP', 'Write attempts to the application', 'Sheet drift'];
    const positions = order.map((heading) => html.indexOf(heading));
    expect(
      positions.every((at) => at >= 0),
      `a section is missing: ${order}`,
    ).toBe(true);
    expect(positions, 'the sections are out of order').toEqual(
      [...positions].sort((a, b) => a - b),
    );
    expect(html).toContain('built by Hashim Khan');
  });

  test('B3: a failing run is headed FAILED even when run.status disagrees', () => {
    // wrong: trusting `run.status` alone. A Playwright run that is `interrupted`
    // with failures recorded, or a status written by a producer that counted
    // differently, would head a mail with a word the counts contradict — and the
    // counts are the thing a reader believes. The verdict is derived from
    // `summary.failed`, so the headline cannot disagree with the table below it.
    const failing = runOf(
      [resultOf({ id: 't1', title: 'A › b', outcome: TestOutcome.Failed })],
      RunStatus.Passed,
    );
    expect(verdictOf(failing)).toBe('FAILED');
    expect(renderReportEmailHtml(inputOf(failing))).toContain('FAILED');
  });

  test('B4: the table has one row per EXECUTION, retries included and labelled', () => {
    // wrong: one row per distinct test, which is what the summary counts — so a test
    // that failed twice and passed on the third attempt would show as a single pass
    // and the two failures would be invisible. The brief asks for every execution,
    // and the discriminating fixture is a retried test: with per-test rows this
    // renders two rows instead of three.
    const html = renderReportEmailHtml(
      inputOf(
        runOf([
          resultOf({
            id: 't1',
            title: 'Departments › DEPT-001 list loads',
            outcome: TestOutcome.Failed,
          }),
          resultOf({ id: 't1', title: 'Departments › DEPT-001 list loads', retry: 1 }),
          resultOf({ id: 't2', title: 'Departments › DEPT-002 create' }),
        ]),
      ),
    );
    expect(html).toContain('Every execution (3)');
    expect(html).toContain('(retry 1)');
    // And it says the counts are per test, so the two numbers differing is explained
    // rather than looking like an error.
    expect(html).toContain('The counts above are per TEST');
  });

  test('B5: the case id, the name and the module are separated from the title', () => {
    // wrong: the whole Playwright title in one column — `Departments › DEPT-001 the
    // list loads` — so the QA's own id cannot be scanned down a column and the module
    // is repeated on every row inside the test name. The id is the thing a QA matches
    // against their sheet, which is the entire reason it gets a column.
    expect(testCaseIdFrom('DEPT-001 the list loads')).toBe('DEPT-001');
    expect(testNameFrom('Departments › DEPT-001 the list loads')).toBe('the list loads');
    expect(moduleFrom('Departments › DEPT-001 the list loads')).toBe('Departments');

    const html = renderReportEmailHtml(
      inputOf(runOf([resultOf({ id: 't1', title: 'Departments › DEPT-001 the list loads' })])),
    );
    expect(html).toContain('>DEPT-001<');
    expect(html).toContain('the list loads');
    expect(html).toContain('>Departments<');
  });

  test('B6: a title with NO case id and NO module renders a dash, never a guess', () => {
    // wrong: an empty cell, which reads as data that went missing; or worse, the
    // test's own name repeated as its module, which reads as information. This is the
    // discriminating half of B5 — a renderer that always found an id would pass B5
    // and invent one here.
    expect(testCaseIdFrom('the list loads')).toBeNull();
    expect(moduleFrom('a flat test with no describe')).toBeNull();
    const html = renderReportEmailHtml(
      inputOf(runOf([resultOf({ id: 't1', title: 'a flat test with no describe' })])),
    );
    expect(html).toContain('—');
    expect(html).not.toContain('>a flat test with no describe<\n        </td>\n        <td');
  });

  test('B7: a failure shows its error line and the existing RCA one-liner', () => {
    // wrong: the status word alone, so a reader has to open the attachment to learn
    // anything at all — which is the whole reason these mails get ignored. The RCA is
    // the one already in run.json; nothing is generated here, and a low-confidence
    // verdict is LABELLED so nobody files a bug on a coin flip.
    const html = renderReportEmailHtml(
      inputOf(
        runOf([
          resultOf({
            id: 't1',
            title: 'Departments › DEPT-001 list loads',
            outcome: TestOutcome.Failed,
            error: {
              message: 'expect(locator).toBeVisible() failed\n\nLocator: getByRole("grid")\n  …',
              rca: {
                category: FailureCategory.ApplicationBug,
                rootCause: 'The grid never renders because the list API returns 500.',
                confidence: 0.4,
                evidence: [],
                analyzedBy: 'claude',
                analyzedAt: '2026-11-10T09:03:00.000Z',
              },
            },
          }),
        ]),
      ),
    );
    expect(html).toContain('expect(locator).toBeVisible() failed');
    // The FIRST line only — a 40-line stack in an email body is why nobody reads one.
    expect(html).not.toContain('Locator: getByRole');
    expect(html).toContain('application-bug');
    expect(html).toContain('The grid never renders');
    expect(html).toContain('(low confidence)');
  });

  test('B8: the comparison lists new failures, fixed and still failing — and says when it cannot', () => {
    // wrong: omitting the section when there is no previous run, which reads as
    // "nothing changed" — a claim, where "there is nothing to compare against" is the
    // fact. Both are rendered here, because the absent-section version passes any
    // test that only looks at the populated one.
    const first = describeRunForHistory(
      runOf([
        resultOf({ id: 'a', title: 'A › keeps failing', outcome: TestOutcome.Failed }),
        resultOf({ id: 'b', title: 'A › gets fixed', outcome: TestOutcome.Failed }),
        resultOf({ id: 'c', title: 'A › breaks next time' }),
        resultOf({ id: 'd', title: 'A › is deleted' }),
      ]),
      'ecom',
      'qa',
    );
    const second = describeRunForHistory(
      runOf([
        resultOf({ id: 'a', title: 'A › keeps failing', outcome: TestOutcome.Failed }),
        resultOf({ id: 'b', title: 'A › gets fixed' }),
        resultOf({ id: 'c', title: 'A › breaks next time', outcome: TestOutcome.Failed }),
        resultOf({ id: 'e', title: 'A › is brand new' }),
      ]),
      'ecom',
      'qa',
    );
    const comparison = compareRuns(first, second);
    expect(comparison.newFailures.map((t) => t.id)).toEqual(['c']);
    expect(comparison.fixed.map((t) => t.id)).toEqual(['b']);
    expect(comparison.stillFailing.map((t) => t.id)).toEqual(['a']);
    // ADDED and REMOVED are their own lists: a brand-new failing test reported as a
    // "new failure" tells a reader something REGRESSED, and a deleted failing test
    // reported as "fixed" tells them it was repaired. Both are confident and wrong.
    expect(comparison.added.map((t) => t.id)).toEqual(['e']);
    expect(comparison.removed.map((t) => t.id)).toEqual(['d']);

    const withComparison = renderReportEmailHtml(
      inputOf(runOf([resultOf({ id: 'a', title: 'A › b' })]), { comparison }),
    );
    expect(withComparison).toContain('New failures (1)');
    expect(withComparison).toContain('Fixed (1)');
    expect(withComparison).toContain('Still failing (1)');

    const withoutComparison = renderReportEmailHtml(
      inputOf(runOf([resultOf({ id: 'a', title: 'A › b' })])),
    );
    expect(withoutComparison).toContain('No previous run recorded');
    expect(withoutComparison).not.toContain('New failures');
  });

  test('B9: a planted SENTINEL secret reaches neither the body nor the zip', () => {
    // wrong: either one carrying it. The two have different protections and both are
    // planted here, because a test of one proves nothing about the other: the body's
    // protection is that it reads no environment at all (B10 asserts that as a scan),
    // and the bundle's is its ALLOWLIST — nothing travels unless a rule names it. So
    // the sentinel goes in BOTH an env var and a real `.env` file inside the
    // directory being bundled.
    const SENTINEL = 'sentinel-6f2a9c4e-do-not-ship';
    const previous = process.env.AITP_SENTINEL_SECRET;
    process.env.AITP_SENTINEL_SECRET = SENTINEL;
    try {
      const body = renderReportEmailHtml(
        inputOf(runOf([resultOf({ id: 't1', title: 'Departments › DEPT-001 list loads' })])),
      );
      expect(body).not.toContain(SENTINEL);
      // §T — the sentinel has to be findable at all, or "not present" is vacuous.
      expect(process.env.AITP_SENTINEL_SECRET).toBe(SENTINEL);

      const reportDir = mkdtempSync(path.join(tmpdir(), 'aitp-sentinel-'));
      // An ALLOWED file, so the bundle is not empty. `index.html` used to serve here
      // and no longer can: the Playwright report is off the allowlist.
      writeFileSync(path.join(reportDir, 'run.json'), '{"id":"run_sentinel"}', 'utf8');
      writeFileSync(path.join(reportDir, '.env'), `SECRET=${SENTINEL}\n`, 'utf8');
      mkdirSync(path.join(reportDir, 'auth'), { recursive: true });
      writeFileSync(path.join(reportDir, 'auth', 'qa.json'), `{"token":"${SENTINEL}"}`, 'utf8');

      const zipped = zipDirectory(reportDir);
      // The BYTES, not the entry names: a file excluded by name but still deflated
      // into the archive would pass a name check and ship the secret.
      expect(zipped.bytes.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false);
      // And the allowed file DID make it in, which is what stops this passing over a
      // bundle that excluded everything — the shape an allowlist fails into.
      expect(zipped.entryCount).toBe(1);
      expect(zipped.excluded.map((entry) => entry.name).sort()).toEqual(['.env', 'auth/qa.json']);
    } finally {
      if (previous === undefined) delete process.env.AITP_SENTINEL_SECRET;
      else process.env.AITP_SENTINEL_SECRET = previous;
    }
  });

  test('B10: the body renderer reads no environment, no disk and no clock', () => {
    // wrong: B9 proves the sentinel is absent from ONE rendering of ONE input. It
    // cannot prove the renderer has no ROUTE to the environment — a body that printed
    // `process.env.USERNAME` would pass B9 and leak a different variable tomorrow. So
    // the property is asserted about the code: there is no route, which is also what
    // makes the renderer deterministic enough to diff.
    const source = stripComments(
      readFileSync(
        path.join(ROOT, 'packages', 'reporting-engine', 'src', 'notify', 'body.ts'),
        'utf8',
      ),
    );
    expect(source.length, 'the scan read nothing').toBeGreaterThan(500);
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('readFileSync');
    expect(source).not.toContain('Date.now');

    /**
     * READING THE CLOCK, not using the Date type.
     *
     * This was `not.toContain('new Date')`, and it failed the moment the body learned
     * to print a start time in local and UTC — because formatting a RECORDED instant
     * needs `new Date(iso)`. The pattern was too coarse: it banned the type rather
     * than the clock, and the two are not the same thing.
     *
     * `new Date()` with no argument is the clock. `new Date(run.startedAt)` is
     * arithmetic on a value the run already carries, and it keeps the property B10
     * exists for — the same input renders the same body, forever, so a diff of two
     * renderings means something.
     *
     * Narrowing a guard is the move that hides a real problem, so the narrower
     * pattern is asserted to still CATCH the thing it is about, on synthetic source.
     */
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect('const now = new Date();', 'the narrowed pattern no longer catches the clock').toMatch(
      /new Date\(\s*\)/,
    );
    expect(
      'new Date(run.startedAt)',
      'the narrowed pattern rejects a recorded instant',
    ).not.toMatch(/new Date\(\s*\)/);
  });

  test('B11: history records are newest-first, and a run is never compared with itself', () => {
    // wrong: comparing a run against itself, which the drop's ordering makes the
    // DEFAULT mistake — the record is written before the body is rendered, so the
    // newest record IS this run. Every run would then report "no change", forever, and
    // the result looks entirely plausible.
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'aitp-hist-')), 'runs');
    const base = describeRunForHistory(
      runOf([resultOf({ id: 'a', title: 'A › b' })]),
      'ecom',
      'qa',
    );
    const older = { ...base, runId: 'run_older', finishedAt: '2026-11-10T08:00:00.000Z' };
    const current = { ...base, runId: 'run_current', finishedAt: '2026-11-10T09:00:00.000Z' };
    recordRun(dir, older);
    recordRun(dir, current);

    expect(previousRunRecord(dir, current)?.runId).toBe('run_older');

    // THE ORDER IS BOUNDED, not merely de-duplicated. Asked about the OLDER run, a
    // "newest record that is not me" implementation hands back the LATER one — so a
    // comparison would report a fix as a regression and a regression as a fix, both
    // lists confidently populated. The first draft did exactly that, and was right
    // only because the caller happens to always be the newest run.
    expect(previousRunRecord(dir, older)).toBeNull();

    // And a run's own record never becomes its own previous run, which is the
    // default mistake: the record is written BEFORE the body is rendered.
    const onlyDir = path.join(mkdtempSync(path.join(tmpdir(), 'aitp-hist1-')), 'runs');
    recordRun(onlyDir, current);
    expect(previousRunRecord(onlyDir, current)).toBeNull();
  });

  test('B12: the attachment line says which of the three states this run is in', () => {
    // wrong: claiming an attachment that a size limit dropped. A manager clicking a
    // paperclip that is not there is the specific failure the 10 MB check exists for,
    // so the three cases get three sentences rather than one hedge.
    const run = runOf([resultOf({ id: 't1', title: 'A › b' })]);
    expect(renderReportEmailHtml(inputOf(run, { reportZipName: 'r.zip' }))).toContain(
      'attached as <strong>r.zip</strong>',
    );
    expect(
      renderReportEmailHtml(inputOf(run, { reportZipName: 'r.zip', reportZipTooLarge: true })),
    ).toContain('not attached');
    expect(renderReportEmailHtml(inputOf(run))).toContain('No report archive was attached');
  });

  test('B13: HTML in a test title is escaped, not rendered', () => {
    // wrong: a test named `<img src=x onerror=...>` becomes markup in a mail sent to
    // a manager. Test titles come from a repo and error messages from an application
    // under test, so neither is trusted input to a document.
    const html = renderReportEmailHtml(
      inputOf(
        runOf([
          resultOf({
            id: 't1',
            title: 'A › <img src=x onerror="alert(1)">',
            outcome: TestOutcome.Failed,
            error: { message: '<script>alert(2)</script>' },
          }),
        ]),
      ),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;script&gt;alert(2)');
  });

  test('B14: errorHeadline takes the first NON-EMPTY line and bounds its length', () => {
    // wrong: taking `split('\n')[0]`, which is the empty string for the many
    // Playwright messages that begin with a blank line — so the one line a reader
    // scans for would be missing exactly when there is an error to read.
    expect(errorHeadline('\n\nexpect(received).toBe(expected)\n  at foo')).toBe(
      'expect(received).toBe(expected)',
    );
    expect(errorHeadline(undefined)).toBeNull();
    expect(errorHeadline('   \n  ')).toBeNull();
    // BOUNDED AND MARKED, asserted as the property rather than the arithmetic: the
    // first draft said 300 and the answer is 298 (297 characters plus the ellipsis),
    // which is a fact about the slice and not about the requirement. A length
    // assertion that has to be recomputed whenever the limit moves is a test of the
    // constant.
    const long = errorHeadline('x'.repeat(400))!;
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith('…')).toBe(true);
    // And a line UNDER the limit is not truncated, or the bound could be anything.
    expect(errorHeadline('x'.repeat(50))).toBe('x'.repeat(50));
  });
});
