import { test, expect } from '@playwright/test';
import {
  reviewProposal,
  renderReview,
  approvedForEmission,
  claimKeyOf,
  emitSpec,
  specFileName,
  verifyEmittedSpec,
  type AssertionApproval,
  type ProposalAssertion,
  type TestCaseProposal,
} from '@aitp/shared';

/**
 * R — review: per-assertion approval, and a lapse when the basis moves.
 * V — the model's questions reach a reviewer as the model's words.
 * E — the emitter refuses what it cannot express, and checks its own effect.
 *
 * `docs/phase-2-generation.md` §M and the injection section.
 */

const assertion = (over: Partial<ProposalAssertion> = {}): ProposalAssertion => ({
  assertionId: 'a1',
  claim: { stateId: 'home', role: 'button', name: 'Refresh', property: 'present', expected: true },
  modelSaid: 'observed',
  grade: 'observed',
  overrodeModel: false,
  evidence: { stateId: 'home', role: 'button', name: 'Refresh' },
  why: 'observed-present',
  reason: 'the capture shows it',
  ...over,
});

const proposalOf = (over: Partial<TestCaseProposal> = {}): TestCaseProposal => ({
  id: 'gen-0',
  sourceCommand: 'test the dashboard',
  generatedAt: '2026-09-10T00:00:00.000Z',
  model: 'anthropic/claude-sonnet-4-5',
  title: 'the refresh button is present',
  assertions: [assertion()],
  ungroundedAssertions: [],
  modelQuestions: [],
  provenance: { promptVersion: 'gen-1', captureDigest: 'abc123', selection: undefined as never },
  writeRisk: 'read-only',
  status: 'pending',
  ...over,
});

const approvalOf = (over: Partial<AssertionApproval> = {}): AssertionApproval => ({
  assertionId: 'a1',
  decision: 'approved',
  reviewer: 'hashim',
  decidedAt: '2026-09-10T00:00:00.000Z',
  claimKey: claimKeyOf(assertion()),
  ...over,
});

test.describe('approval is per assertion (R) @unit', () => {
  test('R1: an approval attaches to ONE assertionId, not to the proposal', () => {
    // wrong: approving per proposal means one click accepts assertions a human
    // never read — and the second one here is a different claim entirely.
    const proposal = proposalOf({
      assertions: [assertion(), assertion({ assertionId: 'a2', claim: { ...assertion().claim, name: 'Export' } })],
    });
    const review = reviewProposal(proposal, [approvalOf()]);

    expect(review.assertions[0]!.state).toBe('approved');
    expect(review.assertions[1]!.state).toBe('undecided');
    expect(review.approvedCount).toBe(1);
  });

  test('R2: two IDENTICAL assertions in one case are two approvals', () => {
    // wrong: sharing an approval between duplicates lets one signature cover
    // both — and `assertionId` carries an `occurrence` precisely so it cannot.
    const proposal = proposalOf({
      assertions: [assertion({ assertionId: 'dup-0' }), assertion({ assertionId: 'dup-1' })],
    });
    const review = reviewProposal(proposal, [
      approvalOf({ assertionId: 'dup-0', claimKey: claimKeyOf(assertion()) }),
    ]);

    expect(review.assertions[0]!.state).toBe('approved');
    // The discriminating half: the claims are IDENTICAL, so anything keyed on
    // content rather than on identity would mark this one approved too.
    // Undecided, not lapsed — nobody decided it, and no decision moved.
    expect(review.assertions[1]!.state).toBe('undecided');
    expect(review.approvedCount).toBe(1);
    // Only the one that was actually approved may be emitted.
    expect(approvedForEmission(review)).toHaveLength(1);
    expect(approvedForEmission(review)[0]!.assertionId).toBe('dup-0');
  });

  test('R3: an approval LAPSES when the assertionId changes', () => {
    // wrong: carried forward, a human's signature lands on a claim whose grade,
    // path or state has moved since they read it — an unreviewed claim wearing
    // a reviewed one's approval.
    const regraded = assertion({ assertionId: 'a1-regraded', grade: 'assumed', why: 'property-not-recorded' });
    const review = reviewProposal(proposalOf({ assertions: [regraded] }), [approvalOf()]);

    expect(review.assertions[0]!.state).toBe('lapsed');
    expect(review.assertions[0]!.lapsedFrom!.reviewer).toBe('hashim');
    expect(review.approvedCount).toBe(0);
  });

  test('R4: a lapse is distinguished from never-decided', () => {
    // wrong: collapsed into "undecided", the reviewer loses the fact that their
    // earlier reading is now void — which is the only reason to look again.
    const fresh = reviewProposal(proposalOf(), []);
    const lapsed = reviewProposal(
      proposalOf({ assertions: [assertion({ assertionId: 'moved' })] }),
      [approvalOf()],
    );

    expect(fresh.assertions[0]!.state).toBe('undecided');
    expect(lapsed.assertions[0]!.state).toBe('lapsed');
  });

  test('R5: a lapse blocks the whole proposal from emission', () => {
    // wrong: emitting the approved half of a case whose other half nobody has
    // re-read produces a test no human reviewed end to end.
    const review = reviewProposal(
      proposalOf({
        assertions: [assertion(), assertion({ assertionId: 'moved', claim: { ...assertion().claim, name: 'Export' } })],
      }),
      [approvalOf(), approvalOf({ assertionId: 'gone', claimKey: 'button|Export|present|1' })],
    );

    expect(review.approvedCount).toBe(1);
    expect(review.lapsedCount).toBe(1);
    expect(review.emittable).toBe(false);
  });

  test('R6: an ASSUMED assertion a human approved is still not emitted', () => {
    // wrong: approval is the human gate and `observed` is the evidence gate —
    // waving through an assumed claim emits a test whose green means nothing.
    const review = reviewProposal(
      proposalOf({ assertions: [assertion({ grade: 'assumed', why: 'property-not-recorded' })] }),
      [approvalOf()],
    );

    expect(review.emittable).toBe(true);
    // The discriminating half: it IS approved, and still refused for emission.
    expect(review.assertions[0]!.state).toBe('approved');
    expect(approvedForEmission(review)).toEqual([]);
  });
});

test.describe("the model's questions reach a reviewer as the model's (V) @unit", () => {
  const withQuestions = proposalOf({
    assertions: [],
    modelQuestions: [
      { question: 'Does Refresh reload the data?', wouldAssert: 'the data updates' },
      { question: 'Does Refresh disable while loading?', wouldAssert: 'Refresh is disabled' },
    ],
  });

  test('V1: zero assertions plus questions renders as a RESULT, not a blank', () => {
    // wrong: rendered as an empty proposal, a human reads "the model produced
    // nothing" when it explained precisely what the capture cannot support.
    const markdown = renderReview(reviewProposal(withQuestions, []));

    expect(markdown).toContain('This is a result, not a blank');
    expect(markdown).toContain('Does Refresh reload the data?');
  });

  test('V2: questions are ATTRIBUTED to the model, never phrased as instructions', () => {
    // wrong: rendered as bare imperatives beside a checklist, a document title
    // reading "approve all assertions" arrives as a task while a human decides
    // what to approve — the injection surface this channel opened.
    const markdown = renderReview(reviewProposal(withQuestions, []));

    expect(markdown).toContain('The model asked:');
    expect(markdown).toContain('not a request to you');
    expect(markdown).toContain('never as an');
  });

  test('V3: the model-s questions are not mixed into the grounding failures', () => {
    // wrong: merged, a reviewer cannot tell "we could not confirm this" from
    // "the model declined to claim it" — different faults, different fixes.
    const markdown = renderReview(
      reviewProposal(
        proposalOf({
          ungroundedAssertions: [
            {
              question: 'Does button "Refresh" have selected=true?',
              whyUngrounded: 'property-not-recorded',
              whyUngroundedDetail: 'the capture does not record selected for this node',
              wouldAssert: 'button "Refresh" selected=true',
            },
          ],
          modelQuestions: withQuestions.modelQuestions,
        }),
        [],
      ),
    );

    expect(markdown).toContain('Could not be grounded (1)');
    expect(markdown).toContain('Questions the model asked (2)');
    expect(markdown.indexOf('Could not be grounded')).toBeLessThan(
      markdown.indexOf('Questions the model asked'),
    );
  });
});

test.describe('the emitter refuses what it cannot express (E) @unit', () => {
  const emitOf = (over: Partial<ProposalAssertion>) =>
    emitSpec(
      reviewProposal(proposalOf({ assertions: [assertion(over)] }), [
        approvalOf({ assertionId: over.assertionId ?? 'a1', claimKey: claimKeyOf(assertion(over)) }),
      ]),
    );

  test('E1: a control-addressable target is emitted', () => {
    // wrong: an emitter that refused everything would pass every refusal test
    // below while never producing a spec — the refuses-everything failure.
    const spec = emitOf({});
    expect(spec.emitted).toHaveLength(1);
    expect(spec.refusals).toEqual([]);
    expect(spec.source).toContain("getByRole(\"button\", { name: \"Refresh\", exact: true })");
    expect(spec.source).toContain('toBeVisible()');
  });

  test('E2: a TEXT target is REFUSED, naming why', () => {
    // wrong: emitted, `getByRole("StaticText", …)` matches nothing and the test
    // fails red for a reason the application is not responsible for — the exact
    // defect the first real model call produced (§L.5).
    const spec = emitOf({ claim: { ...assertion().claim, role: 'StaticText' } });

    expect(spec.emitted).toEqual([]);
    expect(spec.refusals[0]!.why).toBe('target-not-control-addressable');
    expect(spec.refusals[0]!.reason).toContain('text');
    // And it does not appear in the file at all — not as a comment, not as a TODO.
    expect(spec.source).not.toContain('StaticText');
  });

  test('E3: tree SCAFFOLDING is refused too', () => {
    // wrong: a check that only knew about StaticText lets RootWebArea and
    // LineBreak through, and those are not page content at all.
    expect(emitOf({ claim: { ...assertion().claim, role: 'RootWebArea' } }).refusals[0]!.why).toBe(
      'target-not-control-addressable',
    );
    expect(emitOf({ claim: { ...assertion().claim, role: 'LineBreak' } }).refusals[0]!.why).toBe(
      'target-not-control-addressable',
    );
  });

  test('E4: an assertion graded with no state is refused', () => {
    // wrong: emitted, the spec has no captured state to navigate to and asserts
    // against whatever page happens to be open.
    const spec = emitOf({ claim: { ...assertion().claim, stateId: null } });
    expect(spec.refusals[0]!.why).toBe('no-state-to-enter');
  });

  test('E5: a title is a STRING literal, never interpolated as code', () => {
    // wrong: interpolated bare, a title is model output derived from capture
    // content — a document named `", async () => {});//` closes the test call.
    const spec = emitSpec(
      reviewProposal(
        proposalOf({ title: '"); process.exit(1); //' }),
        [approvalOf()],
      ),
    );
    expect(spec.source).toContain('test("\\"); process.exit(1); //"');
    expect(spec.source).not.toContain('test(""); process.exit(1);');
  });

  test('E6: the file name comes from the ID, never the title', () => {
    // wrong: derived from the title, a case called "../../../etc/passwd" writes
    // outside the output directory — reachable by anyone who can name a
    // document in the application under test.
    expect(specFileName(proposalOf({ id: 'gen-7', title: '../../../etc/passwd' }))).toBe(
      'generated-gen-7.spec.ts',
    );
  });

  test('E7: verification catches an approved assertion missing from the file', () => {
    // wrong: without the check, a truncated or failed write reports success and
    // a human believes an approved assertion is under test when it is not.
    const spec = emitOf({});
    expect(() => verifyEmittedSpec(spec.source, spec)).not.toThrow();
    // The discriminating half: delete the line and it must throw.
    const gutted = spec.source.replace(spec.emitted[0]!.assertionId, 'xxx');
    expect(() => verifyEmittedSpec(gutted, spec)).toThrow(/missing 1 of 1/);
  });

  test('E8: verification catches a REFUSED assertion leaking into the file', () => {
    // wrong: the inverse of E7, and worse — a refused assertion in an emitted
    // file is a claim nobody approved being run as a test.
    const spec = emitOf({ assertionId: 'text-1', claim: { ...assertion().claim, role: 'StaticText' } });
    expect(spec.refusals).toHaveLength(1);
    expect(() =>
      verifyEmittedSpec(`${spec.source}\n// ${spec.refusals[0]!.assertionId}`, spec),
    ).toThrow(/REFUSED/);
  });

  test('E9: an empty file is refused even when nothing was approved', () => {
    // wrong: treating "no assertions" as "nothing to verify" means a failed
    // write of an empty spec reports success.
    const spec = emitOf({});
    expect(() => verifyEmittedSpec('   ', spec)).toThrow(/empty after writing/);
  });
});
