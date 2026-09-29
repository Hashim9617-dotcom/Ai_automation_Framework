import { test, expect, createPlaywrightStepExecutor } from '@aitp/execution-engine';
import {
  findRepoRoot,
  resolveAuthoredRow,
  type AuthoredRow,
  type BoundedCapture,
} from '@aitp/shared';
import path from 'node:path';
import type { Page } from '@playwright/test';

/**
 * `checked` against a REAL browser, both polarities, both outcomes (A2).
 *
 * ## Why `setContent` rather than the demo app
 *
 * Measured 2026-09-29: the bundled demo app has no checkbox and no radio. So the
 * page is written here, which is a stub of the PAGE and not a stub of the
 * BROWSER — Playwright's real `isChecked` runs against real DOM, which is the
 * half a unit stub cannot give (§R: a stub removes the ORDER, and here it would
 * remove whether `isChecked` answers at all).
 *
 * ## What this proves that the unit table cannot
 *
 * `assert-state.spec.ts` proves the resolver produces `checked=true`. That is a
 * fact about a string becoming a step. Whether anything can READ `checked` off a
 * live element is a different claim, and it is the one the false pass was hiding:
 * `present=true` was always readable, which is exactly why nobody noticed the
 * property was wrong.
 *
 * ## The form this test exists to license
 *
 * `verify the "Active" checkbox is checked` is the form the refusal message for a
 * `checks the "Active" box` clause RECOMMENDS. It is recommended only because it
 * is run here and observed to pass on a ticked box and fail on an unticked one.
 * The previous recommendation was made without doing that, and it asserted
 * presence (`docs/phase-2-generation.md` §AG).
 */

const CAPTURE: BoundedCapture = {
  sessionId: 'assert-checked',
  states: [
    {
      id: 'form',
      label: 'form',
      url: 'about:blank',
      nodes: [
        { role: 'checkbox', name: 'Active', enabled: true, checked: true },
        { role: 'heading', name: 'Preferences', enabled: true },
      ],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

const rowWith = (then: string, id: string): AuthoredRow => ({
  rowId: `${id} / TC_1`,
  scenarioId: id,
  testCaseId: 'TC_1',
  sheetRow: 2,
  module: 'Preferences',
  feature: '',
  scenarioName: '',
  objective: '',
  testType: '',
  priority: '',
  preconditions: '',
  testData: '',
  type: '',
  clauses: [{ text: then, source: 'then', kind: 'assert' }],
});

/** A page with one checkbox, ticked or not. Nothing else, so nothing else matters. */
const pageHtml = (checked: boolean): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Preferences</title></head>
<body>
  <h1>Preferences</h1>
  <label for="active">Active</label>
  <input id="active" type="checkbox"${checked ? ' checked' : ''}>
</body></html>`;

test.describe('`checked` is read off a real element (A2) @demo', () => {
  /** Resolves the clause and runs its one step against the given page state. */
  const run = async (page: Page, boxChecked: boolean, clause: string, id: string) => {
    await page.setContent(pageHtml(boxChecked));
    // The input has to have arrived, or every verdict below is about a blank page.
    await expect(page.getByRole('checkbox', { name: 'Active', exact: true })).toBeVisible();

    const resolved = resolveAuthoredRow(rowWith(clause, id), CAPTURE, 'form');
    expect(resolved.outcome, `${clause} did not resolve`).not.toBe('row-unclear');
    const step = resolved.steps[0]!;
    expect(step.kind).toBe('assert');

    const execute = createPlaywrightStepExecutor(page, {
      artifactDir: path.join(findRepoRoot(), 'artifacts', 'assert-checked'),
      timeoutMs: 2_000,
    });
    const target = resolved.targets[0]!;
    const outcome = await execute({
      rowId: resolved.rowId,
      step,
      target: { role: target.role, name: target.name },
    });
    return { step, outcome };
  };

  test('A2: "is checked" passes on a ticked box and FAILS on an unticked one', async ({ page }) => {
    // wrong: the clause resolves to `present=true`, so it passes in BOTH cases —
    // the box exists either way. That was the measured behaviour before `checked`
    // existed, and it is why a row and its negation were the same assertion.
    const clause = 'verify the "Active" checkbox is checked';

    const ticked = await run(page, true, clause, 'CK_1');
    expect(ticked.step.kind === 'assert' && ticked.step.property).toBe('checked');
    expect(ticked.step.kind === 'assert' && ticked.step.expected).toBe(true);
    expect(ticked.outcome.kind).toBe('passed');
    expect(ticked.outcome.observed).toContain('checked=true');

    // THE HALF THAT MAKES THE FIRST ONE MEAN ANYTHING. Same clause, same
    // resolution, one attribute removed from the page.
    const unticked = await run(page, false, clause, 'CK_2');
    expect(unticked.outcome.kind).toBe('failed');
    expect(unticked.outcome.observed).toContain('checked=false');
    // And it did not pass by reading presence instead: the box IS on the page.
    await expect(page.getByRole('checkbox', { name: 'Active', exact: true })).toBeVisible();
  });

  test('A2: "is not checked" is the exact inverse, on the same two pages', async ({ page }) => {
    // wrong: the negation is dropped and this clause resolves identically to the
    // positive one, so a row asserting the box is CLEAR passes when it is ticked.
    // Measured: both produced `present=true`.
    const clause = 'verify the "Active" checkbox is not checked';

    const unticked = await run(page, false, clause, 'CK_3');
    expect(unticked.step.kind === 'assert' && unticked.step.expected).toBe(false);
    expect(unticked.outcome.kind).toBe('passed');

    const ticked = await run(page, true, clause, 'CK_4');
    expect(ticked.outcome.kind).toBe('failed');
    expect(ticked.outcome.observed).toContain('checked=true');
  });

  test('A2: `checked` asked of a non-checkable element is a SILENCE, not a false', async ({
    page,
  }) => {
    // wrong: `isChecked` throws on a heading, the throw is swallowed as `false`,
    // and the row reports "the heading is not checked" — a confident answer about
    // a question the element cannot be asked. The same distinction `checkGrounding`
    // makes for an unrecorded property.
    await page.setContent(pageHtml(true));
    const execute = createPlaywrightStepExecutor(page, {
      artifactDir: path.join(findRepoRoot(), 'artifacts', 'assert-checked'),
      timeoutMs: 2_000,
    });
    const outcome = await execute({
      rowId: 'CK_5 / TC_1',
      step: {
        kind: 'assert',
        role: 'heading',
        name: 'Preferences',
        property: 'checked',
        expected: true,
      },
      target: { role: 'heading', name: 'Preferences' },
    });

    expect(outcome.kind).toBe('no-observable-check');
    // Discriminating: the heading is genuinely on the page, so this is not
    // `target-not-on-page` wearing a different name.
    await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();
  });
});
