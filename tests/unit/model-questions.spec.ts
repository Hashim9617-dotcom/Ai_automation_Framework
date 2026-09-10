import { test, expect } from '@playwright/test';
import { GenerationEngine } from '@aitp/ai-engine';
import {
  buildProposal,
  renderGenerationPrompt,
  buildPromptInput,
  dedupeTextAgainstControls,
  affordanceOf,
  type AccessibilityNode,
  type BoundedCapture,
  type CapturedState,
  type InventoryEntry,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmGateway,
} from '@aitp/shared';

/**
 * Q — the model's own questions survive to the record.
 * A — the prompt never offers a candidate the executor cannot address.
 *
 * Both were found by the first real API call (2026-09-09), neither by review.
 * See `docs/phase-2-generation.md` §L.1 and §L.5.
 */

const node = (
  role: string,
  name: string,
  extra: Partial<AccessibilityNode> = {},
): AccessibilityNode => ({ role, name, enabled: true, ...extra });

const state = (id: string, nodes: AccessibilityNode[]): CapturedState => ({
  id,
  label: id,
  url: `https://app.example/${id}`,
  nodes,
  truncated: false,
});

const captureOf = (nodes: AccessibilityNode[]): BoundedCapture => ({
  sessionId: 's',
  states: [state('home', nodes)],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
});

/** Replies with whatever payload it is given, as the real gateway does after parsing. */
class ReplyGateway implements LlmGateway {
  constructor(private readonly payload: unknown) {}

  async complete(): Promise<LlmCompletion<string>> {
    return {
      content: JSON.stringify(this.payload),
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01, cached: false },
    };
  }

  async completeJson<T>(_request: LlmCompletionRequest): Promise<LlmCompletion<T>> {
    const completion = await this.complete();
    return { ...completion, content: JSON.parse(completion.content) as T };
  }
}

const CAPTURE = captureOf([node('button', 'Refresh'), node('heading', 'Dashboard')]);
const EMPTY: InventoryEntry[] = [];

const generate = (payload: unknown) =>
  new GenerationEngine(new ReplyGateway(payload)).generate({
    command: 'test the dashboard refresh button',
    capture: CAPTURE,
    inventory: EMPTY,
    existingCaseTitles: [],
    runId: 'q',
  });

const QUESTIONS = [
  {
    question: 'Does clicking Refresh reload the data?',
    wouldAssert: 'the data updates after Refresh',
  },
  {
    question: 'Does Refresh disable itself while loading?',
    wouldAssert: 'Refresh is disabled during refresh',
  },
];

test.describe('the questions the MODEL asked survive (Q) @unit', () => {
  test('Q1: no cases plus questions is a RESULT, not a blank', async () => {
    // wrong: discarded, this run reports "proposals 0, refusals 0" — the model's
    // account of what it could not determine, reported as its silence. That is
    // precisely what the first real call did, five questions at a time.
    const result = await generate({ cases: [], openQuestions: QUESTIONS });

    expect(result.proposals).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(result.modelQuestions).toHaveLength(2);
    expect(result.modelQuestions[0]!.question).toContain('reload the data');
  });

  test('Q2: they reach the PROPOSAL record, not only the run result', async () => {
    // wrong: kept only on the run, they are lost the moment a proposal is
    // persisted or reviewed — and review is the one place a human reads them.
    const result = await generate({
      cases: [
        {
          title: 'Refresh is present',
          entryState: 'home',
          steps: [
            {
              kind: 'assert',
              role: 'button',
              name: 'Refresh',
              property: 'present',
              expected: true,
              modelSaid: 'observed',
            },
          ],
        },
      ],
      openQuestions: QUESTIONS,
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.modelQuestions).toHaveLength(2);
  });

  test('Q3: the derived questions and the model-supplied ones are SEPARATE fields', async () => {
    // wrong: one shared name is what hid the discard — a reader saw
    // `openQuestions` populated, assumed the model's were in it, and never
    // checked. Discriminating: this fixture produces BOTH, at different counts,
    // so a single merged field could not satisfy it.
    const result = await generate({
      cases: [
        {
          title: 'Refresh is selected',
          entryState: 'home',
          // `selected` is unrecorded on this node, so grounding grades it
          // `assumed` and derives one ungrounded-assertion entry.
          steps: [
            {
              kind: 'assert',
              role: 'button',
              name: 'Refresh',
              property: 'selected',
              expected: true,
              modelSaid: 'observed',
            },
          ],
        },
      ],
      openQuestions: QUESTIONS,
    });

    const proposal = result.proposals[0]!;
    expect(proposal.ungroundedAssertions).toHaveLength(1);
    expect(proposal.modelQuestions).toHaveLength(2);
    // The derived one carries a grader code; the model's carries only its words.
    expect(proposal.ungroundedAssertions[0]!.whyUngrounded).toBeTruthy();
    expect(Object.keys(proposal.modelQuestions[0]!).sort()).toEqual(['question', 'wouldAssert']);
  });

  test('Q4: a proposal built without them carries an empty array, never undefined', () => {
    // wrong: `undefined` makes every reader write `?? []`, and the one that
    // forgets throws on a field absent only for older records.
    const proposal = buildProposal({
      id: 'p',
      sourceCommand: 'c',
      model: 'm',
      promptVersion: 'v',
      capture: CAPTURE,
      modelCase: { title: 't', entryState: 'home', steps: [] },
    });
    expect(proposal.modelQuestions).toEqual([]);
  });
});

test.describe('the prompt offers only addressable candidates (A) @unit', () => {
  test('A1: a text node a CONTROL already covers is not offered', () => {
    // wrong: offered both, the model picks the presentational twin — measured on
    // the first real call, which returned `StaticText "Documents"` while
    // `link "Documents"` sat beside it in the same capture.
    const capture = captureOf([node('link', 'Documents'), node('StaticText', 'Documents')]);
    const prompt = renderGenerationPrompt(
      buildPromptInput({ capture, command: 'test documents', existingCaseTitles: [] }),
    );

    expect(prompt).toContain('link "Documents"');
    expect(prompt).not.toContain('StaticText "Documents"');
  });

  test('A2: a text node NO control covers IS offered, marked as text', () => {
    // wrong: filtering all text is the easier change and the wrong one — page
    // text is most of what a Then clause checks, `getByText` addresses it, and a
    // model shown an emptier page reasons about absences we invented.
    const capture = captureOf([node('StaticText', 'No employees registered yet.')]);
    const prompt = renderGenerationPrompt(
      buildPromptInput({ capture, command: 'test the empty state', existingCaseTitles: [] }),
    );

    expect(prompt).toContain('No employees registered yet.');
    expect(prompt).toContain('text only');
  });

  test('A3: the prompt TELLS the model what the mark means', () => {
    // wrong: marking a node without saying what the mark permits leaves the
    // model to infer the affordance from a role name — which is the inference it
    // got wrong.
    const capture = captureOf([node('StaticText', 'Trusted by leading enterprises')]);
    const prompt = renderGenerationPrompt(
      buildPromptInput({ capture, command: 'test the banner', existingCaseTitles: [] }),
    );
    expect(prompt).toContain('text only');
    expect(prompt).toContain('NOT write an action step');
  });

  test('A4: an affordance is a decision, not a guess', () => {
    // wrong: collapsing text and controls into one "addressable" bucket is the
    // exact conflation that caused this — they permit different actions.
    expect(affordanceOf('button')).toBe('control');
    expect(affordanceOf('StaticText')).toBe('text');
    expect(affordanceOf('RootWebArea')).toBe('scaffolding');
    expect(affordanceOf('LineBreak')).toBe('scaffolding');
  });

  test('A5: dedupe keeps the control even when the text node comes first', () => {
    // wrong: an order-dependent dedupe drops the control on half the pages and
    // keeps the twin, and the failure would look random rather than systematic.
    expect(
      dedupeTextAgainstControls([
        { role: 'StaticText', name: 'Save' },
        { role: 'button', name: 'Save' },
      ]),
    ).toEqual([{ role: 'button', name: 'Save' }]);
  });
});
