import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertTallyBalances,
  tallyBuckets,
  type AuthoredRunResult,
  type RowResult,
  type RowStatus,
} from './execute';
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

/**
 * What the report's table calls each status. Total over `RowStatus`: a new
 * status with no label does not compile, so it cannot be left out of the table.
 */
const STATUS_LABEL = {
  passed: 'Passed',
  failed: 'Failed',
  refused: 'Refused',
  held: 'Held',
  unreadable: 'Unreadable',
  'stale-capture': 'Stale capture',
  'given-not-reached': 'Given not reached',
} as const satisfies Record<RowStatus, string>;

type SectionKey = 'app-team' | 'qa' | 'capture' | 'environment' | 'held' | 'passed';

/**
 * The report section each status is listed in — exactly one per status.
 *
 * Total over `RowStatus`, so a new status does not compile until it is given a
 * section. Before this, a status with an owner, a bucket and a label but no
 * section DID compile: its rows were counted in the table and then never
 * listed. Only `verifyReportOnDisk` could notice, and only when a file was
 * written — never for an in-memory render.
 *
 * Within a section, rows appear in THIS map's declaration order, which is why
 * "For the QA" lists refused rows before unreadable ones.
 */
const SECTION_OF = {
  passed: 'passed',
  failed: 'app-team',
  refused: 'qa',
  held: 'held',
  unreadable: 'qa',
  'stale-capture': 'capture',
  'given-not-reached': 'environment',
} as const satisfies Record<RowStatus, SectionKey>;

/**
 * The detailed sections, in the order they are printed. `passed` is not here on
 * purpose: it is printed after the triage, in its own shorter form.
 */
const DETAILED_SECTIONS = [
  {
    key: 'app-team',
    title: 'For the app team',
    blurb:
      'The application did not do what these rows say it should. Each names a row a QA wrote and what happened instead.',
  },
  {
    key: 'qa',
    title: 'For the QA',
    blurb:
      'These rows could not be understood or resolved. Nothing ran for them — they are not failures of the application.',
  },
  {
    key: 'capture',
    title: 'The capture is out of date',
    blurb:
      'These rows resolved cleanly against the capture, but their target is not on the live page. Neither an app bug nor a bad row — re-run `pnpm inspect` and try again.',
  },
  {
    key: 'environment',
    title: 'The run never reached the starting point',
    blurb:
      'These rows were never run: the run could not put the page in the state the row starts from. Each says which step stopped it — signing in, reaching the route, a module with no entry in the map, or the element that proves the screen. Not an app bug, not a bad row, and not a stale capture.',
  },
  {
    key: 'held',
    title: 'Held — not run',
    blurb:
      'These rows would create, modify or delete data. `ALLOW_WRITES` is not set, so nothing was run. This is a deliberate outcome, not an omission.',
  },
] as const satisfies ReadonlyArray<{
  key: Exclude<SectionKey, 'passed'>;
  title: string;
  blurb: string;
}>;

/**
 * Every section a status can be mapped to is printed somewhere. Without this a
 * NEW section key could be mapped to and never printed — the same silent drop,
 * one level up. Resolves to `never`, and so fails to compile, when a key is
 * neither in `DETAILED_SECTIONS` nor `passed`.
 */
type UnprintedSection = Exclude<SectionKey, (typeof DETAILED_SECTIONS)[number]['key'] | 'passed'>;
const _everySectionIsPrinted: [UnprintedSection] extends [never] ? true : never = true;

const heading = (result: RowResult): string =>
  `**${result.rowId}** — ${result.title || '(untitled)'}  \n  _sheet row ${result.sheetRow}_`;

function section(title: string, blurb: string, rows: RowResult[]): string[] {
  if (rows.length === 0) return [];
  const lines = [`## ${title} (${rows.length})`, '', blurb, ''];
  for (const row of rows) {
    lines.push(`- ${heading(row)}`);
    lines.push(`  ${row.detail}`);
    if (row.preflight) lines.push(`  _${row.preflight}_`);
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

/**
 * The entry-failure section, grouped BY MODULE rather than by row.
 *
 * One entry state stops every row of its module, so listing rows the way the
 * other sections do would report one problem forty-seven times and bury the
 * one sentence a reader can act on. The module, the stage that failed and the
 * count come first; the row ids follow, because they are still the rows that
 * did not run.
 */
function entrySection(rows: RowResult[]): string[] {
  if (rows.length === 0) return [];
  const byModule = new Map<string, RowResult[]>();
  for (const row of rows) {
    const module = row.status === 'given-not-reached' ? row.module : '(unknown module)';
    byModule.set(module, [...(byModule.get(module) ?? []), row]);
  }

  const lines = [
    `## The run never reached the starting point (${rows.length})`,
    '',
    'These rows were never run: the run could not put the page in the state the row starts from. Each group names the module and the step that stopped it — signing in, reaching the route, or the element that proves the screen. Not an app bug, not a bad row, and not a stale capture.',
    '',
  ];
  for (const [module, group] of byModule) {
    const first = group[0]!;
    const reason = first.status === 'given-not-reached' ? first.reason : 'unknown';
    lines.push(`- **${module}** — ${reason}: ${first.detail}`);
    lines.push(`  ${group.length} row(s) never ran: ${group.map((row) => row.rowId).join(', ')}`);
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
  const rowsIn = (key: SectionKey): RowResult[] =>
    (Object.keys(SECTION_OF) as RowStatus[])
      .filter((status) => SECTION_OF[status] === key)
      .flatMap((status) => of(status));

  // Both the table and the sum are derived from the ONE bucket list, so a status
  // cannot be counted in the tally and missing from what the reader sees.
  const buckets = tallyBuckets();
  const lines: string[] = [
    `# Authored test run — ${sheetName}`,
    '',
    '| | Count |',
    '| --- | --- |',
    `| Rows read | **${tally.rowsRead}** |`,
    ...buckets.map(([status, bucket]) => `| ${STATUS_LABEL[status]} | ${tally[bucket]} |`),
    '',
    `Every row read appears below exactly once: ` +
      `${buckets.map(([, bucket]) => tally[bucket]).join(' + ')} = ${tally.rowsRead}.`,
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
    ...DETAILED_SECTIONS.flatMap(({ key, title, blurb }) =>
      // `environment` groups by module; every other section lists rows.
      key === 'environment' ? entrySection(rowsIn(key)) : section(title, blurb, rowsIn(key)),
    ),
  );

  // The triage sits with the results, not in an appendix: a reader who needs
  // to know what the run covered needs to know what it could never cover.
  if (triage) lines.push(renderTriage(triage), '');

  const passed = rowsIn('passed');
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
export function writeAuthoredReport(run: AuthoredRunResult, options: ReportOptions): WrittenReport {
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
    .map((result) =>
      result.status === 'unreadable' ? `sheet row ${result.sheetRow}` : result.rowId,
    )
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
