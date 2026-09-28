import { test, expect } from '@playwright/test';
import {
  executeAuthoredRows,
  resolveAuthoredRow,
  renderTriage,
  triageSheet,
  unsupportedActionVerb,
  TRIAGE_OWNER,
  type AuthoredRow,
  type BoundedCapture,
  type EntryControl,
  type StepExecutor,
} from '@aitp/shared';

/**
 * A file-upload clause is REFUSED, not clicked (2026-09-28).
 *
 * `upload` is in `ACTION_VERBS`, so such a clause becomes a normal action step —
 * and an action step carries only a description, with nowhere to put a file. The
 * executor therefore clicks whatever target resolved and returns `passed`. The
 * vacuous-pass guard in `execute.ts` cannot catch it: that guard fires only for
 * `assert` steps with an empty `observed`, and this is an action with a plausible
 * one (`clicked button "Attach"`).
 *
 * ## The reachable case is NOT the word "upload", which is the measured surprise
 *
 * Measured at the previous commit, same fixture, one word changed:
 *
 * | clause                       | status   | clicks                |
 * | ---------------------------- | -------- | --------------------- |
 * | `uploads "Attach"`           | `held`   | none                  |
 * | `attaches "Attach"`          | `passed` | `button "Attach"`     |
 * | `User attaches "Attach"`     | `passed` | `button "Attach"`     |
 *
 * `upload` is also in `WRITE_WORDS`, and the held gate runs BEFORE the refused
 * gate, so an "uploads" row was already stopped by a check written for a
 * different reason. `attach` and `browse` are in no write list, so those were the
 * clauses that actually came back green having clicked a button and uploaded
 * nothing.
 *
 * That makes the `attaches?`/`browses?` entries in the verb list the load-bearing
 * ones, and the `uploads?` entry a belt on top of a brace that already holds —
 * worth having, because `ALLOW_WRITES` existing at all means the hold is a policy
 * flag rather than a guarantee.
 *
 * Nothing here ADDS upload support. It replaces a false pass with a refusal that
 * names the gap.
 *
 * **No compile-level control exists for this, measured rather than assumed:**
 * adding a member to `RefusalReason` produces 0 `tsc` errors, because nothing is
 * keyed by that union — the same shape as `Owner`. So every control below is
 * behavioural, and this file says so rather than implying a guarantee the type
 * system does not give.
 */

const CAPTURE: BoundedCapture = {
  sessionId: 's',
  states: [
    {
      id: 'upload',
      label: 'upload',
      url: 'https://app.example/upload',
      nodes: [
        { role: 'button', name: 'Attach', enabled: true },
        { role: 'button', name: 'Save', enabled: true },
        { role: 'heading', name: 'Done', enabled: true },
      ],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/**
 * One row, one action clause, one checkable assertion.
 *
 * `id` is a parameter because the run REFUSES a duplicate composite identity
 * outright — two fixtures sharing a `rowId` fail on that instead of on the
 * property under test, which is the run being right and the fixture being wrong.
 */
const rowWith = (whenText: string, id: string): AuthoredRow =>
  ({
    rowId: `${id} / TC_1`,
    scenarioId: id,
    testCaseId: 'TC_1',
    sheetRow: 3,
    module: 'Bulk upload',
    feature: '',
    // NOT 'the upload row': assessWriteRisk reads the TITLE as well as the
    // steps, so a title containing a write word held every row in this file and
    // the refusal could never be observed. The fixture was manufacturing the
    // gate it was supposed to be testing around.
    scenarioName: 'the clause under test',
    objective: '',
    testType: '',
    priority: '',
    preconditions: '',
    testData: '',
    type: '',
    clauses: [
      { text: whenText, source: 'when', kind: 'action' },
      { text: 'verify the "Done" heading is present', source: 'then', kind: 'assert' },
    ],
  }) as AuthoredRow;

/** Records every click the executor attempts, so "no click" is checkable. */
const clickRecorder = (): { clicks: string[]; execute: StepExecutor } => {
  const clicks: string[] = [];
  const execute: StepExecutor = async ({ step, target }) => {
    if (!target) return { kind: 'no-observable-check', observed: '' };
    if (step.kind === 'action') {
      clicks.push(`${target.role} "${target.name}"`);
      return { kind: 'passed', observed: `clicked ${target.role} "${target.name}"` };
    }
    return { kind: 'passed', observed: `${target.role} "${target.name}" present=true` };
  };
  return { clicks, execute };
};

const entry: EntryControl = {
  moduleOf: () => 'Bulk upload',
  verify: async () => ({ verified: true }),
};

test.describe('a file-upload clause is refused rather than clicked @unit', () => {
  test('U1: the verb is recognised through the sheet’s own subject prefix', () => {
    // wrong: the check tests position 0, so "User attaches the file" — which is
    // how the real sheet writes every clause (measured: requiring the verb at
    // position 0 left 217 of 513 And-clauses unclassified) — is not recognised,
    // and the false pass survives for exactly the sentences that occur.
    expect(unsupportedActionVerb('uploads the document')).toBe('uploads');
    expect(unsupportedActionVerb('User uploads the document')).toBe('uploads');
    expect(unsupportedActionVerb('the user attaches a file')).toBe('attaches');
    expect(unsupportedActionVerb('browses for a file')).toBe('browses');
    // The other half of the same function: a normal action is NOT swept up.
    expect(unsupportedActionVerb('clicks the Save button')).toBeUndefined();
    expect(unsupportedActionVerb('User clicks on "Save"')).toBeUndefined();
  });

  test('U2: an ATTACH clause whose target resolves is refused, and nothing is clicked', async () => {
    // wrong: this is the false pass itself, and it was measured at the previous
    // commit — `passed`, with `clicks=[button "Attach"]`. A QA reads a green row
    // and an evidence line saying a button was clicked, for a step that was
    // supposed to put a file somewhere.
    const resolved = resolveAuthoredRow(
      rowWith('User attaches "Attach"', 'AT_1'),
      CAPTURE,
      'upload',
    );

    expect(resolved.outcome).toBe('row-unclear');
    expect(resolved.refusals.map((r) => r.why)).toContain('action-not-supported');
    expect(resolved.refusals.map((r) => r.reason).join(' ')).toContain(
      'file upload is not supported yet — the step would click without selecting a file',
    );
    // Refused at RESOLVE, so the row carries no runnable step at all — a check
    // inside the executor would already be holding a page.
    expect(resolved.steps).toEqual([]);

    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });

    expect(run.results[0]!.status).toBe('refused');
    expect(clicks, 'a click was attempted for an unsupported action').toEqual([]);
  });

  test('U3: an UPLOAD clause is stopped by the write gate FIRST, and that is pinned on purpose', async () => {
    // wrong: someone reads "upload is refused now" and relaxes the hold, or
    // `ALLOW_WRITES` is set for an unrelated reason — and the false pass returns
    // through a door nobody was watching. The refusal still exists underneath;
    // this records which of the two actually stops the row today.
    const resolved = resolveAuthoredRow(rowWith('uploads "Attach"', 'UP_1'), CAPTURE, 'upload');

    expect(resolved.writeRisk).toBe('creates-data');
    expect(resolved.refusals.map((r) => r.why)).toContain('action-not-supported');

    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });

    // `held` wins because that gate runs before the refused one. Either way, no
    // click — which is the property that matters.
    expect(run.results[0]!.status).toBe('held');
    expect(clicks).toEqual([]);
  });

  test('U4 (discriminating): a NORMAL action still runs and still passes', async () => {
    // wrong: the refusal is written on the clause KIND rather than the verb, so
    // every action clause is refused, the platform stops doing anything at all,
    // and the change still reads as safe because nothing false ever passes again.
    const resolved = resolveAuthoredRow(rowWith('clicks on "Attach"', 'OK_1'), CAPTURE, 'upload');

    expect(resolved.outcome).not.toBe('row-unclear');
    expect(resolved.refusals).toEqual([]);

    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });

    expect(run.results[0]!.status).toBe('passed');
    expect(clicks).toEqual(['button "Attach"']);
  });

  test('U5: the refused row lands in the refused bucket and the tally still balances', async () => {
    // wrong: the new refusal is produced but counted nowhere, so `rowsRead` no
    // longer equals the buckets — and E2's arithmetic is the only thing that
    // would say so. A row missing from the tally is a row nobody reads.
    const refusedRow = resolveAuthoredRow(
      rowWith('User attaches "Attach"', 'AT_2'),
      CAPTURE,
      'upload',
    );
    const passingRow = resolveAuthoredRow(rowWith('clicks on "Attach"', 'OK_2'), CAPTURE, 'upload');

    const { execute } = clickRecorder();
    const run = await executeAuthoredRows({
      resolved: [refusedRow, passingRow],
      unreadable: [],
      execute,
      entry,
    });

    expect(run.tally.rowsRead).toBe(2);
    expect(run.tally.refused).toBe(1);
    expect(run.tally.passed).toBe(1);

    const buckets = Object.entries(run.tally)
      .filter(([key]) => key !== 'rowsRead')
      .reduce((sum, [, value]) => sum + value, 0);
    expect(buckets, 'the buckets do not sum to rowsRead').toBe(run.tally.rowsRead);
  });
});

/**
 * TRIAGE AND THE RUN MUST AGREE — the claim this pair of commits exists for.
 *
 * `classifyByClauses`'s own comment says counting a row automatable "would
 * promise a row the run then refuses". It had exactly that hole: an `attaches`
 * row was `automatable` in the ceiling and `refused` in the run, so the report's
 * headline number included work the platform declines to do. Measured before the
 * fix: `automatable: 2` for two rows, one of which the run refuses.
 *
 * Both sides now ask the SAME predicate — `unsupportedActionVerb`, imported, not
 * restated. Two verb lists drift, and a drifted list reads like a correct one.
 */
test.describe('triage and the run give the same answer @unit', () => {
  const triageOf = (when: string, id: string) =>
    triageSheet([rowWith(when, id)], new Set(['Bulk upload'])).rows[0]!;

  const runOf = async (when: string, id: string) => {
    const resolved = resolveAuthoredRow(rowWith(when, id), CAPTURE, 'upload');
    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });
    return { status: run.results[0]!.status, clicks };
  };

  test('T1: an unsupported action is refused by BOTH, and owned by the platform', async () => {
    // wrong: triage says automatable and the run says refused — the ceiling then
    // counts work nobody will do, and it is the number that gets quoted.
    const triaged = triageOf('User attaches "Attach"', 'AG_1');
    const { status, clicks } = await runOf('User attaches "Attach"', 'AG_2');

    expect(triaged.reason).toBe('unsupported-action');
    expect(TRIAGE_OWNER[triaged.reason]).toBe('platform');
    expect(status).toBe('refused');
    expect(clicks).toEqual([]);
  });

  test('T2 (discriminating): a supported action is accepted by BOTH', async () => {
    // wrong: agreement is achieved by refusing everything, which agrees
    // perfectly and automates nothing — the refuses-everything failure. This is
    // the case that must come out the OTHER way.
    const triaged = triageOf('clicks on "Attach"', 'AG_3');
    const { status, clicks } = await runOf('clicks on "Attach"', 'AG_4');

    expect(triaged.reason).toBe('automatable');
    expect(status).toBe('passed');
    expect(clicks).toEqual(['button "Attach"']);
  });

  test('T3: the report names the owner, so the map is read rather than carried', () => {
    // wrong: TRIAGE_OWNER is populated and consulted by nothing — the OWNER_OF
    // mistake, where adding a member compiles clean and a wrong entry is
    // invisible because no output ever shows it.
    const triage = triageSheet(
      [rowWith('User attaches "Attach"', 'AG_5'), rowWith('clicks on "Attach"', 'AG_6')],
      new Set(['Bulk upload']),
    );
    const markdown = renderTriage(triage);

    expect(markdown).toContain('An action the platform cannot perform yet (1)');
    expect(markdown).toContain('_Owner: platform._');
  });
});
