import { TestOutcome, formatStatusCounts, type Run, type TestResult } from '@aitp/shared';
import type { RunComparison } from './history';

/**
 * THE EMAIL BODY: one self-contained static HTML document, for Outlook.
 *
 * ## Why this is not `renderRunSummaryHtml`
 *
 * That renderer is a web page. It uses a `<style>` block, flexbox tiles, CSS custom
 * properties and `prefers-color-scheme` — every one of which Outlook for Windows
 * silently drops, because it renders mail through Word's engine rather than a
 * browser's. The page would arrive as an unstyled stack of text with the summary
 * tiles in a vertical column, and nobody would know why.
 *
 * So this is a second renderer rather than a parameter on the first, and the
 * constraints are listed rather than remembered:
 *
 * - **Inline `style` attributes on every element.** No `<style>` block and no
 *   `class` selectors: Word's engine supports neither reliably, and a class that
 *   does nothing is invisible until the mail is opened.
 * - **Tables for layout.** Not flex, not grid — both are ignored, and an ignored
 *   `display:flex` leaves its children stacked with no indication.
 * - **No JavaScript, no external images, no web fonts, no `background-image`.**
 *   Outlook blocks remote content by default, so an external image is a broken icon
 *   and a background colour carried by an image is simply absent. Every colour here
 *   is a `bgcolor` attribute or an inline `background-color`.
 * - **`px`, never `rem` or `em`** for anything structural.
 * - **Colour is never the only signal.** A status is also a word, because Word's
 *   engine and a high-contrast theme can both drop the colour.
 *
 * ## It reads `run` and nothing else
 *
 * No `process.env`, no filesystem, no clock. Everything it prints is passed in,
 * which is what lets the sentinel test assert that no environment value can reach
 * the body: there is no route from one to the other. `tests/unit/notify-body.spec.ts`
 * asserts that structurally as well as by planting a sentinel, because "it does not
 * read the environment" is a claim about code and the scan is what checks it.
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * The QA's own test-case id, when the title carries one.
 *
 * Matched as a LEADING token only — `DEPT-001 the department list loads` — and
 * anchored, so a sentence that happens to contain a code later on does not have one
 * extracted from the middle. The pattern is the shape both sheets use: letters, then
 * a hyphen or underscore, then digits.
 *
 * Returns `null` rather than `''` when there is none: an id the sheet never carried
 * and an id that could not be parsed are both "no id", but a column of empty strings
 * looks like data that went missing. The table prints an em dash, which does not.
 */
export function testCaseIdFrom(title: string): string | null {
  const match = /^\s*([A-Z][A-Z0-9]*[-_]\d+)\b/.exec(title);
  return match ? match[1]! : null;
}

/**
 * The module, from Playwright's own describe nesting.
 *
 * Playwright joins describe titles with `›`, so the first segment of a nested title
 * is the module. A title with no `›` has no module — that is a flat test, and `null`
 * says so instead of repeating the test's own name as its module, which would read
 * as information.
 */
export function moduleFrom(title: string): string | null {
  /**
   * THE SUITE, not the project and not the spec file.
   *
   * This took the FIRST `›` segment, which is right for a two-segment title like
   * `Products › DEPT-001 list loads` and wrong for every real run. A `run.json`
   * title from a live run is:
   *
   *     chromium › apps\ecom\smoke.spec.ts › Ecom list pages load @ecom @smoke › APPM-001 …
   *
   * so the first segment is the PLAYWRIGHT PROJECT. Measured 2026-11-24 by reading
   * a preview of a real run: the module table came out with two rows, `chromium`
   * (64 cases) and `live-setup` (2), and the existing per-execution table had been
   * printing `chromium` in its Module column for every live row since it was
   * written. Both were wrong in a way that reads as plausible — a project name looks
   * like a grouping.
   *
   * The segment taken is the LAST ONE BEFORE THE TEST'S OWN NAME, which is the
   * innermost `describe`. Tags are stripped: a suite title carries `@ecom @smoke
   * @readonly` and those are selectors, not part of a name a reader wants.
   *
   * A spec-file segment is skipped by shape — it ends in `.spec.ts` — rather than by
   * position, because the nesting depth differs between a live run, a demo run and a
   * synthetic fixture, and keying on position would make this right for one of them.
   */
  const segments = title
    .split('›')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  if (segments.length < 2) return null;

  // Everything except the test's own name, minus the file.
  const containers = segments
    .slice(0, -1)
    .filter((segment) => !/\.spec\.ts$/i.test(segment) && !/\.ts$/i.test(segment));
  if (containers.length === 0) return null;

  // The INNERMOST container, with tags removed.
  const module = containers[containers.length - 1]!.replace(/\s*@[\w-]+/g, '').trim();
  return module === '' ? null : module;
}

/**
 * The last `›` segment of a title — the test's own name, before the id is stripped.
 *
 * Exists because the id and the name are extracted from the SAME segment, and the
 * first draft composed them the wrong way round: it asked `testCaseIdFrom` for an id
 * in `testNameFrom`'s output, which has already had the id removed. Every case id
 * came back `null` and the column rendered an em dash for a sheet full of them —
 * caught by the test, not by reading it, because both functions were individually
 * correct.
 */
function lastSegment(title: string): string {
  const index = title.lastIndexOf('›');
  return (index < 0 ? title : title.slice(index + 1)).trim();
}

/** The QA's own id for this test, wherever the describe nesting put it. */
export function caseIdOf(title: string): string | null {
  return testCaseIdFrom(lastSegment(title)) ?? testCaseIdFrom(title);
}

/** The part of the title that is the test's own name, without module or case id. */
export function testNameFrom(title: string): string {
  const name = lastSegment(title);
  // The case id is shown in its own column, so it is not repeated in the name.
  const caseId = testCaseIdFrom(name);
  return caseId ? name.slice(caseId.length).trim() : name;
}

/** The first line of an error message — what a reader scans for. */
export function errorHeadline(message: string | undefined): string | null {
  if (!message) return null;
  const line = message
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  if (!line) return null;
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

interface StatusStyle {
  label: string;
  colour: string;
  background: string;
}

/** Colour AND a word, because colour alone does not survive every mail client. */
function statusStyle(outcome: TestOutcome): StatusStyle {
  switch (outcome) {
    case TestOutcome.Passed:
      return { label: 'Passed', colour: '#0b6b45', background: '#e7f5ee' };
    case TestOutcome.Skipped:
      return { label: 'Skipped', colour: '#4b5563', background: '#f1f2f4' };
    case TestOutcome.Flaky:
      return { label: 'Flaky', colour: '#8a4b08', background: '#fdf3e7' };
    case TestOutcome.TimedOut:
      return { label: 'Timed out', colour: '#a21b1b', background: '#fdecec' };
    default:
      return { label: 'Failed', colour: '#a21b1b', background: '#fdecec' };
  }
}

const FONT = 'font-family:Segoe UI,Arial,Helvetica,sans-serif';
const CELL = `${FONT};font-size:13px;color:#1f2328;padding:7px 10px;border-bottom:1px solid #e3e5e8;vertical-align:top`;
const HEAD = `${FONT};font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#5b6370;padding:7px 10px;border-bottom:2px solid #d4d7db;text-align:left`;

/** How many failures the mail lists before it says "+N more". */
export const MAX_LISTED_FAILURES = 10;

/** What started the run. Resolved by the caller from its own argv/environment (§AJ). */
export type RunTrigger = 'manual' | 'jenkins';

/**
 * The HOST of a URL, never the path or the query.
 *
 * The mail names the environment it ran against so a reader can tell dev from UAT,
 * and a host does that. A full URL would carry a path, and a path on this
 * application is `/admin/domains/<Entity>` — schema, harmless — but a run-sheet URL
 * can carry a query, and a query can carry a record id. The host is the part that
 * answers the question being asked.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // NOT the raw string as a fallback: a value that failed to parse as a URL is
    // exactly the one that might not be a URL at all.
    return '(unparseable)';
  }
}

/** One module's roll-up, for section (c). */
export interface ModuleRow {
  module: string;
  cases: number;
  passed: number;
  failed: number;
  flaky: number;
  durationMs: number;
}

/**
 * Per-module totals, DISTINCT TESTS not attempts, worst first.
 *
 * Distinct tests because the numbers have to add up to the summary a reader just
 * saw two inches higher: one row per attempt would make a retried test count twice
 * and the module table's total would exceed the run's. The final attempt decides a
 * test's outcome, which is the same rule `finalAttemptPerTest` applies to the
 * archive, and duration is SUMMED across attempts because that is the time the run
 * actually spent.
 *
 * A test whose title carries no module goes under `(no module)` rather than being
 * dropped — a table whose rows do not sum to the total is worse than one with an
 * untidy row in it.
 */
export function moduleRows(run: Run): ModuleRow[] {
  const byTest = new Map<string, { outcome: string; module: string; durationMs: number }>();
  for (const result of run.results) {
    const existing = byTest.get(result.id);
    byTest.set(result.id, {
      // The LAST attempt seen decides, because `run.results` is in attempt order.
      outcome: result.outcome,
      module: moduleFrom(result.title) ?? '(no module)',
      durationMs: (existing?.durationMs ?? 0) + result.durationMs,
    });
  }

  const rows = new Map<string, ModuleRow>();
  for (const test of byTest.values()) {
    const row =
      rows.get(test.module) ??
      ({
        module: test.module,
        cases: 0,
        passed: 0,
        failed: 0,
        flaky: 0,
        durationMs: 0,
      } as ModuleRow);
    row.cases += 1;
    row.durationMs += test.durationMs;
    if (test.outcome === TestOutcome.Passed) row.passed += 1;
    else if (test.outcome === TestOutcome.Failed) row.failed += 1;
    else if (test.outcome === TestOutcome.Flaky) row.flaky += 1;
    rows.set(test.module, row);
  }

  return [...rows.values()].sort(
    (a, b) => b.failed - a.failed || b.flaky - a.flaky || a.module.localeCompare(b.module),
  );
}

/** A failed or flaky test, with the error from the attempt that actually failed. */
export interface FailureRow {
  result: TestResult;
  /** `true` when a later attempt passed — the test is unreliable, not broken. */
  recovered: boolean;
  /** From the FAILING attempt, which is not always the one that decided the outcome. */
  error: TestResult['error'];
}

/**
 * Distinct tests that failed or flaked, worst first, each with its real error.
 *
 * ## The error comes from the attempt that FAILED
 *
 * Found by reading a preview rather than by reasoning: a flaky test was listed under
 * "Failures" showing `(no error message recorded)`, because the outcome is decided by
 * the LAST attempt and the last attempt passed. The one piece of information a reader
 * opens this section for lived on an earlier row of `run.results` and was being
 * thrown away.
 *
 * So the error is taken from the first attempt that has one, and a test that later
 * passed is marked `recovered` — "it failed and then worked" is a different thing to
 * act on from "it failed", and a section that calls both FAILURES with no
 * distinction invites somebody to chase a problem that is already intermittent.
 *
 * A test that ended PASSED with no retry is not here at all; `flaky` is how
 * Playwright reports a retried failure, so keying on that avoids double-listing.
 */
export function failureRows(run: Run): FailureRow[] {
  const byTest = new Map<string, FailureRow>();
  for (const result of run.results) {
    const existing = byTest.get(result.id);
    const failedNow = result.outcome === TestOutcome.Failed || result.outcome === TestOutcome.Flaky;

    if (!failedNow && result.outcome === TestOutcome.Passed && !existing) continue;
    if (!failedNow && !existing) continue;

    byTest.set(result.id, {
      result: failedNow ? result : (existing?.result ?? result),
      recovered: result.outcome === TestOutcome.Flaky || result.outcome === TestOutcome.Passed,
      // The FIRST error seen wins: later attempts of a flaky test have none.
      error: existing?.error ?? result.error,
    });
  }

  return [...byTest.values()].sort(
    (a, b) =>
      Number(a.recovered) - Number(b.recovered) || a.result.title.localeCompare(b.result.title),
  );
}

/** How many times this run had to sign in again mid-test. */
export function reLoginCount(run: Run): number {
  return run.results.reduce(
    (total, result) =>
      total + (result.annotations ?? []).filter((note) => note.type === 're-login').length,
    0,
  );
}

export interface ReportEmailInput {
  run: Run;
  /** The application slug. Passed in from the resolved target, never inferred here. */
  application: string;
  environment: string;
  /** The resolved URL this run actually ran against. */
  baseUrl: string;
  /** Who the mail says it is from. */
  ranBy: string;
  /**
   * What started this run, resolved by the caller.
   *
   * Not read here, and not guessed: a body that inspected `process.env.JENKINS_URL`
   * would be reading the environment in the one renderer whose whole guarantee is
   * that it cannot (B10 asserts that as a source scan).
   */
  trigger?: RunTrigger | undefined;
  /**
   * Whether failure screenshots are in this run's bundle.
   *
   * The mail SAYS when they are not, rather than quietly shipping without them: a
   * reader who expects a picture and finds none should learn that it is policy for
   * this application and not a fault in the run.
   */
  includeScreenshots?: boolean | undefined;
  /** `null` when this is the first recorded run for the application. */
  comparison: RunComparison | null;
  /** Named so the body can say what is attached — or that nothing is. */
  reportZipName?: string | undefined;
  reportZipTooLarge?: boolean | undefined;
}

/**
 * The verdict, in three states rather than two.
 *
 * `PASSED WITH FLAKY` exists because the two it sits between are both wrong for a
 * run that ended green after a retry. `PASSED` hides that something is unreliable,
 * and the flake is the thing most worth acting on while it is still cheap; `FAILED`
 * says the application is broken when the suite decided it is not, which trains
 * somebody to ignore a red subject line.
 */
export function verdictOf(run: Run): string {
  const failed = run.summary?.failed ?? 0;
  if (failed > 0) return 'FAILED';
  const flaky = run.summary?.flaky ?? 0;
  if (run.status === 'passed') return flaky > 0 ? 'PASSED WITH FLAKY' : 'PASSED';
  return run.status.toUpperCase();
}

/**
 * The start time in BOTH the reader's local zone and UTC.
 *
 * `run.startedAt` is an ISO instant, which is unambiguous and which nobody reads as
 * a time of day. A Dubai reader seeing `09:02Z` has to do arithmetic to know whether
 * that was before or after they went home, and a reader in another zone does
 * different arithmetic — so both are printed and each is labelled.
 *
 * The LOCAL zone is the one this process is in, which is the machine that ran the
 * tests rather than the machine that opens the mail. That is the honest reading and
 * it is labelled as such: a mail cannot know where it will be read.
 *
 * No clock is consulted — only the instant already recorded on the run (B10).
 */
export function startedLine(run: Run): string {
  const iso = run.startedAt ?? run.createdAt;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return `${iso} (unparseable)`;
  const local = at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${local} (${offset}, where the run happened) · ${at.toISOString()}`;
}

function headerRow(label: string, value: string): string {
  return `<tr>
    <td style="${FONT};font-size:12px;color:#5b6370;padding:3px 14px 3px 0;white-space:nowrap">${escapeHtml(label)}</td>
    <td style="${FONT};font-size:13px;color:#1f2328;padding:3px 0">${value}</td>
  </tr>`;
}

function countTile(label: string, value: number, colour: string): string {
  return `<td bgcolor="#ffffff" style="border:1px solid #e3e5e8;padding:10px 16px" align="center">
    <div style="${FONT};font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#5b6370">${escapeHtml(label)}</div>
    <div style="${FONT};font-size:22px;font-weight:700;color:${colour};padding-top:2px">${value}</div>
  </td>`;
}

function comparisonList(title: string, tests: RunComparison['fixed'], colour: string): string {
  if (tests.length === 0) return '';
  const items = tests
    .map(
      (test) =>
        `<li style="${FONT};font-size:13px;color:#1f2328;padding-bottom:3px">${escapeHtml(test.title)}</li>`,
    )
    .join('');
  return `<tr><td style="padding:8px 0 0">
    <div style="${FONT};font-size:13px;font-weight:700;color:${colour};padding-bottom:4px">${escapeHtml(title)} (${tests.length})</div>
    <ul style="margin:0 0 6px;padding-left:20px">${items}</ul>
  </td></tr>`;
}

export function renderReportEmailHtml(input: ReportEmailInput): string {
  const { run } = input;
  const summary = run.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
    passRate: 0,
  };
  const verdict = verdictOf(run);
  /**
   * THREE colours for three verdicts, and amber is not a decoration.
   *
   * `verdict === 'PASSED' ? green : red` was correct while there were two verdicts
   * and became wrong the moment `PASSED WITH FLAKY` existed — it would have painted
   * a green run red. Colour is never the only signal here (the word is always
   * there), which is why this is a presentation fix and not a correctness one, but a
   * red banner over a passing run is its own kind of wrong.
   */
  const verdictColour =
    summary.failed > 0 ? '#a21b1b' : verdict === 'PASSED' ? '#0b6b45' : '#8a4b08';

  /**
   * EVERY execution, including retries — not one row per distinct test.
   *
   * The summary counts distinct tests (a retried test decided once), and this table
   * is explicitly "every execution" so a reader can see that a test failed twice and
   * passed on the third attempt. The two numbers therefore differ on a retried run,
   * which is why the table says how many rows it has next to how many tests ran.
   */
  const rows = run.results
    .map((result: TestResult) => {
      const style = statusStyle(result.outcome);
      const caseId = caseIdOf(result.title);
      const module = moduleFrom(result.title);
      const headline = errorHeadline(result.error?.message);
      const rca = result.error?.rca;
      const detail =
        headline || rca
          ? `<tr><td colspan="5" style="${FONT};font-size:12px;padding:0 10px 9px;border-bottom:1px solid #e3e5e8">
              ${
                headline
                  ? `<div style="font-family:Consolas,Courier New,monospace;font-size:12px;color:#a21b1b;background-color:#fdecec;padding:7px 9px">${escapeHtml(headline)}</div>`
                  : ''
              }
              ${
                rca
                  ? `<div style="${FONT};font-size:12px;color:#1f2328;background-color:#eef3fc;padding:7px 9px;margin-top:4px">
                      <strong>${escapeHtml(rca.category)}</strong>${
                        rca.confidence < 0.5 ? ' (low confidence)' : ''
                      } — ${escapeHtml(errorHeadline(rca.rootCause) ?? '')}
                    </div>`
                  : ''
              }
            </td></tr>`
          : '';
      return `<tr>
        <td style="${CELL};white-space:nowrap"><span style="background-color:${style.background};color:${style.colour};font-weight:700;font-size:11px;padding:2px 7px">${escapeHtml(style.label)}</span></td>
        <td style="${CELL};white-space:nowrap;font-family:Consolas,Courier New,monospace">${caseId ? escapeHtml(caseId) : '—'}</td>
        <td style="${CELL}">${escapeHtml(testNameFrom(result.title))}${
          result.retry > 0
            ? ` <span style="color:#8a4b08;font-size:11px">(retry ${result.retry})</span>`
            : ''
        }</td>
        <td style="${CELL}">${module ? escapeHtml(module) : '—'}</td>
        <td style="${CELL};text-align:right;white-space:nowrap">${formatDuration(result.durationMs)}</td>
      </tr>${detail}`;
    })
    .join('\n');

  const comparison = input.comparison;
  const comparisonBlock = comparison
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:26px">
        <tr><td style="${FONT};font-size:15px;font-weight:700;color:#1f2328;padding-bottom:2px">Since the previous run</td></tr>
        <tr><td style="${FONT};font-size:12px;color:#5b6370;padding-bottom:6px">run ${escapeHtml(comparison.previousRunId)}, finished ${escapeHtml(comparison.previousFinishedAt)}</td></tr>
        ${comparisonList('New failures', comparison.newFailures, '#a21b1b')}
        ${comparisonList('Fixed', comparison.fixed, '#0b6b45')}
        ${comparisonList('Still failing', comparison.stillFailing, '#8a4b08')}
        ${comparisonList('Added to the suite', comparison.added, '#4b5563')}
        ${comparisonList('No longer in the suite', comparison.removed, '#4b5563')}
        ${
          comparison.newFailures.length === 0 &&
          comparison.fixed.length === 0 &&
          comparison.stillFailing.length === 0 &&
          comparison.added.length === 0 &&
          comparison.removed.length === 0
            ? `<tr><td style="${FONT};font-size:13px;color:#1f2328">No change: every test ended the same way it did last run.</td></tr>`
            : ''
        }
      </table>`
    : // SAID, not omitted. An absent section reads as "nothing changed", which is a
      // claim; "there is nothing to compare against" is the fact.
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:26px">
        <tr><td style="${FONT};font-size:15px;font-weight:700;color:#1f2328;padding-bottom:2px">Since the previous run</td></tr>
        <tr><td style="${FONT};font-size:13px;color:#5b6370">No previous run recorded for <strong>${escapeHtml(input.application)}</strong> on this machine, so nothing is compared. The next run will show what changed.</td></tr>
      </table>`;

  // ---- (c) the module table ----
  const modules = moduleRows(run);
  const moduleTable = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e3e5e8">
      <thead><tr bgcolor="#fafbfc">
        <th style="${HEAD}">Module</th>
        <th style="${HEAD};text-align:right">Cases</th>
        <th style="${HEAD};text-align:right">Passed</th>
        <th style="${HEAD};text-align:right">Failed</th>
        <th style="${HEAD};text-align:right">Flaky</th>
        <th style="${HEAD};text-align:right">Time</th>
      </tr></thead>
      <tbody>${modules
        .map(
          (row) => `<tr>
        <td style="${CELL}">${escapeHtml(row.module)}</td>
        <td style="${CELL};text-align:right">${row.cases}</td>
        <td style="${CELL};text-align:right">${row.passed}</td>
        <td style="${CELL};text-align:right;${row.failed > 0 ? 'color:#a21b1b;font-weight:700' : ''}">${row.failed}</td>
        <td style="${CELL};text-align:right;${row.flaky > 0 ? 'color:#8a4b08;font-weight:700' : ''}">${row.flaky}</td>
        <td style="${CELL};text-align:right;white-space:nowrap">${formatDuration(row.durationMs)}</td>
      </tr>`,
        )
        .join('\n')}</tbody>
    </table>`;

  // ---- (d) the failures, bounded ----
  const failures = failureRows(run);
  const listed = failures.slice(0, MAX_LISTED_FAILURES);
  const failureBlock =
    failures.length === 0
      ? ''
      : `<tr><td style="padding:22px 24px 0">
    <div style="${FONT};font-size:15px;font-weight:700;color:#1f2328;padding-bottom:6px">Failures (${failures.length})</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e3e5e8">
      <thead><tr bgcolor="#fafbfc">
        <th style="${HEAD}">Case ID</th>
        <th style="${HEAD}">Module</th>
        <th style="${HEAD}">What went wrong</th>
      </tr></thead>
      <tbody>${listed
        .map((row) => {
          const rca = row.error?.rca;
          return `<tr>
        <td style="${CELL};white-space:nowrap;font-family:Consolas,Courier New,monospace">${escapeHtml(caseIdOf(row.result.title) ?? '—')}</td>
        <td style="${CELL};white-space:nowrap">${escapeHtml(moduleFrom(row.result.title) ?? '—')}</td>
        <td style="${CELL}">
          ${
            row.recovered
              ? `<div style="${FONT};font-size:11px;font-weight:700;color:#8a4b08;padding-bottom:2px">FLAKY — a retry passed</div>`
              : ''
          }
          <div style="font-family:Consolas,Courier New,monospace;font-size:12px;color:#a21b1b">${escapeHtml(errorHeadline(row.error?.message) ?? '(no error message recorded)')}</div>
          ${
            rca
              ? `<div style="${FONT};font-size:12px;color:#1f2328;padding-top:3px"><strong>${escapeHtml(rca.category)}</strong>${rca.confidence < 0.5 ? ' (low confidence)' : ''} — ${escapeHtml(errorHeadline(rca.rootCause) ?? '')}</div>`
              : ''
          }
        </td>
      </tr>`;
        })
        .join('\n')}</tbody>
    </table>
    ${
      failures.length > listed.length
        ? `<div style="${FONT};font-size:12px;color:#5b6370;padding-top:5px">+${failures.length - listed.length} more — the full list is in run.json.</div>`
        : ''
    }
  </td></tr>`;

  // ---- (e) the HTTP summary, split by ORIGIN ----
  const net = run.network;
  const httpBlock = `<tr><td style="padding:22px 24px 0">
    <div style="${FONT};font-size:15px;font-weight:700;color:#1f2328;padding-bottom:4px">HTTP</div>
    ${
      net
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
      ${headerRow('Application', `<strong>${escapeHtml(formatStatusCounts(net.appByStatus))}</strong>`)}
      ${headerRow('Third party', `${escapeHtml(formatStatusCounts(net.thirdPartyByStatus))} <span style="color:#5b6370">— another origin's service, NOT counted against this application</span>`)}
      ${headerRow('Requests', `${net.totalRequests} across ${net.testsReporting} instrumented test(s)`)}
      ${
        net.topFailingEndpoints.length > 0
          ? headerRow(
              'Top failing',
              net.topFailingEndpoints
                .map(
                  (endpoint) =>
                    `<span style="font-family:Consolas,Courier New,monospace">${escapeHtml(endpoint.method)} ${escapeHtml(endpoint.path)}</span> → ${endpoint.status} ×${endpoint.count}${endpoint.sameOrigin ? '' : ' <span style="color:#5b6370">(third party)</span>'}`,
                )
                .join('<br />'),
            )
          : headerRow('Top failing', 'nothing failed')
      }
    </table>`
        : // ABSENT is not zero. A run with no instrumented test has no network record,
          // and printing zeroes would say it made no requests.
          `<div style="${FONT};font-size:13px;color:#5b6370">No network records in this run — no test was instrumented, which is not the same as a run that made no requests.</div>`
    }
  </td></tr>`;

  // ---- (f) the safety line ----
  const reLogins = reLoginCount(run);
  const safetyBlock = `<tr><td style="padding:16px 24px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f6f8fa" style="border:1px solid #e3e5e8">
      <tr><td style="${FONT};font-size:13px;color:#1f2328;padding:10px 14px">
        <strong>Write attempts to the application: ${net ? net.appWriteAttempts : 'not recorded'}</strong>
        ${net && net.appWriteAttempts === 0 ? ' — this run was read-only.' : ''}
        <br />Sign-ins during the run (session recovery): ${reLogins}
        ${
          input.includeScreenshots === false
            ? '<br />Screenshots not included for this application.'
            : ''
        }
      </td></tr>
    </table>
  </td></tr>`;

  // ---- (g) sheet drift ----
  const drift = run.sheetDrift;
  const driftBlock = `<tr><td style="padding:22px 24px 0">
    <div style="${FONT};font-size:15px;font-weight:700;color:#1f2328;padding-bottom:4px">Sheet drift</div>
    ${
      drift
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
      ${headerRow('Totals', `match ${drift.match} · phrasing ${drift.phrasing} · narrower ${drift.narrower} · <strong>real ${drift.real}</strong> &nbsp;<span style="color:#5b6370">over ${drift.modules} module(s)</span>`)}
      ${
        drift.byModule.filter((entry) => entry.counts.real > 0).length > 0
          ? headerRow(
              'Most real drift',
              drift.byModule
                .filter((entry) => entry.counts.real > 0)
                .slice(0, 5)
                .map((entry) => `${escapeHtml(entry.module)} (${entry.counts.real})`)
                .join('<br />'),
            )
          : headerRow('Most real drift', 'none — every expected column has a counterpart')
      }
    </table>
    <div style="${FONT};font-size:12px;color:#5b6370;padding-top:5px">
      Column names are in <strong>sheet-drift.csv</strong>, in the project folder. The sheet is AI-generated and has never been through a human run, so <em>real</em> is a note for the QA rather than an application defect.
    </div>`
        : `<div style="${FONT};font-size:13px;color:#5b6370">No sheet columns were classified in this run, which is not the same as a sheet that matched.</div>`
    }
  </td></tr>`;

  const attachment = input.reportZipTooLarge
    ? `The full Playwright report was <strong>not attached</strong>: it is over the 10 MB limit. It is in the project folder on the machine that ran this.`
    : input.reportZipName
      ? `Full Playwright report attached as <strong>${escapeHtml(input.reportZipName)}</strong>.`
      : `No report archive was attached to this run.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.application)} · ${escapeHtml(input.environment)} — ${escapeHtml(verdict)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f5f7">
<tr><td align="center" style="padding:20px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="860" style="width:860px;max-width:100%;background-color:#ffffff;border:1px solid #e3e5e8">

  <tr><td style="padding:20px 24px 0">
    <div style="${FONT};font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5b6370">Automated test run</div>
    <div style="${FONT};font-size:22px;font-weight:700;color:#1f2328;padding-top:2px">
      ${escapeHtml(input.application)} · ${escapeHtml(input.environment)} —
      <span style="color:${verdictColour}">${escapeHtml(verdict)}</span>
    </div>
  </td></tr>

  <tr><td style="padding:12px 24px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      ${headerRow('Application', `<strong>${escapeHtml(input.application)}</strong>`)}
      ${headerRow('Environment', `<strong>${escapeHtml(input.environment)}</strong> &nbsp; <span style="color:#5b6370">${escapeHtml(hostOf(input.baseUrl))}</span>${run.target?.isDemoApp ? ' <strong>(bundled demo app)</strong>' : ''}`)}
      ${headerRow('Run by', escapeHtml(input.ranBy))}
      ${headerRow('Triggered by', escapeHtml(input.trigger ?? 'not recorded'))}
      ${headerRow('Run id', `<span style="font-family:Consolas,Courier New,monospace">${escapeHtml(run.id)}</span>`)}
      ${headerRow('Started', escapeHtml(startedLine(run)))}
      ${headerRow('Finished', escapeHtml(run.finishedAt ?? '(not recorded)'))}
      ${headerRow('Duration', escapeHtml(formatDuration(summary.durationMs)))}
    </table>
  </td></tr>

  <tr><td style="padding:16px 24px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      ${countTile('Tests', summary.total, '#1f2328')}
      ${countTile('Passed', summary.passed, '#0b6b45')}
      ${countTile('Failed', summary.failed, summary.failed > 0 ? '#a21b1b' : '#1f2328')}
      ${countTile('Flaky', summary.flaky, summary.flaky > 0 ? '#8a4b08' : '#1f2328')}
      ${countTile('Skipped', summary.skipped, '#4b5563')}
      ${countTile('Pass rate', summary.passRate, summary.failed > 0 ? '#a21b1b' : '#0b6b45')}
    </tr></table>
  </td></tr>

  <tr><td style="padding:22px 24px 0">
    <div style="${FONT};font-size:15px;font-weight:700;color:#1f2328">By module (${modules.length})</div>
    <div style="${FONT};font-size:12px;color:#5b6370;padding-bottom:6px">
      One row per module, counting DISTINCT tests — so these add up to the totals above, where the table below counts attempts.
    </div>
    ${moduleTable}
  </td></tr>

  ${failureBlock}

  ${httpBlock}

  ${safetyBlock}

  ${driftBlock}

  <tr><td style="padding:22px 24px 0">
    <div style="${FONT};font-size:15px;font-weight:700;color:#1f2328">Every execution (${run.results.length})</div>
    <div style="${FONT};font-size:12px;color:#5b6370;padding-bottom:6px">
      One row per attempt, so a retry is visible. The counts above are per TEST — a retried test is counted once.
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e3e5e8">
      <thead><tr bgcolor="#fafbfc">
        <th style="${HEAD}">Status</th>
        <th style="${HEAD}">Case ID</th>
        <th style="${HEAD}">Test</th>
        <th style="${HEAD}">Module</th>
        <th style="${HEAD};text-align:right">Duration</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </td></tr>

  <tr><td style="padding:0 24px">${comparisonBlock}</td></tr>

  <tr><td style="padding:22px 24px 24px">
    <div style="${FONT};font-size:12px;color:#5b6370;border-top:1px solid #e3e5e8;padding-top:10px">
      ${attachment}<br />
      Run folder: <span style="font-family:Consolas,Courier New,monospace">${escapeHtml(run.id)}</span><br />
      <strong>AI Testing Platform — built by Hashim Khan.</strong>
      This mail is generated from the run's own record; nobody typed it.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * THE SAME REPORT AS PLAIN TEXT — the fallback, and `summary.md` inside the bundle.
 *
 * ## Why a mail needs one at all
 *
 * A multipart mail carries both and the client picks. Outlook's reading pane shows
 * the HTML; a watch, a screen reader, a plain-text-only client and a mail gateway
 * that strips HTML all show this. Without it they show nothing, which is the one
 * outcome a notification cannot afford.
 *
 * ## It is the same DATA, deliberately, and the same source
 *
 * Every section here reads the same fields and the same helpers as the HTML —
 * `moduleRows`, `failureRows`, `reLoginCount`, `run.network`, `run.sheetDrift`. A
 * second aggregation would be a second source of truth, and the two would disagree
 * on the run where it mattered. What differs is only the rendering.
 *
 * It doubles as `summary.md` in the notify bundle, so a reader who opens the
 * attachment gets the mail's own words rather than a third summary.
 */
export function renderReportEmailText(input: ReportEmailInput): string {
  const { run } = input;
  const summary = run.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
    passRate: 0,
  };
  const verdict = verdictOf(run);
  const net = run.network;
  const drift = run.sheetDrift;
  const out: string[] = [];

  // (a) header
  out.push(`${input.application.toUpperCase()} · ${input.environment} — ${verdict}`);
  out.push('='.repeat(60));
  out.push(`Application  : ${input.application}`);
  out.push(`Environment  : ${input.environment} (${hostOf(input.baseUrl)})`);
  out.push(`Run by       : ${input.ranBy}`);
  out.push(`Triggered by : ${input.trigger ?? 'not recorded'}`);
  out.push(`Run id       : ${run.id}`);
  out.push(`Started      : ${startedLine(run)}`);
  out.push(`Duration     : ${formatDuration(summary.durationMs)}`);
  out.push('');

  // (b) verdict and counts
  out.push(
    `${verdict} — ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ` +
      `${summary.flaky} flaky, ${summary.skipped} skipped (${summary.passRate}% pass rate)`,
  );
  out.push('');

  // (c) module table, padded so it lines up in a monospaced client
  const modules = moduleRows(run);
  out.push(`BY MODULE (${modules.length})`);
  const width = Math.max(6, ...modules.map((row) => row.module.length));
  out.push(`${'Module'.padEnd(width)}  Cases  Passed  Failed  Flaky  Time`);
  for (const row of modules) {
    out.push(
      `${row.module.padEnd(width)}  ${String(row.cases).padStart(5)}  ${String(row.passed).padStart(6)}  ` +
        `${String(row.failed).padStart(6)}  ${String(row.flaky).padStart(5)}  ${formatDuration(row.durationMs)}`,
    );
  }
  out.push('');

  // (d) failures, bounded the same way
  const failures = failureRows(run);
  if (failures.length > 0) {
    out.push(`FAILURES (${failures.length})`);
    for (const row of failures.slice(0, MAX_LISTED_FAILURES)) {
      out.push(
        `- ${caseIdOf(row.result.title) ?? '—'} [${moduleFrom(row.result.title) ?? '—'}]` +
          `${row.recovered ? ' (FLAKY — a retry passed)' : ''} ` +
          `${errorHeadline(row.error?.message) ?? '(no error message recorded)'}`,
      );
      const rca = row.error?.rca;
      if (rca) {
        out.push(
          `    RCA: ${rca.category}${rca.confidence < 0.5 ? ' (low confidence)' : ''} — ` +
            `${errorHeadline(rca.rootCause) ?? ''}`,
        );
      }
    }
    if (failures.length > MAX_LISTED_FAILURES) {
      out.push(`+${failures.length - MAX_LISTED_FAILURES} more — the full list is in run.json.`);
    }
    out.push('');
  }

  // (e) HTTP
  out.push('HTTP');
  if (net) {
    out.push(`Application : ${formatStatusCounts(net.appByStatus)}`);
    out.push(
      `Third party : ${formatStatusCounts(net.thirdPartyByStatus)} ` +
        "— another origin's service, NOT counted against this application",
    );
    out.push(
      `Requests    : ${net.totalRequests} across ${net.testsReporting} instrumented test(s)`,
    );
    for (const endpoint of net.topFailingEndpoints) {
      out.push(
        `  ${endpoint.method} ${endpoint.path} -> ${endpoint.status} x${endpoint.count}` +
          `${endpoint.sameOrigin ? '' : ' (third party)'}`,
      );
    }
  } else {
    out.push(
      'No network records in this run — no test was instrumented, which is not the same as a',
    );
    out.push('run that made no requests.');
  }
  out.push('');

  // (f) safety
  out.push('SAFETY');
  out.push(
    `Write attempts to the application: ${net ? net.appWriteAttempts : 'not recorded'}` +
      `${net && net.appWriteAttempts === 0 ? ' — this run was read-only.' : ''}`,
  );
  out.push(`Sign-ins during the run (session recovery): ${reLoginCount(run)}`);
  if (input.includeScreenshots === false) {
    out.push('Screenshots not included for this application.');
  }
  out.push('');

  // (g) sheet drift
  out.push('SHEET DRIFT');
  if (drift) {
    out.push(
      `match ${drift.match} · phrasing ${drift.phrasing} · narrower ${drift.narrower} · ` +
        `real ${drift.real}  (over ${drift.modules} module(s))`,
    );
    const worst = drift.byModule.filter((entry) => entry.counts.real > 0).slice(0, 5);
    if (worst.length === 0) out.push('No real drift — every expected column has a counterpart.');
    else for (const entry of worst) out.push(`  ${entry.module}: ${entry.counts.real} real`);
    out.push('Column names are in sheet-drift.csv, in the project folder.');
  } else {
    out.push('No sheet columns were classified in this run, which is not the same as a sheet');
    out.push('that matched.');
  }
  out.push('');

  // (h) footer
  out.push('-'.repeat(60));
  if (input.reportZipTooLarge) {
    out.push('The bundle was NOT attached: it is over the 10 MB limit. It is in the project');
    out.push('folder on the machine that ran this.');
  } else if (input.reportZipName) {
    out.push(`Bundle attached as ${input.reportZipName}.`);
  }
  out.push(`Run folder: ${run.id}`);
  out.push('AI Testing Platform — built by Hashim Khan.');
  out.push("Generated from the run's own record; nobody typed it.");

  return `${out.join('\n')}\n`;
}
