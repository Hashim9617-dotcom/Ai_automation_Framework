import { writeFileSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';
import { SHEET_DRIFT_ATTACHMENT } from '@aitp/reporting-engine';
import type { DriftRow } from '@aitp/shared';

/**
 * THE ONE WRITER of a test's classified drift rows.
 *
 * ## Why a FILE and not a body
 *
 * The network records were attached with `body:` for weeks. Playwright stored them
 * inside its own report, `run.json` recorded `path: "inline"`, and sixty-two tests
 * each attached an answer that could not be read back — so the run-level question
 * nobody could answer was the only one a report actually asks. This takes the same
 * route the fix took: a file under `testInfo.outputPath`, the per-test directory
 * Playwright already manages, attached BY PATH so the reporter can open it.
 *
 * ## One writer, and the name comes from the reader
 *
 * `SHEET_DRIFT_ATTACHMENT` is exported by the reporter that aggregates these and
 * imported here, so the writer and the reader cannot disagree about the name (§AE).
 * Two call sites each spelling it themselves is how an aggregate comes to find
 * nothing while every test reports.
 *
 * ## Header names only
 *
 * A row carries the module, the case id, the expected column name, the page header
 * it was paired with, the bucket and the rule. No cell value, no record identifier,
 * nothing from any row of any grid — the same rule the smoke manifest is built
 * under, and the reason the resulting CSV can be attached to a report that leaves
 * this machine.
 */
export async function attachDriftRows(rows: DriftRow[], testInfo: TestInfo): Promise<void> {
  const file = testInfo.outputPath(SHEET_DRIFT_ATTACHMENT);
  writeFileSync(file, `${JSON.stringify({ rows }, null, 2)}\n`, 'utf8');
  await testInfo.attach(SHEET_DRIFT_ATTACHMENT, { path: file, contentType: 'application/json' });
}
