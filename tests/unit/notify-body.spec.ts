import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  FailureCategory,
  RunStatus,
  TestOutcome,
  describeTarget,
  emptySummary,
  findRepoRoot,
  type Run,
  type TestResult,
} from '@aitp/shared';
import {
  compareRuns,
  describeRunForHistory,
  errorHeadline,
  moduleFrom,
  previousRunRecord,
  recordRun,
  renderReportEmailHtml,
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
    expect(html).toContain('https://qa.example.test');
    expect(html).toContain('me@contoso.com');
    expect(html).toContain('2026-11-10T09:00:01.000Z');
    expect(html).toContain('2026-11-10T09:02:11.000Z');
    expect(html).toContain('2m 10s');
    expect(html).toContain('PASSED');
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
    // and the zip's is its exclusion denylist. A denylist is only as good as the
    // shapes somebody thought of, so the sentinel goes in BOTH an env var and a real
    // `.env` file inside the directory being archived.
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
      writeFileSync(path.join(reportDir, 'index.html'), '<p>a real report file</p>', 'utf8');
      writeFileSync(path.join(reportDir, '.env'), `SECRET=${SENTINEL}\n`, 'utf8');
      mkdirSync(path.join(reportDir, 'auth'), { recursive: true });
      writeFileSync(path.join(reportDir, 'auth', 'qa.json'), `{"token":"${SENTINEL}"}`, 'utf8');

      const zipped = zipDirectory(reportDir);
      // The BYTES, not the entry names: a file excluded by name but still deflated
      // into the archive would pass a name check and ship the secret.
      expect(zipped.bytes.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false);
      // And the real file DID make it in, which is what stops this passing over an
      // archive that excluded everything.
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
    expect(source).not.toContain('new Date');
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
