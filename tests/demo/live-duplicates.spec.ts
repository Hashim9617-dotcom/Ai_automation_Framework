import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, createPlaywrightStepExecutor } from '@aitp/execution-engine';
import {
  executeAuthoredRows,
  findRepoRoot,
  resolveAuthoredRow,
  type AuthoredRow,
  type BoundedCapture,
  type EntryControl,
} from '@aitp/shared';

/**
 * SEVERAL MATCHES ON THE LIVE PAGE IS A REFUSAL (2026-09-29).
 *
 * ## The measurement this file exists because of
 *
 * The resolver refuses an ambiguous target — against the CAPTURE. The executor
 * branched on `count === 0` and nothing else. Measured on a real browser, with a
 * capture holding ONE `button "Edit"` and a page holding three:
 *
 * ```
 * clicks "Edit"                          passed   -> Alice edited
 * clicks "Edit" in the row for "Jane"    passed   -> Alice edited
 * clicks the last "Edit" button          passed   -> Alice edited
 * ```
 *
 * A `Delete` clause meant for one record would have deleted another and reported a
 * pass. And the capture-side guard cannot see it by construction: a capture is
 * taken from a page with one row and the run happens against twenty, which is the
 * normal shape of the customer system's grids.
 *
 * ## Why `setContent` and not the bundled demo app
 *
 * Measured: the demo app has no table and no repeated control. The page is written
 * here, which stubs the PAGE and not the BROWSER — real `count()`, real `click()`,
 * a real `#log` that records which button was pressed. The whole finding is about
 * what a real locator does with three matches, and a stub `count` cannot show that
 * nothing was clicked.
 *
 * ## §W — both halves, and the negative half is the load-bearing one
 *
 * One `Edit` must PASS and actually click. Three must REFUSE and click NOTHING,
 * proved by the page's own record rather than by the outcome we are testing.
 */

/** ONE Edit button — what the resolver is shown, so resolution never refuses. */
const CAPTURE: BoundedCapture = {
  sessionId: 'live-dupes',
  states: [
    {
      id: 'table',
      label: 'table',
      url: 'about:blank',
      nodes: [
        { role: 'button', name: 'Edit', enabled: true },
        // A NON-WRITE control, for L7. `assessWriteRisk` reads the step text and
        // `edit` is a write word, so an `Edit` clause is HELD before the executor is
        // called at all — which made L7 measure the write gate instead of the step
        // counter. Found by L7 coming back `held`, not by review.
        { role: 'button', name: 'View', enabled: true },
        { role: 'heading', name: 'Employees', enabled: true },
      ],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

const rowWith = (text: string, id: string): AuthoredRow => ({
  rowId: `${id} / TC_1`,
  scenarioId: id,
  testCaseId: 'TC_1',
  sheetRow: 2,
  module: 'Employees',
  feature: '',
  // Blank: `assessWriteRisk` reads the title, and a write word there would hold
  // every row and hide the refusal this file is about.
  scenarioName: '',
  objective: '',
  testType: '',
  priority: '',
  preconditions: '',
  testData: '',
  type: '',
  clauses: [{ text, source: 'when', kind: 'action' }],
});

/** `rows` Edit buttons, each recording its own row's name when clicked. */
const pageWith = (names: string[]): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Employees</title></head>
<body>
  <h1>Employees</h1>
  <p id="log">nothing clicked</p>
  <table>
${names
  .map(
    (name) =>
      `    <tr><td>${name}</td>` +
      `<td><button onclick="document.getElementById('log').textContent='${name} edited'">Edit</button>` +
      `<button onclick="document.getElementById('log').textContent='${name} viewed'">View</button></td></tr>`,
  )
  .join('\n')}
  </table>
</body></html>`;

const executorFor = (page: Page) =>
  createPlaywrightStepExecutor(page, {
    artifactDir: path.join(findRepoRoot(), 'artifacts', 'live-duplicates'),
    timeoutMs: 2_000,
  });

/** Resolves a clause and runs its one step. Resolution must succeed, or the test lies. */
const runClause = async (page: Page, clause: string, id: string) => {
  const resolved = resolveAuthoredRow(rowWith(clause, id), CAPTURE, 'table');
  expect(resolved.outcome, `${clause} was refused at RESOLVE, so this measures nothing`).not.toBe(
    'row-unclear',
  );
  const target = resolved.targets[0]!;
  return executorFor(page)({
    rowId: resolved.rowId,
    step: resolved.steps[0]!,
    target: { role: target.role, name: target.name },
  });
};

const clickedLog = (page: Page): Promise<string> => page.locator('#log').innerText();

test.describe('several live-page matches are refused, not clicked @demo', () => {
  test('L1: ONE match clicks it and passes — the half that makes L2 mean anything', async ({
    page,
  }) => {
    // wrong: the guard refuses whenever it sees a count, so nothing ever runs and
    // the suite is green because the platform does nothing. A rule that refuses
    // everything is satisfied by knowing nothing about the page.
    await page.setContent(pageWith(['Alice']));
    expect(await page.getByRole('button', { name: 'Edit', exact: true }).count()).toBe(1);

    const outcome = await runClause(page, 'clicks "Edit"', 'L1');

    expect(outcome.kind).toBe('passed');
    expect(await clickedLog(page)).toBe('Alice edited');
  });

  test('L2: THREE matches refuse, and NOTHING is clicked', async ({ page }) => {
    // wrong: `locator.first()` clicks Alice and reports a pass — measured, before
    // this guard existed, for this exact page and this exact clause.
    await page.setContent(pageWith(['Alice', 'Bob', 'Jane']));
    expect(await page.getByRole('button', { name: 'Edit', exact: true }).count()).toBe(3);

    const outcome = await runClause(page, 'clicks "Edit"', 'L2');

    expect(outcome.kind).toBe('ambiguous-on-page');
    expect(outcome.observed).toContain('3 elements');
    // THE ASSERTION THAT MATTERS. Read off the page's own record, not off the
    // outcome we are testing: `ambiguous-on-page` would be equally reported by an
    // executor that clicked first and refused afterwards.
    expect(await clickedLog(page)).toBe('nothing clicked');
  });

  test('L3: a scoped or ordinal clause never reaches the page at all', async ({ page }) => {
    // wrong: these reach the executor and are caught by the ambiguity guard, which
    // is the right verdict for the wrong reason — the qualifier is unsupported
    // however many elements match, and a page with ONE Edit would run them.
    await page.setContent(pageWith(['Alice', 'Bob', 'Jane']));

    for (const clause of [
      'clicks "Edit" in the row for "Jane"',
      'clicks the last "Edit" button',
      'clicks the second "Edit" button',
    ]) {
      const resolved = resolveAuthoredRow(rowWith(clause, `L3${clause.length}`), CAPTURE, 'table');
      expect(resolved.outcome, clause).toBe('row-unclear');
      expect(resolved.refusals[0]!.why, clause).toBe('qualifier-not-supported');
      expect(resolved.steps, clause).toEqual([]);
    }

    // And the page is untouched by all three.
    expect(await clickedLog(page)).toBe('nothing clicked');
  });

  test('L4: a presence assertion accepts several matches and reports HOW MANY', async ({
    page,
  }) => {
    // wrong: presence is gated like everything else, so `verify the "Edit" button
    // is visible` refuses on any grid — a claim that several matches satisfy, and
    // the one shape where `.first()` was never wrong.
    await page.setContent(pageWith(['Alice', 'Bob', 'Jane']));

    const outcome = await executorFor(page)({
      rowId: 'L4 / TC_1',
      step: { kind: 'assert', role: 'button', name: 'Edit', property: 'present', expected: true },
      target: { role: 'button', name: 'Edit' },
    });

    expect(outcome.kind).toBe('passed');
    // The count travels, because "at least one" and "exactly one" are different
    // observations and `present=true` cannot tell them apart.
    expect(outcome.observed).toContain('3 matches');
  });

  test('L5: a PROPERTY assertion over several matches refuses', async ({ page }) => {
    // wrong: `enabled` is read off `.first()`, so a grid where one row's button is
    // disabled reports whatever the first row happens to say — and the two answers
    // are indistinguishable in the report.
    await page.setContent(pageWith(['Alice', 'Bob', 'Jane']));

    const outcome = await executorFor(page)({
      rowId: 'L5 / TC_1',
      step: { kind: 'assert', role: 'button', name: 'Edit', property: 'enabled', expected: true },
      target: { role: 'button', name: 'Edit' },
    });

    expect(outcome.kind).toBe('ambiguous-on-page');
    expect(outcome.observed).toContain('3 elements');
  });

  test('L6: an ABSENCE assertion passes when the element is gone, not `stale-capture`', async ({
    page,
  }) => {
    // wrong: `count === 0` returned `target-not-on-page` for every step kind, so a
    // row asserting absence, satisfied, was reported as a STALE CAPTURE — "re-run
    // `pnpm inspect`" about a capture that was current and a row that had just
    // passed. It had no test, which is why it survived: every `count: 0` fixture in
    // the executor's unit suite uses an action or a positive assertion.
    await page.setContent(pageWith(['Alice']));

    const absent = await executorFor(page)({
      rowId: 'L6 / TC_1',
      step: {
        kind: 'assert',
        role: 'button',
        name: 'Archive',
        property: 'present',
        expected: false,
      },
      target: { role: 'button', name: 'Archive' },
    });
    expect(absent.kind).toBe('passed');

    // Discriminating: the same assertion about an element that IS there fails, and
    // fails as a FAILURE rather than as a stale capture.
    const present = await executorFor(page)({
      rowId: 'L6b / TC_1',
      step: { kind: 'assert', role: 'button', name: 'Edit', property: 'present', expected: false },
      target: { role: 'button', name: 'Edit' },
    });
    expect(present.kind).toBe('failed');
    expect(present.observed).toContain('expected none');
  });

  test('L7: a refused step is not counted as a step that RAN', async ({ page }) => {
    // wrong: `stepsRun` came from `observations.length`, which counts every
    // executor call — so a row refused at a gate before touching the page reported
    // `stepsRun: 1`, which is the one claim `stepsRun` exists to make honestly.
    await page.setContent(pageWith(['Alice', 'Bob', 'Jane']));

    const resolved = resolveAuthoredRow(rowWith('clicks "View"', 'L7'), CAPTURE, 'table');
    expect(resolved.outcome).not.toBe('row-unclear');

    const entry: EntryControl = {
      moduleOf: () => 'Employees',
      verify: async () => ({ verified: true }),
    };
    const run = await executeAuthoredRows({
      resolved: [resolved],
      unreadable: [],
      execute: executorFor(page),
      entry,
    });

    const result = run.results[0]!;
    expect(result.status).toBe('refused');
    expect(result.stepsRun).toBe(0);
    expect(await clickedLog(page)).toBe('nothing clicked');
  });
});
