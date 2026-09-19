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

export type RowStatus =
  | 'passed'
  | 'failed'
  | 'refused'
  | 'held'
  | 'unreadable'
  /**
   * Resolved cleanly against the capture, but the target is not on the live
   * page. Neither an app failure nor a bad row: the CAPTURE IS STALE.
   *
   * Its own status because collapsing it into `failed` sends the app team
   * hunting for a bug that does not exist — the same category error §3 exists
   * to prevent, arriving where the pre-flight grades could not see it, since
   * grounding said the element was there and in the capture it WAS.
   */
  | 'stale-capture'
  /**
   * The run could not put the page in the state the row starts from, so the
   * row never ran. Not the app's fault, not the row's, and not the capture's.
   *
   * Its own status because the alternative is the DEMO_4 mistake: with no way
   * to say "we never got there", a target missing from the WRONG SCREEN was
   * reported `stale-capture` — "re-run `pnpm inspect`" — about a capture that
   * was perfectly current (§11.4's correction).
   */
  | 'given-not-reached';

/**
 * NOT YET EMITTED (2026-09-19)
 *
 * **Nothing produces `given-not-reached`, and nothing produces a `reason`.**
 * `executeAuthoredRows` decides a status from step outcomes, and a step only
 * runs once the entry state is already established — so this status is decided
 * BEFORE it, by a verifier that does not exist yet.
 *
 * | what          | who will emit it                                     |
 * | ------------- | ---------------------------------------------------- |
 * | the status    | 4d's entry verifier, before any step runs            |
 * | the reason    | the verification stage that stopped: auth, the route, |
 * |               | the module map, or the `provenBy` assertion           |
 *
 * Written down rather than left implicit, in the `NOT_YET_COVERED` style: a
 * status the accounting can carry but nothing can produce reads like coverage.
 * **This entry is deleted when 4d lands** — and the tally, the report section
 * and the tests below already hold the shape it will arrive in.
 */

/**
 * WHICH verification step failed, for a `given-not-reached` row.
 *
 * Comes from the step that failed, never from a guess: 4d establishes the entry
 * state in these stages and reports the one that stopped it.
 */
export type EntryFailure =
  /** Signing in did not succeed. Credentials come from the environment. */
  | 'auth'
  /** The run could not get to the module's route. */
  | 'navigation'
  /** The sheet's module has no entry in the module map. */
  | 'mapping'
  /** The route opened, and the map's `provenBy` element was not on it. */
  | 'state-assert';

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
  // Re-run `pnpm inspect`. Not the app team's problem and not the QA's.
  'stale-capture': 'capture',
  // Auth, a route, a mapping or the state assertion — the run's own setup.
  'given-not-reached': 'environment',
};

interface RowResultFields {
  /** Always the composite. Never the Test Case ID alone — see §9.1. */
  rowId: string;
  scenarioId: string;
  testCaseId: string;
  sheetRow: number;
  title: string;
  owner: Owner;
  detail: string;
  /** What the capture predicted before the run. Context, never a verdict. */
  preflight?: string;
  /** For an unreadable row that a QA can recover — see §2d. */
  recoverable?: boolean;
  orphanedContent?: string[];
  /** What each step actually observed. Positive evidence, not silence. */
  observed?: string[];
  /** Present on every row that RAN and did not pass. Paths, never contents. */
  evidence?: RowEvidence;
  /**
   * Healing's suggestion, recorded for a human. **Never consulted by any status
   * decision** — that separation is what stops a proposal becoming a verdict.
   */
  healingProposal?: string;
}

/**
 * A row's result, with `reason` BOUND to the status that has one.
 *
 * A discriminated union rather than one more optional field, because an
 * optional `reason` can be wrong in both directions: a `passed` row could carry
 * "auth", and a `given-not-reached` row could carry nothing. Here the compiler
 * requires it on exactly one status and forbids it on every other, so neither
 * shape can be written at all.
 */
export type RowResult =
  | (RowResultFields & {
      status: Exclude<RowStatus, 'given-not-reached'>;
      /** Only `given-not-reached` has one. `never` makes that a compile error. */
      reason?: never;
    })
  | (RowResultFields & {
      status: 'given-not-reached';
      /** Required: an entry failure nobody can act on is the DEMO_4 report. */
      reason: EntryFailure;
    });

/**
 * Each status's bucket in the tally — the ONE list of buckets.
 *
 * Everything that counts, sums, prints or checks the buckets iterates this, and
 * `RunTally` is derived from it below. The compiler then holds both directions:
 *
 * - a status with no bucket does not compile (`satisfies Record<RowStatus, …>`);
 * - a bucket for a status that does not exist does not compile (excess property);
 * - a tally field with no status cannot exist, because the fields ARE these values.
 *
 * It replaced hand-written lists. Two of them — E2's sum and E3's status list —
 * had already silently left out `stale-capture`, and both still passed.
 */
export const TALLY_BUCKET = {
  passed: 'passed',
  failed: 'failed',
  refused: 'refused',
  held: 'held',
  unreadable: 'unreadable',
  'stale-capture': 'staleCapture',
  'given-not-reached': 'givenNotReached',
} as const satisfies Record<RowStatus, string>;

export type TallyBucket = (typeof TALLY_BUCKET)[RowStatus];

export type RunTally = { rowsRead: number } & Record<TallyBucket, number>;

/** `TALLY_BUCKET` as typed pairs, in its declared order. */
export const tallyBuckets = (): Array<[RowStatus, TallyBucket]> =>
  Object.entries(TALLY_BUCKET) as Array<[RowStatus, TallyBucket]>;

export interface AuthoredRunResult {
  results: RowResult[];
  tally: RunTally;
}

/**
 * Evidence for a row that did not pass.
 *
 * **Paths only, never contents.** A trace holds a live session token and
 * document titles from the instance, so the report references it and never
 * inlines it — no base64, no embedded image, no pasted network log. Finding 16's
 * instruction ("request these through the QA team rather than by email") is the
 * standing rule here, not a one-off.
 */
export interface RowEvidence {
  screenshot?: string;
  trace?: string;
  /** The clause that did not pass, verbatim. Always present. */
  failingClause: string;
}

/**
 * What running one step actually produced.
 *
 * Four kinds, because a live page fails in more ways than a boolean can carry —
 * and two of them are not app failures at all.
 */
export type StepOutcomeKind =
  | 'passed'
  | 'failed'
  /** The element is not on the live page. The CAPTURE is stale (§10.1). */
  | 'target-not-on-page'
  /** The clause resolves to nothing checkable. A refusal, never a quiet pass. */
  | 'no-observable-check';

export interface StepOutcome {
  kind: StepOutcomeKind;
  /**
   * What was actually OBSERVED — positive evidence, not the absence of an
   * error. "Then: the dashboard appears" is satisfied by seeing the dashboard,
   * and an executor that returns pass because nothing threw has a criterion
   * satisfied by knowing nothing (§10.3).
   */
  observed: string;
  /**
   * Healing's suggestion when a target is missing. **Recorded, never acted on.**
   *
   * Kept out of every status decision below: a sheet row saying "click the
   * Approve button" that quietly passes against "Approve Request" tells a QA
   * their case passed when the thing they wrote about was never clicked, and a
   * wrong pass is worse than a failure because a failure gets investigated.
   */
  healingProposal?: string;
  evidence?: Partial<RowEvidence>;
}

/** Runs one resolved step. The browser lives behind this, not in the accounting. */
export type StepExecutor = (input: {
  rowId: string;
  step: CaseStep;
  /** The target the RESOLVER chose. Never re-derived from the prose (§10.0). */
  target?: { role: string; name: string };
}) => Promise<StepOutcome>;

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

    const observations: string[] = [];
    let stopped: { outcome: StepOutcome; step: CaseStep } | undefined;

    for (const [stepIndex, step] of row.steps.entries()) {
      const target = row.targets?.find((entry) => entry.stepIndex === stepIndex);
      const outcome = await options.execute({
        rowId: row.rowId,
        step,
        ...(target ? { target: { role: target.role, name: target.name } } : {}),
      });
      observations.push(outcome.observed || '(nothing observed)');

      // An ASSERTION that "passed" while observing nothing has not been
      // checked — it has been assumed. Positive evidence or it is a refusal.
      const vacuous =
        outcome.kind === 'passed' && step.kind === 'assert' && outcome.observed.trim() === '';

      if (outcome.kind !== 'passed' || vacuous) {
        stopped = {
          outcome: vacuous ? { ...outcome, kind: 'no-observable-check' } : outcome,
          step,
        };
        break;
      }
    }

    if (!stopped) {
      results.push({
        ...common,
        status: 'passed',
        owner: OWNER_OF.passed,
        detail: observations.join(' | ') || 'no steps to run',
        observed: observations,
        ...(preflight ? { preflight } : {}),
      });
      continue;
    }

    // The status comes from the outcome KIND alone. `healingProposal` is
    // deliberately not read here: a proposal is a suggestion for a human and
    // must never move a verdict (§10.2).
    // Narrower than RowStatus on purpose: a STEP outcome can never be
    // `given-not-reached`, which is decided before any step runs. The type says
    // so, so this path cannot start producing one by accident.
    const status: Exclude<RowStatus, 'given-not-reached'> =
      stopped.outcome.kind === 'target-not-on-page'
        ? 'stale-capture'
        : stopped.outcome.kind === 'no-observable-check'
          ? 'refused'
          : 'failed';

    const clause =
      stopped.step.kind === 'action'
        ? stopped.step.description
        : `${stopped.step.role} "${stopped.step.name}" ${stopped.step.property}=${stopped.step.expected}`;

    results.push({
      ...common,
      status,
      owner: OWNER_OF[status],
      detail:
        stopped.outcome.kind === 'no-observable-check'
          ? `nothing observable to check for "${clause}" — this clause cannot be verified as written`
          : `${observations.join(' | ')}`,
      observed: observations,
      // Every row that RAN and did not pass carries its evidence, and the
      // failing clause is always present even when the executor supplied none.
      evidence: { ...stopped.outcome.evidence, failingClause: clause },
      ...(stopped.outcome.healingProposal
        ? { healingProposal: stopped.outcome.healingProposal }
        : {}),
      ...(preflight ? { preflight } : {}),
    });
  }

  // `rowsRead` comes from the INPUTS, never from `results.length`, and each
  // bucket counts its own status — so a row that landed nowhere shows up as an
  // imbalance instead of being absorbed.
  const counts = Object.fromEntries(
    tallyBuckets().map(([status, bucket]) => [
      bucket,
      results.filter((r) => r.status === status).length,
    ]),
  ) as Record<TallyBucket, number>;
  const tally: RunTally = {
    rowsRead: options.resolved.length + options.unreadable.length,
    ...counts,
  };

  assertTallyBalances(tally, results);
  return { results, tally };
}

/**
 * The invariant: rows read = the sum of EVERY bucket in `TALLY_BUCKET`.
 *
 * Exported so a caller can re-check a tally it was handed, and thrown rather
 * than logged: a report whose numbers do not add up is worse than no report,
 * because it is quoted in a meeting and nobody re-derives it. A handed tally
 * missing a bucket sums to NaN, which cannot equal `rowsRead`, so it throws too.
 */
export function assertTallyBalances(tally: RunTally, results: RowResult[]): void {
  const counted = tallyBuckets().reduce((sum, [, bucket]) => sum + tally[bucket], 0);
  if (counted !== tally.rowsRead) {
    const breakdown = tallyBuckets()
      .map(([status, bucket]) => `${status} ${tally[bucket]}`)
      .join(', ');
    throw new Error(
      `the run does not balance: ${tally.rowsRead} row(s) read but ${counted} accounted for ` +
        `(${breakdown}). ` +
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
