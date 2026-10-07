import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  executeAuthoredRows,
  findRepoRoot,
  loadModuleMap,
  newId,
  partitionMappedModules,
  entryStateByModule,
  readFinalTestCases,
  readSheetGrid,
  resolveAuthoredRow,
  resolveRunIdentity,
  triageSheet,
  writeAuthoredReport,
  writeAutomationSheet,
  defaultRunIdentitySources,
  type AuthoredRunResult,
  type BoundedCapture,
  type EntryControl,
  type RefusedUpfrontRow,
  type RunIdentity,
  type RunProvenance,
} from '@aitp/shared';
import type { EnvironmentConfig } from '../config/schema';
import { createEntryVerifier } from './entry-verifier';
import { createPlaywrightStepExecutor } from './playwright-executor';

/**
 * One authored sheet, end to end: read it, resolve it, prove the entry state,
 * run it, and write both outputs.
 *
 * ## Why this lives here and not in `@aitp/shared`
 *
 * It needs a Playwright `Page`. `@aitp/shared` has no Playwright dependency and
 * must not gain one — it is the package `apps/api` compiles into its own `dist`,
 * and every runtime dependency of a compiled package becomes an invisible
 * requirement of the API. So the composition sits beside the two pieces that
 * already hold a page: `entry-verifier.ts` and `playwright-executor.ts`.
 *
 * ## What it does NOT do
 *
 * - **It never sets `allowWrites`.** `executeAuthoredRows` defaults it to
 *   `false`, and this file does not pass it at all, so there is no parameter for
 *   a caller to thread a flag through. A write-risky row is held; that is the
 *   whole behaviour.
 * - **It does not own the browser.** The caller creates and closes the page, so
 *   a test can hand it one whose state it controls.
 * - **It does not load the capture from disk.** Measured 2026-09-29: all nine
 *   capture sessions under `artifacts/inspect/` are the customer system; there is
 *   no capture for the bundled demo app, and `artifacts/` is gitignored so a
 *   fresh clone has none at all. A loader here would have to fail on every clone
 *   for a reason that is not wrong. The caller supplies it — from a real page, or
 *   from disk once 3b gives it a source.
 * - **It writes nothing to the workbook.** `readSheetGrid` takes bytes, not a
 *   path it can write back to.
 *
 * ## The application is DERIVED, never asked for
 *
 * `env.application` is a required field on every environment file, so the module
 * map is `config/apps/<application>/module-map.json`. There is no option here to
 * name an application, because a second source for it is a second thing that can
 * disagree with the environment a run already resolved.
 */
export interface RunSheetOptions {
  /** Path to the workbook. Read as bytes; never written. */
  workbook: string;
  /**
   * The sheet to read. REQUIRED, no default.
   *
   * The real book holds five test-case-shaped sheets with different layouts, so
   * defaulting to the first — or to the one that looks right — reads a different
   * layout as if it were this one and every row becomes garbage that looks like
   * data.
   */
  sheet: string;
  /** Already resolved by the caller. `application` selects the module map. */
  env: EnvironmentConfig;
  /** The capture the rows are resolved and the entry states proved against. */
  capture: BoundedCapture;
  /** Caller-owned. The composition drives it and never closes it. */
  page: Page;
  /** App-specific, so it stays out of `packages/`. Called once per run. */
  signIn: () => Promise<void>;
  /** Where the report, the CSV and the screenshots go. Under `artifacts/`. */
  outDir: string;
  /** What a green run here does and does not establish. Required by the report. */
  provenance: RunProvenance;
  /** Injectable so a test does not depend on the machine's git config. */
  identity?: RunIdentity;
  /** Injectable so a test can assert on an exact value. */
  runId?: string;
}

export interface RunSheetResult {
  runId: string;
  run: AuthoredRunResult;
  reportPath: string;
  automationSheetPath: string;
  /**
   * Rows the SHEET had, counted from the inputs rather than from the results.
   *
   * A count taken from the output cannot notice rows that never became results,
   * which is the oldest reporting bug there is (§T: a check must assert it had a
   * subject).
   */
  rowsRead: number;
}

export async function runSheet(options: RunSheetOptions): Promise<RunSheetResult> {
  const grid = readSheetGrid(readFileSync(options.workbook), options.sheet);
  const sheet = readFinalTestCases(grid);
  const rowsRead = sheet.rows.length + sheet.unreadable.length;
  if (rowsRead === 0) {
    throw new Error(
      `${options.workbook}: read 0 rows from "${options.sheet}" — refusing to report a run over ` +
        'nothing. A sheet with no rows and a sheet that failed to parse are not the same answer.',
    );
  }

  // The module map is per APPLICATION, and the application comes from the
  // environment that was already resolved. Every module the sheet names must
  // have an entry: an unmapped module is refused for the whole run rather than
  // skipped, because a skipped module is a screen nobody knows went untested.
  const mapFile = path.join(
    findRepoRoot(),
    'config',
    'apps',
    options.env.application,
    'module-map.json',
  );
  const map = loadModuleMap(mapFile);
  const moduleOfRow = new Map(sheet.rows.map((row) => [row.rowId, row.module]));

  /**
   * PER MODULE, not per run.
   *
   * An unmapped module used to refuse the whole sheet, so one misspelt Module cell
   * cost 400 rows. Now its own rows are refused with the reason, and the rest runs.
   * The whole run stops only when NO module the sheet names is runnable — because
   * then there is nothing to report but the map, and saying so once is clearer than
   * saying it four hundred times.
   */
  const { unmapped } = partitionMappedModules([...moduleOfRow.values()], map, mapFile);

  // The whole map is validated, so an entry no row depends on is still CHECKED —
  // that breadth is what caught `Login`'s unprovable anchor in the demo fixture. The
  // consequence is what differs: an unprovable entry the sheet does not name is a
  // visible warning in the report, never a refusal.
  const { verify, validation } = createEntryVerifier({
    map,
    capture: options.capture,
    mapFile,
    page: options.page,
    signIn: options.signIn,
    // THE RUN'S OWN DIRECTORY, the same one a step failure's screenshot goes to. An
    // entry failure stops every row in a module, so it is the one most worth having
    // a picture of (E10).
    artifactDir: options.outDir,
  });

  const blocked = new Map<string, string>();
  for (const entry of unmapped) blocked.set(entry.module, entry.why);
  for (const entry of validation.unprovable) {
    // Only the modules this sheet names. The rest are warnings below.
    if (moduleOfRow.size > 0 && [...moduleOfRow.values()].includes(entry.module)) {
      blocked.set(entry.module, entry.why);
    }
  }

  const runnableRows = sheet.rows.filter((row) => !blocked.has(row.module));
  if (runnableRows.length === 0) {
    throw new Error(
      `no module the sheet names can be run, so there is nothing to report but ${mapFile}:\n` +
        [...blocked.values()].map((why) => `  - ${why}`).join('\n') +
        '\nEvery row would be refused for the same reason, and saying it once is the answer.',
    );
  }

  const refusedUpfront: RefusedUpfrontRow[] = sheet.rows
    .filter((row) => blocked.has(row.module))
    .map((row) => ({
      rowId: row.rowId,
      scenarioId: row.scenarioId,
      testCaseId: row.testCaseId,
      sheetRow: row.sheetRow,
      module: row.module,
      title: row.scenarioName,
      why: blocked.get(row.module)!,
    }));

  /**
   * THE STATE A ROW RESOLVES AGAINST IS LOOKED UP, NOT SPELLED.
   *
   * This derived a state id from the module's route — `/employees` became
   * `employees` — which worked for exactly as long as the only caller built its own
   * capture with ids chosen to match. The disk loader session-qualifies them
   * (`2026-10-01T…Z/employees`), because two walks of one screen otherwise collide on
   * the cursor a grounding check moves. So the spelled id matched nothing and every
   * row came back `refused`: found by the CLI's end-to-end run, with three
   * pre-registered outcomes disagreeing at once, and invisible to every test whose
   * capture it had also written.
   *
   * THE NEWEST state at the route, because a locator should be written against the
   * most recent walk of that screen. The loader reads sessions in sorted directory
   * order and the directories are ISO timestamps, so the last one wins.
   *
   * A module with no state at its route cannot get here: `validateModuleMap` has
   * already refused it, which is the §Y half — this lookup is only reached once that
   * gate has passed, so a missing entry is a wiring fault and not an outcome.
   */
  /**
   * ONE EXPRESSION FOR THE ROUTE -> STATE LOOKUP, shared with triage (B1).
   *
   * This was inlined here, and triage's `automatable` can only be the run's answer
   * if it resolves against the run's state — so a second copy of this arithmetic
   * would put the two back in a position to disagree while both looked right.
   *
   * The BLOCKED modules are removed afterwards rather than never added, so the map
   * handed to triage holds exactly the modules this run will attempt. Triage then
   * reports `no-capture-for-module` for precisely the rows this run refuses upfront,
   * by construction rather than by a matching rule written twice.
   */
  const entryStateOf = entryStateByModule(map, options.capture);
  for (const module of blocked.keys()) entryStateOf.delete(module);

  const resolved = runnableRows.map((row) => {
    const route = map[row.module]!.route.replace(/\/+$/, '') || '/';
    const stateId = entryStateOf.get(row.module);
    if (!stateId) {
      throw new Error(
        `${mapFile}, module "${row.module}": no captured state at route "${route}", yet the ` +
          'map validator called it provable. That is a wiring fault between the two, not a ' +
          'result — a row must never be resolved against a state nobody captured.',
      );
    }
    return resolveAuthoredRow(row, options.capture, stateId);
  });

  const entry: EntryControl = {
    moduleOf: (row) => moduleOfRow.get(row.rowId) ?? '(unknown module)',
    verify,
  };

  const runId = options.runId ?? newId('run');
  const run = await executeAuthoredRows({
    runId,
    resolved,
    unreadable: sheet.unreadable,
    refusedUpfront,
    entry,
    execute: createPlaywrightStepExecutor(options.page, { artifactDir: options.outDir }),
    // `allowWrites` is deliberately absent: the default is `false` and there is
    // no way through this function to change it.
  });

  const report = writeAuthoredReport(run, {
    outputDir: options.outDir,
    sheetName: options.sheet,
    provenance: options.provenance,
    // THE SAME CAPTURE AND THE SAME ENTRY STATES THIS RUN USED, so the triage's
    // `automatable` count is the number of rows this run executed — not a second
    // opinion about them. It was `new Set(Object.keys(map))`, which told triage every
    // mapped module was fine, including the ones blocked three lines above.
    triage: triageSheet(sheet.rows, { capture: options.capture, entryStateOf }),
    // EVERY unprovable entry, not only the ones that refused rows here. The two
    // sets differ on purpose: `blocked` decides what runs, this tells the reader
    // what is wrong with the map.
    mapWarnings: validation.unprovable,
  });

  const automationSheet = writeAutomationSheet(run, {
    outputDir: options.outDir,
    identity: options.identity ?? resolveRunIdentity(defaultRunIdentitySources),
  });

  return {
    runId,
    run,
    reportPath: report.file,
    automationSheetPath: automationSheet.file,
    rowsRead,
  };
}
