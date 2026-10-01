import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { closingAdvice } from '../../scripts/inspect-app';

/**
 * THE INSPECTOR'S LAST MESSAGE DEPENDS ON WHOSE DATA IT JUST CAPTURED.
 *
 * It used to say, unconditionally:
 *
 *     Captures are gitignored and stay on this machine: they contain real
 *     workspace names, document titles and user names from a live system.
 *
 *     Open report.md and paste it into the chat — that is enough to write real
 *     page objects with accurate locators and fallback chains.
 *
 * Two instructions in one block, and the second undoes the first. Found by running
 * the command on a fresh clone while writing the QA quickstart: the doc had to
 * contradict the tool's own output, which is a sign the tool is wrong.
 *
 * On the bundled demo app the advice is good — there is no real data and pasting
 * the report IS how a page object gets written. Anywhere else it is the exact thing
 * the handling rules forbid, printed by the repo itself.
 */
test.describe('the inspector tells you what you may do with the report @unit', () => {
  test('importing the inspector does NOT run it', () => {
    // wrong: `scripts/inspect-app.ts` called `main()` at module scope, so this very
    // spec launched the inspector in every worker — three empty timestamped
    // directories under `artifacts/<application>/inspect/` per unit run, and an
    // `ERROR … navigating to "test"` line in the output that read as noise for a day.
    //
    // Asserted as a FACT ABOUT THE FILE, because the side effect is invisible from
    // inside the module that caused it: by the time this test body runs, the import
    // has already happened. A guard is the only thing that can be checked here.
    const source = readFileSync(path.join(findRepoRoot(), 'scripts', 'inspect-app.ts'), 'utf8');
    expect(source).toContain('if (invokedDirectly)');
    // Discriminating: the bare call must be gone, not merely wrapped somewhere.
    expect(source).not.toMatch(/^main\(\)\.catch/m);
  });

  test('a real application: do NOT paste it anywhere', () => {
    // wrong: it prints "paste it into the chat" for a capture holding real
    // workspace names, document titles and user names — which is what it did.
    const advice = closingAdvice('dms').join('\n');

    expect(advice).toMatch(/do not paste/i);
    expect(advice).toContain('STAY ON THIS MACHINE');
    // The instruction that must NOT survive for a real application.
    expect(advice).not.toMatch(/paste it into the chat/i);
    // And it says what to do instead, or a refusal leaves the reader stuck.
    expect(advice).toMatch(/say which module you captured/i);
  });

  test('the bundled demo app: pasting it is still the right advice', () => {
    // wrong: the warning is applied to everything, so the one target that has no
    // customer data in it also refuses to be shared — and the fastest way to get a
    // page object written is removed for no benefit. A rule that refuses everything
    // is satisfied without knowing anything about the target.
    const advice = closingAdvice('bundled-demo').join('\n');

    expect(advice).toMatch(/paste it into the chat/i);
    expect(advice).toMatch(/no real data/i);
    expect(advice).not.toMatch(/do not paste/i);
  });

  test('an application nobody has declared gets the CAUTIOUS branch', () => {
    // wrong: the check is `application !== 'dms'`, so a third application added
    // later falls through to the permissive message — fail-open, on the one output
    // that carries customer data. The test is for the ONE known-safe slug, so
    // everything else is cautious by construction.
    for (const application of ['acme', 'northwind', '', 'demo', 'bundled-demo-2']) {
      const advice = closingAdvice(application).join('\n');
      expect(advice, `"${application}" must get the cautious message`).toMatch(/do not paste/i);
    }
  });
});
