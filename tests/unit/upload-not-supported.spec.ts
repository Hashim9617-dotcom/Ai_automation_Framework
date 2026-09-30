import { test, expect } from '@playwright/test';
import {
  executeAuthoredRows,
  resolveAuthoredRow,
  renderTriage,
  triageSheet,
  actionCapability,
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
        /**
         * A GENUINELY READ-ONLY control, and its absence broke five tests.
         *
         * `Attach` was this file's read-only control — `clicks on "Attach"` was the
         * discriminating case proving the platform still runs normal actions. Once
         * `attach` became a WRITE word (3a-9 rule D), that clause is HELD, which is
         * correct: clicking Attach opens a file picker. So the control had to move
         * to a name that writes nothing.
         */
        { role: 'button', name: 'View', enabled: true },
        { role: 'button', name: 'Save', enabled: true },
        { role: 'heading', name: 'Done', enabled: true },
        { role: 'textbox', name: 'First name', enabled: true },
        // A control named `Jane` — the VALUE a fill clause carries, not a
        // control anybody would write a step about. It is here deliberately, and
        // it is what makes W2 below discriminating: without it a fill clause is
        // refused because nothing matched, which proves nothing about the verb.
        // Real pages supply this by accident all the time — an option, a table
        // row, a filter chip, a tag.
        { role: 'option', name: 'Jane', enabled: true },
        // §W's own clause needs its target. `Save` above is not it: the write
        // gate reads the whole step text, and a target named `Save employee` is
        // what the clause §W names actually points at.
        { role: 'button', name: 'Save employee', enabled: true },
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
const rowWith = (whenText: string, id: string): AuthoredRow => ({
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
});

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
    expect(actionCapability('uploads the document')).toEqual({
      performable: false,
      verb: 'uploads',
    });
    expect(actionCapability('User uploads the document')).toEqual({
      performable: false,
      verb: 'uploads',
    });
    expect(actionCapability('the user attaches a file')).toEqual({
      performable: false,
      verb: 'attaches',
    });
    expect(actionCapability('browses for a file')).toEqual({
      performable: false,
      verb: 'browses',
    });
    // The other half of the same function: a normal action is NOT swept up.
    expect(actionCapability('clicks the Save button')).toEqual({ performable: true });
    expect(actionCapability('User clicks on "Save"')).toEqual({ performable: true });
  });

  test('U1b: the FILL family is refused too, because the list is an allowlist', () => {
    // wrong: the list names the verbs it knows about and lets the rest through —
    // fail-OPEN — so `enters`, `types` and `selects` become clicks. Measured
    // 2026-09-29: all three resolved to `option "Jane"` / `option "HR"`, the
    // clause's own VALUE read as an element name, and clicked it for a pass.
    //
    // This test would pass under a denylist the day someone adds these four
    // words. `U1c` below is the one that tests the property rather than the list.
    for (const [clause, verb] of [
      ["user enters 'Jane' in First name", 'enters'],
      ["types 'Jane' into First name", 'types'],
      ["selects 'HR' from Department", 'selects'],
      ['navigates to the dashboard', 'navigates'],
    ] as const) {
      expect(actionCapability(clause), clause).toEqual({ performable: false, verb });
    }

    // Still the other half: the whole click family passes through, past tense
    // included — Door A's generated steps read "clicked Save".
    for (const clause of ['taps the tile', 'presses "Enter"', 'Clicking the row', 'clicked Save']) {
      expect(actionCapability(clause), clause).toEqual({ performable: true });
    }

    // THE COST OF THE RULE, PINNED RATHER THAN DISCOVERED LATER.
    //
    // `presses Enter` — unquoted — is refused, because the KEY is called Enter
    // and `enter` is a fill verb. Found by this test failing on it, not by
    // review. It is the same shape as `extractRole` reading "select" out of
    // "Select department": an element's own name is not a description of what is
    // being done to it, and an unquoted name is indistinguishable from prose.
    //
    // Quoting fixes it, which is why this is a documented cost and not a bug:
    // the line above proves `presses "Enter"` runs.
    expect(actionCapability('presses Enter')).toEqual({ performable: false, verb: 'enter' });
  });

  test('U1c: an UNKNOWN verb is refused, which is the whole point of an allowlist', () => {
    // wrong: the list is a denylist, so a verb nobody thought of — and there is
    // always one — passes straight through and becomes a click. `frobnicates
    // "Attach"` then resolves to `button "Attach"` and reports a pass.
    //
    // This is the test a list-shaped test cannot be: the verb below is not in
    // either list and never will be, so it can only come out right if the rule is
    // "must contain a click verb" rather than "must not be one of these".
    expect(actionCapability('User frobnicates "Attach"')).toEqual({ performable: false });

    // And a clause that contains BOTH: performable is not enough on its own,
    // because only the click half would happen and it would report a pass.
    expect(actionCapability('clicks Save and enters Jane')).toEqual({
      performable: false,
      verb: 'enters',
    });

    // The column still decides what a clause IS. "verify by clicking X" is an
    // action the QA labelled as one, and its leading word is an assert verb — a
    // leading-word test refused it, which made this function overrule the person
    // who wrote the sheet.
    expect(actionCapability('verify by clicking "Sign in"')).toEqual({ performable: true });
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
    // The reason NAMES THE VERB. It used to say "file upload is not supported
    // yet" for every unsupported action, which was true of this clause and wrong
    // for `selects 'HR' from Department` — see W3.
    expect(resolved.refusals.map((r) => r.reason).join(' ')).toContain(
      '"attaches" is not an action this platform can perform',
    );
    // Refused at RESOLVE, so the row carries no runnable step at all — a check
    // inside the executor would already be holding a page.
    expect(resolved.steps).toEqual([]);

    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });

    // `refused`, and it STAYED refused through 3a-9 on purpose. The widened write
    // list briefly carried `attach`, which made this row `held` — the write gate
    // runs first — and that traded an informative refusal ("this platform cannot
    // do uploads") for a vaguer hold ("this would write"). The word bought no
    // safety, because the refusal above already stops the row, so it came out.
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
    // `"View"`, not `"Attach"`: `attach` is a WRITE word since 3a-9, so an Attach
    // click is held — correctly, it opens a file picker. This control needs a name
    // that writes nothing, or it stops discriminating and starts agreeing.
    const resolved = resolveAuthoredRow(rowWith('clicks on "View"', 'OK_1'), CAPTURE, 'upload');

    expect(resolved.outcome).not.toBe('row-unclear');
    expect(resolved.refusals).toEqual([]);
    expect(resolved.writeRisk).toBe('read-only');

    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });

    expect(run.results[0]!.status).toBe('passed');
    expect(clicks).toEqual(['button "View"']);
  });

  test('U5: the refused row lands in the refused bucket and the tally still balances', async () => {
    // wrong: the new refusal is produced but counted nowhere, so `rowsRead` no
    // longer equals the buckets — and E2's arithmetic is the only thing that
    // would say so. A row missing from the tally is a row nobody reads.
    // `selects`, not `attaches`: an ATTACH clause is now stopped by the WRITE gate
    // first (see U2), so it lands in the `held` bucket and this test would be
    // measuring that instead. `selects` is unperformable and is not a write word,
    // so the row reaches the refused bucket — which is the bucket under test.
    const refusedRow = resolveAuthoredRow(
      rowWith('User selects "View"', 'AT_2'),
      CAPTURE,
      'upload',
    );
    const passingRow = resolveAuthoredRow(rowWith('clicks on "View"', 'OK_2'), CAPTURE, 'upload');

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
 * Both sides now ask the SAME predicate — `actionCapability`, imported, not
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
    // THE ROLE IS NAMED, and that is the cost of rule B made visible.
    //
    // `clicks on "Attach"` came back `write-risk-unknown`: triage is not given a
    // capture, so it cannot know whether "Attach" is a button or a checkbox, and a
    // checkbox click is a write. Naming the role settles it from the text — which
    // is the incentive the new reason creates, and it is a reasonable one.
    const triaged = triageOf('clicks on the "Attach" button', 'AG_3');
    const { status, clicks } = await runOf('clicks on the "Attach" button', 'AG_4');

    expect(triaged.reason).toBe('automatable');
    expect(status).toBe('passed');
    expect(clicks).toEqual(['button "Attach"']);
  });

  // The title deliberately does NOT quote the clause under test. `CB4` in
  // `tests/api/command-box.spec.ts` asserts that every test matching "test
  // employee registration" has `demo` in its title, to prove the inventory was
  // listed for the right environment — so a UNIT test whose title contains
  // "employee" breaks it. Recorded rather than worked around silently: that
  // assertion couples an environment claim to the global corpus of test titles,
  // and the next person to write one will hit it too.
  test('W1: a click clause passes the allowlist — the WRITE gate is what holds the row', async () => {
    // wrong: the allowlist refuses everything, which stops every false pass and
    // automates nothing — a rule satisfied without knowing anything about the
    // clause. `U4` and `T2` are the plain controls for that; this one is the
    // clause §W names, and it is here because it comes back `held`, which could
    // mean either gate. Separating them is the whole test: the row RESOLVED, so
    // the verb was accepted, and only then was it held for the write.
    //
    // The order matters and is measured here rather than assumed: the write gate
    // runs BEFORE the refusal check in `executeAuthoredRows`, so `held` alone
    // proves nothing about the verb — a fill clause on a write-risky row would
    // also read `held`.
    const clause = 'clicks on "Save employee"';
    expect(actionCapability(clause), 'the allowlist rejected a click').toEqual({
      performable: true,
    });

    const resolved = resolveAuthoredRow(rowWith(clause, 'W_1'), CAPTURE, 'upload');
    expect(resolved.outcome, 'the clause did not resolve at all').not.toBe('row-unclear');
    expect(resolved.refusals).toEqual([]);
    // Both of the fixture's clauses resolved — the action AND the `Then` every
    // `rowWith` row carries. Listed in full rather than filtered, so this cannot
    // pass on a row where only the assertion survived.
    expect(resolved.targets.map((t) => `${t.role} "${t.name}"`)).toEqual([
      'button "Save employee"',
      'heading "Done"',
    ]);

    const { clicks, execute } = clickRecorder();
    const run = await executeAuthoredRows({ resolved: [resolved], unreadable: [], execute, entry });

    expect(run.results[0]!.status).toBe('held');
    expect(run.results[0]!.detail).toContain('ALLOW_WRITES');
    // Held means nothing ran, which is the other half of what `held` claims.
    expect(clicks).toEqual([]);
  });

  test('W2: a FILL clause is refused by both, with the target sitting right there', async () => {
    // wrong: the clause becomes `click option "Jane"` and the row is reported
    // PASSED with nothing typed into anything — measured, at the previous commit,
    // on exactly this capture.
    //
    // The capture holds `option "Jane"`, so this refusal is NOT "nothing matched"
    // — the fixture can reach the false pass, and did.
    const triaged = triageOf("user enters 'Jane' in First name", 'W_3');
    const { status, clicks } = await runOf("user enters 'Jane' in First name", 'W_4');

    expect(triaged.reason).toBe('unsupported-action');
    expect(TRIAGE_OWNER[triaged.reason]).toBe('platform');
    expect(status).toBe('refused');
    expect(clicks).toEqual([]);
  });

  test('W3: the refusal NAMES the verb, and blames the platform not the sentence', async () => {
    // wrong: the reason still says "file upload is not supported", so a QA whose
    // row says `selects 'HR' from Department` is told about uploads. Worse, the
    // pre-allowlist path refused this as `unparseable-step` — "no element could
    // be read out of it" — which blames a sentence that is perfectly clear and
    // sends them to rewrite it.
    const resolved = resolveAuthoredRow(
      rowWith("selects 'HR' from Department", 'W_5'),
      CAPTURE,
      'upload',
    );
    const refusal = resolved.refusals.find((r) => r.why === 'action-not-supported');

    expect(refusal, 'the row was not refused for the action at all').toBeDefined();
    expect(refusal!.reason).toContain('"selects"');
    expect(refusal!.reason).toContain('this platform can perform');
    // Discriminating: it does NOT say the sentence was unreadable.
    expect(refusal!.reason).not.toMatch(/could not be read|unparseable/i);
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
