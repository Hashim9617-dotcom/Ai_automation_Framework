import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { createPlaywrightStepExecutor, type ExecutorPage } from '@aitp/execution-engine';
import type { CaseStep } from '@aitp/shared';

/**
 * The executor's POLICY, against a stub page.
 *
 * Expectations derive from `docs/phase-2-authored-cases.md` §10, written before
 * this code (rule 4).
 *
 * **What this does not claim:** it has not been run against the live
 * application. The stub proves the outcome mapping, the healing separation and
 * the observation rule; it proves nothing about how Playwright behaves on a
 * real DMS page. That distinction is stated in the doc too, because a green
 * suite here would otherwise read as "the executor works".
 */

interface StubLocator {
  count: () => Promise<number>;
  first: () => {
    click: (o?: unknown) => Promise<void>;
    isVisible: (o?: unknown) => Promise<boolean>;
    isEnabled: (o?: unknown) => Promise<boolean>;
    getAttribute: (name: string) => Promise<string | null>;
  };
}

interface StubOptions {
  count?: number;
  clickThrows?: string;
  visible?: boolean;
  enabled?: boolean;
  ariaSelected?: string | null;
  screenshotThrows?: boolean;
}

const stubPage = (options: StubOptions = {}): ExecutorPage & { shots: string[] } => {
  const shots: string[] = [];
  const locator: StubLocator = {
    count: async () => options.count ?? 1,
    first: () => ({
      click: async () => {
        if (options.clickThrows) throw new Error(options.clickThrows);
      },
      isVisible: async () => options.visible ?? true,
      isEnabled: async () => options.enabled ?? true,
      getAttribute: async () => options.ariaSelected ?? null,
    }),
  };
  return {
    shots,
    getByRole: (() => locator) as unknown as ExecutorPage['getByRole'],
    screenshot: async ({ path: file }) => {
      if (options.screenshotThrows) throw new Error('cannot write');
      shots.push(file);
    },
  };
};

const artifactDir = mkdtempSync(path.join(tmpdir(), 'aitp-exec-'));
const make = (page: ExecutorPage, extra: Record<string, unknown> = {}) =>
  createPlaywrightStepExecutor(page, {
    artifactDir,
    tracePath: 'artifacts/runs/run_x/trace.zip',
    ...extra,
  });

const clickStep: CaseStep = { kind: 'action', description: 'click "Approve"' };
const assertStep: CaseStep = {
  kind: 'assert',
  role: 'heading',
  name: 'Dashboard',
  property: 'present',
  expected: true,
};
const target = { role: 'button', name: 'Approve' };

test.describe('the executor maps live-page outcomes (X1) @unit', () => {
  test('X1: a missing element is stale-capture, never failed', async () => {
    // wrong: returning `failed` here sends the app team after a bug that does not
    // exist — the element is absent from the page but present in our capture.
    const outcome = await make(stubPage({ count: 0 }))({
      rowId: 'SI_1 / TC_1',
      step: clickStep,
      target,
    });
    expect(outcome.kind).toBe('target-not-on-page');
    expect(outcome.observed).toContain('no button named "Approve"');
  });

  test('X1: a present element that cannot be clicked IS a failure', async () => {
    // wrong: mapped to stale-capture, a real app defect is filed as our capture
    // being out of date and nobody looks at the application.
    const outcome = await make(stubPage({ clickThrows: 'element is not enabled' }))({
      rowId: 'SI_1 / TC_1',
      step: clickStep,
      target,
    });
    expect(outcome.kind).toBe('failed');
    expect(outcome.observed).toContain('not enabled');
  });

  test('X1: a successful click reports what it did', async () => {
    // wrong: an empty observation on an action still passes, but the report then
    // cannot say what the run actually performed.
    const outcome = await make(stubPage())({ rowId: 'r', step: clickStep, target });
    expect(outcome.kind).toBe('passed');
    expect(outcome.observed).toContain('clicked button "Approve"');
  });

  test('X1: no resolver target means nothing checkable, not a pass', async () => {
    // wrong: without a target the executor would have to re-derive one from the
    // prose — two components interpreting one sentence, disagreeing silently.
    const outcome = await make(stubPage())({ rowId: 'r', step: clickStep });
    expect(outcome.kind).toBe('no-observable-check');
  });
});

test.describe('healing proposes, never substitutes (X2) @unit', () => {
  test('X2: a proposal is recorded and the verdict is unchanged', async () => {
    // wrong: acting on the proposal returns `passed`, and the QA is told their
    // row succeeded against an element they never wrote about.
    const outcome = await make(stubPage({ count: 0 }), {
      proposeHealing: async () => 'a button named "Approve Request" resolves uniquely',
    })({ rowId: 'r', step: clickStep, target });

    expect(outcome.kind).toBe('target-not-on-page');
    expect(outcome.healingProposal).toContain('Approve Request');
  });

  test('X2: the verdict is identical with and without a proposal', async () => {
    // wrong: if the proposal influenced the outcome these two would differ —
    // identical kinds are what prove it was never consulted.
    const withHealer = await make(stubPage({ count: 0 }), {
      proposeHealing: async () => 'something',
    })({ rowId: 'r', step: clickStep, target });
    const without = await make(stubPage({ count: 0 }))({ rowId: 'r', step: clickStep, target });
    expect(withHealer.kind).toBe(without.kind);
  });

  test('X2: a healer that throws cannot break the run', async () => {
    // wrong: an unhandled rejection from a suggestion turns a clean
    // stale-capture result into an exception that loses the whole row.
    const outcome = await make(stubPage({ count: 0 }), {
      proposeHealing: async () => {
        throw new Error('healer exploded');
      },
    })({ rowId: 'r', step: clickStep, target });
    expect(outcome.kind).toBe('target-not-on-page');
    expect(outcome.healingProposal).toBeUndefined();
  });
});

test.describe('an assertion returns what it observed (X3) @unit', () => {
  test('X3: a matching property passes, carrying the value it read', async () => {
    // wrong: passing with an empty observation is a criterion satisfied by
    // knowing nothing — the accounting layer refuses exactly that.
    const outcome = await make(stubPage({ visible: true }))({
      rowId: 'r',
      step: assertStep,
      target: { role: 'heading', name: 'Dashboard' },
    });
    expect(outcome.kind).toBe('passed');
    expect(outcome.observed).toContain('present=true');
  });

  test('X3: a differing property fails, saying what it expected', async () => {
    // wrong: reported as passed, a real disagreement between the sheet and the
    // app disappears into a green number.
    const outcome = await make(stubPage({ visible: false }))({
      rowId: 'r',
      step: assertStep,
      target: { role: 'heading', name: 'Dashboard' },
    });
    expect(outcome.kind).toBe('failed');
    expect(outcome.observed).toContain('expected true');
  });

  test('X3: a property the page does not express is a SILENCE, not a false', async () => {
    // wrong: reading a missing aria-selected as `false` turns "the page does not
    // say" into "the app says no", and files a defect against a fact nobody has.
    const outcome = await make(stubPage({ ariaSelected: null }))({
      rowId: 'r',
      step: { kind: 'assert', role: 'tab', name: 'Summary', property: 'selected', expected: true },
      target: { role: 'tab', name: 'Summary' },
    });
    expect(outcome.kind).toBe('no-observable-check');
  });

  test('X3: a property the page DOES express is read normally', async () => {
    // wrong: refusing every selected-check would pass the test above while making
    // aria-selected assertions impossible to satisfy anywhere.
    const outcome = await make(stubPage({ ariaSelected: 'true' }))({
      rowId: 'r',
      step: { kind: 'assert', role: 'tab', name: 'Summary', property: 'selected', expected: true },
      target: { role: 'tab', name: 'Summary' },
    });
    expect(outcome.kind).toBe('passed');
    expect(outcome.observed).toContain('selected=true');
  });
});

test.describe('evidence is captured by path (X4) @unit', () => {
  test('X4: a non-passing outcome carries a screenshot path and the trace path', async () => {
    // wrong: no evidence and the app team starts from a row id and a sentence —
    // the position Finding 16 took two days to climb out of.
    const page = stubPage({ count: 0 });
    const outcome = await make(page)({ rowId: 'SI_2 / TC_1', step: clickStep, target });

    expect(outcome.evidence!.screenshot).toContain(artifactDir);
    expect(outcome.evidence!.trace).toBe('artifacts/runs/run_x/trace.zip');
    expect(page.shots.length).toBe(1);
  });

  test('X4: a PASSING outcome takes no screenshot', async () => {
    // wrong: shooting every step multiplies artifacts for runs that went fine and
    // buries the images that matter.
    const page = stubPage();
    const outcome = await make(page)({ rowId: 'r', step: clickStep, target });
    expect(outcome.evidence).toBeUndefined();
    expect(page.shots.length).toBe(0);
  });

  test('X4: a screenshot that cannot be written does not lose the result', async () => {
    // wrong: letting the failure propagate turns a clean stale-capture verdict
    // into an exception, and the row is lost from the report entirely.
    const outcome = await make(stubPage({ count: 0, screenshotThrows: true }))({
      rowId: 'r',
      step: clickStep,
      target,
    });
    expect(outcome.kind).toBe('target-not-on-page');
    expect(outcome.evidence!.trace).toBe('artifacts/runs/run_x/trace.zip');
    expect(outcome.evidence!.screenshot).toBeUndefined();
  });

  test('X4: the screenshot path is keyed on the composite row id', async () => {
    // wrong: keyed on the Test Case ID alone, eight rows share one filename and
    // seven screenshots are overwritten before anyone opens them.
    const page = stubPage({ count: 0 });
    await make(page)({ rowId: 'SI_2 / TC_001', step: clickStep, target });
    expect(page.shots[0]).toContain('si-2-tc-001');
  });
});
