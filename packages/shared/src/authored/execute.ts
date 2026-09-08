import type { CaseStep } from '../generation/grounding';
import type { UnreadableSheetRow } from './final-test-cases';
import { describeUnreadableRow, type ResolvedAuthoredRow } from './resolve-authored';
import type { Owner } from './resolver';

/**
 * Running resolved rows, and accounting for every one of them.
 *
 * `docs/phase-2-authored-cases.md` §9. The accounting matters more than the
 * mechanics, so the browser is behind a seam (`StepExecutor`) and everything
 * here is deterministic and testable without one.
 */

export type RowStatus = 'passed' | 'failed' | 'refused' | 'held' | 'unreadable';

/**
 * The status -> owner mapping, fixed and TOTAL.
 *
 * §9.3: it must be impossible for a run to be ambiguous about which kind of
 * failure happened. A `Record` over the status union is that guarantee — every
 * status has exactly one owner, adding a status without an owner does not
 * compile, and `failed` and `refused` can never share one.
 */
export const OWNER_OF: Record<RowStatus, Owner> = {
  passed: 'none',
  // The app did not do what the row expected.
  failed: 'app-team',
  // We could not understand or resolve the row.
  refused: 'qa',
  // A policy decision, not a fault: it would create data and writes are off.
  held: 'none',
  // A human put content in a row the reader could not identify.
  unreadable: 'qa',
};

export interface RowResult {
  /** Always the composite. Never the Test Case ID alone — see §9.1. */
  rowId: string;
  scenarioId: string;
  testCaseId: string;
  sheetRow: number;
  title: string;
  status: RowStatus;
  owner: Owner;
  detail: string;
  /** What the capture predicted before the run. Context, never a verdict. */
  preflight?: string;
  /** For an unreadable row that a QA can recover — see §2d. */
  recoverable?: boolean;
  orphanedContent?: string[];
}

export interface RunTally {
  rowsRead: number;
  passed: number;
  failed: number;
  refused: number;
  held: number;
  unreadable: number;
}

export interface AuthoredRunResult {
  results: RowResult[];
  tally: RunTally;
}

/** Runs one resolved step. The browser lives behind this, not in the accounting. */
export type StepExecutor = (input: {
  rowId: string;
  step: CaseStep;
}) => Promise<{ ok: boolean; detail: string }>;

export interface ExecuteOptions {
  resolved: ResolvedAuthoredRow[];
  unreadable: UnreadableSheetRow[];
  execute: StepExecutor;
  /**
   * Read from the ENVIRONMENT by the caller, never from the sheet.
   *
   * There is no column, tag or cell value that reaches this — see §9.4. A sheet
   * cannot escalate its own privileges.
   */
  allowWrites?: boolean;
}

/**
 * Executes every resolved row and accounts for every input row.
 *
 * **The tally is asserted, not computed and hoped for.** A denominator that
 * quietly shrinks is the oldest reporting bug there is: drop refusals and 470
 * rows with 60 refusals reports "410 read, 410 passed, 100%" — arithmetically
 * consistent, reads as success, and a lie about sixty rows.
 */
export async function executeAuthoredRows(options: ExecuteOptions): Promise<AuthoredRunResult> {
  const allowWrites = options.allowWrites ?? false;
  const results: RowResult[] = [];

  for (const row of options.unreadable) {
    const described = describeUnreadableRow(row);
    results.push({
      rowId: `sheet row ${row.sheetRow}`,
      scenarioId: '',
      testCaseId: '',
      sheetRow: row.sheetRow,
      title: 'unidentified row',
      status: 'unreadable',
      owner: OWNER_OF.unreadable,
      detail: described.message,
      recoverable: described.actionable,
      ...(row.orphanedContent ? { orphanedContent: row.orphanedContent } : {}),
    });
  }

  for (const row of options.resolved) {
    const common = {
      rowId: row.rowId,
      scenarioId: row.scenarioId,
      testCaseId: row.testCaseId,
      sheetRow: row.sheetRow,
      title: row.title,
    };

    // Write risk gates EXECUTION, not just classification (§9.4). Held is a
    // reported outcome with its reason, never a silent omission.
    if (row.writeRisk === 'creates-data' && !allowWrites) {
      results.push({
        ...common,
        status: 'held',
        owner: OWNER_OF.held,
        detail:
          'held: this row would create, modify or delete data, and ALLOW_WRITES is not set. ' +
          'Nothing was run.',
      });
      continue;
    }

    if (row.outcome === 'row-unclear') {
      results.push({
        ...common,
        status: 'refused',
        owner: OWNER_OF.refused,
        detail: row.refusals.map((refusal) => refusal.reason).join('; ') || row.summary,
      });
      continue;
    }

    // Grounding is PRE-FLIGHT, not the verdict (§9.3). A row the capture
    // disagrees with, or cannot answer, is still executed: the capture says
    // what could be checked in advance, the running application decides.
    const preflight =
      row.outcome === 'app-disagrees'
        ? `the capture predicted this would fail — ${row.summary}`
        : row.outcome === 'capture-thin'
          ? `the capture could not check this in advance — ${row.summary}`
          : undefined;

    let ok = true;
    const details: string[] = [];
    for (const step of row.steps) {
      const outcome = await options.execute({ rowId: row.rowId, step });
      details.push(outcome.detail);
      if (!outcome.ok) {
        ok = false;
        break;
      }
    }

    results.push({
      ...common,
      status: ok ? 'passed' : 'failed',
      owner: ok ? OWNER_OF.passed : OWNER_OF.failed,
      detail: details.join(' | ') || 'no steps to run',
      ...(preflight ? { preflight } : {}),
    });
  }

  const tally: RunTally = {
    rowsRead: options.resolved.length + options.unreadable.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    refused: results.filter((r) => r.status === 'refused').length,
    held: results.filter((r) => r.status === 'held').length,
    unreadable: results.filter((r) => r.status === 'unreadable').length,
  };

  assertTallyBalances(tally, results);
  return { results, tally };
}

/**
 * The invariant: rows read = passed + failed + refused + held + unreadable.
 *
 * Exported so a caller can re-check a tally it was handed, and thrown rather
 * than logged: a report whose numbers do not add up is worse than no report,
 * because it is quoted in a meeting and nobody re-derives it.
 */
export function assertTallyBalances(tally: RunTally, results: RowResult[]): void {
  const counted = tally.passed + tally.failed + tally.refused + tally.held + tally.unreadable;
  if (counted !== tally.rowsRead) {
    throw new Error(
      `the run does not balance: ${tally.rowsRead} row(s) read but ${counted} accounted for ` +
        `(passed ${tally.passed}, failed ${tally.failed}, refused ${tally.refused}, ` +
        `held ${tally.held}, unreadable ${tally.unreadable}). ` +
        'A refused row is not a pass, a held row is not a pass, and an unreadable row is not nothing.',
    );
  }
  if (results.length !== tally.rowsRead) {
    throw new Error(
      `the run does not balance: ${tally.rowsRead} row(s) read but ${results.length} result(s) produced.`,
    );
  }
  const ids = results.map((r) => `${r.rowId}#${r.sheetRow}`);
  if (new Set(ids).size !== ids.length) {
    throw new Error('the run counted a row twice: duplicate row identities in the results.');
  }
}
