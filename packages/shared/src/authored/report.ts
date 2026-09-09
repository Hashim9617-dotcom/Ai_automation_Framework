import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertTallyBalances, type AuthoredRunResult, type RowResult } from './execute';
import { renderTriage, type TriageResult } from './triage';

/**
 * The report a QA opens.
 *
 * `docs/phase-2-authored-cases.md` §9. Two properties dominate the design:
 *
 * - **Two failure kinds go to two audiences, in two sections.** A report that
 *   merges "the app is wrong" with "the row is unclear" is useless to both, and
 *   merging them in the PROSE is just as bad as merging them in the data.
 * - **The writer asserts its own effect.** A report is the one artifact nobody
 *   re-checks by hand: it is read once, its numbers are quoted, and the file is
 *   never opened again. So it is re-read and verified before success is
 *   reported.
 */

/**
 * What the run was actually executed against, and what that does and does not
 * establish.
 *
 * **Required on every report written to disk**, and that is the whole design.
 * A run against a substitute target — the bundled demo app, a staging clone, a
 * mock — produces a document indistinguishable from a run against the real
 * application, and three weeks later nobody re-checks which it was. "The slice
 * ran green" is then read as a claim about the product.
 *
 * An in-memory render may omit it, because a string held in a variable does not
 * outlive the knowledge of what produced it. A FILE does. So the durable
 * artifact is the one that must carry its own provenance, and the type system
 * is what makes it impossible to write one that does not.
 */
export interface RunProvenance {
  /** Named plainly: "the bundled demo app", not "the app". */
  target: string;
  /** What a green run HERE does establish. */
  proves: string;
  /** What it does not establish, however green it is. */
  doesNotProve: string;
}

export interface ReportOptions {
  /** Our own artifacts directory. NEVER the QA's workbook — see §9.5. */
  outputDir: string;
  sheetName: string;
  fileName?: string;
  /** Required: see `RunProvenance`. A written report always says what it ran against. */
  provenance: RunProvenance;
  /**
   * Sheet triage: which rows can never be automated, and why.
   *
   * Optional because a run of already-resolved rows may not have the sheet to
   * hand — but when it is present the ceiling is recomputed from the sheet on
   * every run, which is the point. A number that lives in a summary someone
   * wrote once goes stale silently.
   */
  triage?: TriageResult;
}

export interface WrittenReport {
  file: string;
  rowsWritten: number;
  markdown: string;
}

const heading = (result: RowResult): string =>
  `**${result.rowId}** — ${result.title || '(untitled)'}  \n  _sheet row ${result.sheetRow}_`;

function section(title: string, blurb: string, rows: RowResult[]): string[] {
  if (rows.length === 0) return [];
  const lines = [`## ${title} (${rows.length})`, '', blurb, ''];
  for (const row of rows) {
    lines.push(`- ${heading(row)}`);
    lines.push(`  ${row.detail}`);
    if (row.preflight) lines.push(`  _${row.preflight}_`);
    if (row.healingProposal) {
      // Recorded as a SUGGESTION and labelled as one. Healing may propose; it
      // may never substitute (§10.2), so this only ever appears beside a
      // non-passing status — it never moved the verdict that put it here.
      lines.push(`  _suggestion (not applied): ${row.healingProposal}_`);
    }
    if (row.evidence) {
      // PATHS ONLY. A trace holds a live session token and document titles
      // from the instance, so it is referenced and never inlined (§10.4).
      lines.push(`  failing clause: ${row.evidence.failingClause}`);
      if (row.evidence.screenshot) lines.push(`  screenshot: ${row.evidence.screenshot}`);
      if (row.evidence.trace) lines.push(`  trace: ${row.evidence.trace}`);
    }
    for (const clause of row.orphanedContent ?? []) lines.push(`      ${clause}`);
    lines.push('');
  }
  return lines;
}

export function renderAuthoredReport(
  run: AuthoredRunResult,
  sheetName: string,
  provenance?: RunProvenance,
  triage?: TriageResult,
): string {
  const { results, tally } = run;
  // Re-checked here as well as at execution: the numbers in this document are
  // the ones that get quoted, so they are verified at the point of writing.
  assertTallyBalances(tally, results);

  const of = (status: RowResult['status']): RowResult[] =>
    results.filter((r) => r.status === status);

  const lines: string[] = [
    `# Authored test run — ${sheetName}`,
    '',
    '| | Count |',
    '| --- | --- |',
    `| Rows read | **${tally.rowsRead}** |`,
    `| Passed | ${tally.passed} |`,
    `| Failed | ${tally.failed} |`,
    `| Refused | ${tally.refused} |`,
    `| Held | ${tally.held} |`,
    `| Unreadable | ${tally.unreadable} |`,
    `| Stale capture | ${tally.staleCapture} |`,
    '',
    `Every row read appears below exactly once: ` +
      `${tally.passed} + ${tally.failed} + ${tally.refused} + ${tally.held} + ` +
      `${tally.unreadable} + ${tally.staleCapture} = ${tally.rowsRead}.`,
    '',
    '> A refused row is not a pass. A held row is not a pass. An unreadable row',
    '> is not nothing.',
    '',
  ];

  // Immediately under the numbers, because that is where a reader stops. The
  // qualification has to sit beside the green, not in a footer.
  if (provenance) {
    lines.push(
      '## What this run was against',
      '',
      `**Target: ${provenance.target}**`,
      '',
      `- **This run proves:** ${provenance.proves}`,
      `- **This run does NOT prove:** ${provenance.doesNotProve}`,
      '',
    );
  }

  lines.push(
    ...section(
      'For the app team',
      'The application did not do what these rows say it should. Each names a row a QA wrote and what happened instead.',
      of('failed'),
    ),
    ...section(
      'For the QA',
      'These rows could not be understood or resolved. Nothing ran for them — they are not failures of the application.',
      [...of('refused'), ...of('unreadable')],
    ),
    ...section(
      'The capture is out of date',
      'These rows resolved cleanly against the capture, but their target is not on the live page. Neither an app bug nor a bad row — re-run `pnpm inspect` and try again.',
      of('stale-capture'),
    ),
    ...section(
      'Held — not run',
      'These rows would create, modify or delete data. `ALLOW_WRITES` is not set, so nothing was run. This is a deliberate outcome, not an omission.',
      of('held'),
    ),
  );

  // The triage sits with the results, not in an appendix: a reader who needs
  // to know what the run covered needs to know what it could never cover.
  if (triage) lines.push(renderTriage(triage), '');

  const passed = of('passed');
  if (passed.length > 0) {
    lines.push(`## Passed (${passed.length})`, '');
    for (const row of passed) lines.push(`- ${row.rowId} — ${row.title}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Writes the report, then verifies what landed.
 *
 * The verification is the point. CLAUDE.md's oldest rule, applied where it
 * matters most: a reporter that writes nothing and prints "470 rows" is exactly
 * the failure that convention was earned from, and a report is the one artifact
 * nobody opens again to check.
 *
 * Three checks, each against the file ON DISK rather than against the string we
 * meant to write:
 *   1. it is not empty;
 *   2. it carries the row count it claims;
 *   3. **every input id appears in it** — the check a count alone cannot make,
 *      since 470 lines with one row written twice still counts to 470.
 */
export function writeAuthoredReport(
  run: AuthoredRunResult,
  options: ReportOptions,
): WrittenReport {
  const markdown = renderAuthoredReport(run, options.sheetName, options.provenance, options.triage);
  mkdirSync(options.outputDir, { recursive: true });
  const file = path.join(options.outputDir, options.fileName ?? 'authored-run.md');
  writeFileSync(file, markdown, 'utf8');

  const landed = verifyReportOnDisk(file, run);

  assertProvenanceLanded(file, landed, options.provenance);

  return { file, rowsWritten: run.results.length, markdown: landed };
}

/**
 * Re-reads a written report and verifies it against the run it came from.
 *
 * **Exported so it has a falsifier.** As an inline block inside the writer it
 * could not be tested: no input makes the renderer legitimately omit a row, so
 * nothing could ever make the check fire, and mutation testing duly found that
 * removing it broke nothing. A guard with no falsifier is decoration (rule 3).
 *
 * Reading from DISK rather than checking the string we meant to write is the
 * whole point — that is what catches a write that failed or was truncated.
 */
export function verifyReportOnDisk(file: string, run: AuthoredRunResult): string {
  const landed = readFileSync(file, 'utf8');

  if (landed.trim().length === 0) {
    throw new Error(`the report at ${file} is empty after writing.`);
  }
  if (!landed.includes(`| Rows read | **${run.tally.rowsRead}** |`)) {
    throw new Error(
      `the report at ${file} does not carry the row count it was built from (${run.tally.rowsRead}).`,
    );
  }

  const missing = run.results
    .map((result) => (result.status === 'unreadable' ? `sheet row ${result.sheetRow}` : result.rowId))
    .filter((id) => !landed.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `the report at ${file} is missing ${missing.length} of ${run.results.length} row(s): ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}. ` +
        'A row that was read but does not appear is the failure this check exists for.',
    );
  }

  return landed;
}

/**
 * Verifies the written report names what the run was executed against.
 *
 * **Exported so it has a falsifier**, for the same reason `verifyReportOnDisk`
 * is. Inline in the writer it could never fire: `renderAuthoredReport` always
 * writes `provenance.target` verbatim, so no input could produce a document
 * missing it, and a guard nothing can trigger is decoration (rule 3). Handed a
 * document directly, a test can present the case that matters — a report whose
 * numbers landed and whose provenance did not.
 *
 * That case is not hypothetical in the direction that counts: it is what every
 * report written before this field existed looks like.
 */
export function assertProvenanceLanded(
  file: string,
  landed: string,
  provenance: RunProvenance,
): void {
  if (!landed.includes(provenance.target)) {
    throw new Error(
      `the report at ${file} does not name the target it ran against ` +
        `("${provenance.target}"). A report that states results without stating what ` +
        'produced them is read later as a claim about the real application.',
    );
  }
}
