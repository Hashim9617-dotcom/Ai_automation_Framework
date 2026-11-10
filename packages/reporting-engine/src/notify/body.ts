import { TestOutcome, type Run, type TestResult } from '@aitp/shared';
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
  const index = title.indexOf('›');
  if (index < 0) return null;
  const module = title.slice(0, index).trim();
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

export interface ReportEmailInput {
  run: Run;
  /** The application slug. Passed in from the resolved target, never inferred here. */
  application: string;
  environment: string;
  /** The resolved URL this run actually ran against. */
  baseUrl: string;
  /** Who the mail says it is from. */
  ranBy: string;
  /** `null` when this is the first recorded run for the application. */
  comparison: RunComparison | null;
  /** Named so the body can say what is attached — or that nothing is. */
  reportZipName?: string | undefined;
  reportZipTooLarge?: boolean | undefined;
}

/** `passed`, `failed` — the one-word verdict, from the run's own status. */
export function verdictOf(run: Run): string {
  const failed = run.summary?.failed ?? 0;
  if (failed > 0) return 'FAILED';
  return run.status === 'passed' ? 'PASSED' : run.status.toUpperCase();
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
  const verdictColour = verdict === 'PASSED' ? '#0b6b45' : '#a21b1b';

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
      ${headerRow('Environment', `<strong>${escapeHtml(input.environment)}</strong> &nbsp; <span style="color:#5b6370">${escapeHtml(input.baseUrl)}</span>${run.target?.isDemoApp ? ' <strong>(bundled demo app)</strong>' : ''}`)}
      ${headerRow('Run by', escapeHtml(input.ranBy))}
      ${headerRow('Run id', `<span style="font-family:Consolas,Courier New,monospace">${escapeHtml(run.id)}</span>`)}
      ${headerRow('Started', escapeHtml(run.startedAt ?? run.createdAt))}
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
      Sent by the AI Testing Platform. This mail is generated from the run's own record; nobody typed it.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
