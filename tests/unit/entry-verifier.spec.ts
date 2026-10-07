import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { createEntryVerifier, type EntryPage } from '@aitp/execution-engine';
import {
  executeAuthoredRows,
  type BoundedCapture,
  type EntryControl,
  type ModuleMap,
  type ResolvedAuthoredRow,
  type StepExecutor,
} from '@aitp/shared';

/**
 * The entry verifier (4d), behind a stub page.
 *
 *   V1  the reason is the STAGE that failed, not a guess made afterwards
 *   V2  a module that was not reached stops every row it owns, and no step runs
 *
 * **What a stub cannot show**, stated because this project has been caught by it
 * before: that the executor drives a real browser at all. That is
 * `tests/demo/authored-entry.spec.ts`, which runs these same three outcomes
 * against the bundled demo app. A stub cannot falsify itself.
 */

const capture: BoundedCapture = {
  sessionId: 's',
  states: [
    {
      id: 'employees',
      label: 'employees',
      url: 'http://127.0.0.1:4173/employees',
      nodes: [{ role: 'heading', name: 'Register employee', enabled: true }],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

const MAP: ModuleMap = {
  'Employee registration': {
    route: '/employees',
    provenBy: { role: 'heading', name: 'Register employee' },
  },
};

/** A page that finds the proof element, or does not, on demand. */
const stubPage = (found: number, onGoto?: () => void): EntryPage =>
  ({
    goto: async () => {
      onGoto?.();
    },
    getByRole: () => ({ count: async () => found }),
    getByText: () => ({ count: async () => found }),
  }) as unknown as EntryPage;

/**
 * `.verify`, because the builder now returns the VALIDATION alongside it.
 *
 * It used to return the function alone and throw on an unprovable `provenBy`. 3b
 * makes that per-module — the whole map is still validated, and the caller decides
 * which modules to refuse — so the result is a pair. These tests are about the
 * stages, which is `verify`; `MAP_VALIDATION` below covers the other half.
 */
const verifierFor = (page: EntryPage, signIn: () => Promise<void> = async () => {}) =>
  createEntryVerifier({ map: MAP, capture, mapFile: 'm.json', page, signIn }).verify;

test.describe('the reason is the stage that failed (V1) @unit', () => {
  test('V1: a sign-in failure is `auth`, and nothing after it is attempted', async () => {
    // wrong: reported as `state-assert` because the proof element is missing —
    // which it is, but only because the run never got past the login form. The
    // QA is then sent to check an element on a screen nobody reached.
    let navigated = false;
    const verify = verifierFor(
      stubPage(0, () => {
        navigated = true;
      }),
      async () => {
        throw new Error('invalid credentials');
      },
    );

    const verdict = await verify('Employee registration');

    expect(verdict).toEqual({
      verified: false,
      reason: 'auth',
      detail: expect.stringContaining('invalid credentials'),
    });
    expect(navigated, 'navigation was attempted after auth failed').toBe(false);
  });

  test('V1: a navigation failure is `navigation`', async () => {
    // wrong: folded into `state-assert`, and someone goes looking for a missing
    // element on a page that never opened.
    const page = stubPage(1, () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });

    expect(await verifierFor(page)('Employee registration')).toEqual({
      verified: false,
      reason: 'navigation',
      detail: expect.stringContaining('ERR_CONNECTION_REFUSED'),
    });
  });

  test('V1: signed in, navigated, proof absent is `state-assert`', async () => {
    // wrong: reported as `auth` or `navigation`, both of which SUCCEEDED here —
    // the run is on a page, just not the one this module's rows start from.
    const verdict = await verifierFor(stubPage(0))('Employee registration');

    expect(verdict).toEqual({
      verified: false,
      reason: 'state-assert',
      detail: expect.stringContaining('Register employee'),
    });
  });

  test('V1: with the proof element present, the entry is verified', async () => {
    // wrong: a verifier that never verifies passes all three tests above while
    // making every row unrunnable — the refuses-everything failure, which is
    // why this case is here.
    expect(await verifierFor(stubPage(1))('Employee registration')).toEqual({ verified: true });
  });

  test('V1: signing in happens ONCE, however many modules are verified', async () => {
    // wrong: each module signs in again, so one broken login is reported as
    // seven problems and a real run logs in seven times.
    let signIns = 0;
    const { verify } = createEntryVerifier({
      map: { ...MAP, Second: MAP['Employee registration']! },
      capture,
      mapFile: 'm.json',
      page: stubPage(1),
      signIn: async () => {
        signIns += 1;
      },
    });

    await verify('Employee registration');
    await verify('Second');

    expect(signIns).toBe(1);
  });
});

test.describe('an unreached module stops every row it owns (V2) @unit', () => {
  const row = (rowId: string): ResolvedAuthoredRow => ({
    rowId,
    scenarioId: rowId.split(' / ')[0]!,
    testCaseId: rowId.split(' / ')[1]!,
    module: 'Employee registration',
    sheetRow: 3,
    title: rowId,
    outcome: 'ok',
    owner: 'none',
    steps: [{ kind: 'action', description: 'click "Save"' }],
    targets: [{ stepIndex: 0, role: 'button', name: 'Save' }],
    clauseKinds: ['action'],
    givenClauses: [],
    refusals: [],
    grades: [],
    writeRisk: 'read-only',
    summary: 'resolved',
  });

  test('V2: every row of the module is given-not-reached, and NO step runs', async () => {
    // wrong: the rows run anyway against whatever screen is open, and a target
    // missing there is reported `stale-capture` — DEMO_4 exactly, a current
    // capture blamed for a run that never arrived.
    let steps = 0;
    const execute: StepExecutor = async () => {
      steps += 1;
      return { kind: 'passed', observed: 'clicked' };
    };
    const entry: EntryControl = {
      moduleOf: () => 'Employee registration',
      verify: async () => ({ verified: false, reason: 'state-assert', detail: 'not on it' }),
    };

    const outcome = await executeAuthoredRows({
      resolved: [row('SI_1 / TC_1'), row('SI_2 / TC_1'), row('SI_3 / TC_1')],
      unreadable: [],
      execute,
      entry,
    });

    expect(outcome.tally.givenNotReached).toBe(3);
    expect(steps, 'a step ran on a screen the run never reached').toBe(0);
    for (const result of outcome.results) {
      expect(result.status).toBe('given-not-reached');
      if (result.status === 'given-not-reached') {
        expect(result.reason).toBe('state-assert');
        expect(result.module).toBe('Employee registration');
      }
    }
  });

  test('V2: the entry is verified ONCE per module, not once per row', async () => {
    // wrong: three rows mean three sign-ins and three navigations, and one
    // broken screen is reported three times over.
    let verifications = 0;
    const entry: EntryControl = {
      moduleOf: () => 'Employee registration',
      verify: async () => {
        verifications += 1;
        return { verified: true };
      },
    };

    await executeAuthoredRows({
      resolved: [row('SI_1 / TC_1'), row('SI_2 / TC_1'), row('SI_3 / TC_1')],
      unreadable: [],
      execute: async () => ({ kind: 'passed', observed: 'clicked' }),
      entry,
    });

    expect(verifications).toBe(1);
  });
});

/**
 * A FAILING ENTRY CARRIES ITS EVIDENCE (E10).
 *
 * The step-level `target-not-on-page` has written a screenshot since 4d. The entry
 * gate — which stops EVERY row in a module, not one — wrote nothing, and the fact
 * is identical: the element the capture promised is not on the live page. The File
 * Explorer failure on 6 Oct was one sentence, and separating "absent" from
 * "renamed" from "off-screen" then took a day and a separate diagnostic.
 *
 * `aria`, not an accessibility snapshot: **`page.accessibility` does not exist in
 * Playwright 1.62.1.** Reaching for it threw `Cannot read properties of undefined
 * (reading 'snapshot')` in the first diagnostic. That is why the DEMO suite proves
 * this against a real page — these stubs could declare any API at all and agree
 * with themselves (`tests/demo/authored-entry.spec.ts`).
 */
test.describe('a failing entry carries its evidence (E10) @unit', () => {
  /** A stub that CAN write evidence, so the writer has something to call. */
  const capturingPage = (found: number, dir: string): { page: EntryPage; wrote: string[] } => {
    const wrote: string[] = [];
    const page = {
      goto: async () => {},
      getByRole: () => ({ count: async () => found }),
      getByText: () => ({ count: async () => found }),
      screenshot: async (options: { path: string }) => {
        wrote.push(options.path);
        mkdirSync(path.dirname(options.path), { recursive: true });
        writeFileSync(options.path, 'png');
        return Buffer.from('png');
      },
      ariaSnapshot: async () => '- heading "Register employee"',
    } as unknown as EntryPage;
    void dir;
    return { page, wrote };
  };

  test('E10: a state-assert verdict carries screenshot and aria paths, and the files exist', async () => {
    // wrong: the verdict is a sentence and nothing else — which is what it was, and
    // what made "`/files` opened, tree Workspaces not on it" unactionable without
    // writing a separate diagnostic to ask the three questions it leaves open.
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-entry-evidence-'));
    const { page, wrote } = capturingPage(0, dir);
    const { verify } = createEntryVerifier({
      map: MAP,
      capture,
      mapFile: 'm.json',
      page,
      signIn: async () => {},
      artifactDir: dir,
    });

    const verdict = await verify('Employee registration');
    expect(verdict.verified).toBe(false);
    if (verdict.verified) throw new Error('unreachable');
    expect(verdict.reason).toBe('state-assert');
    expect(verdict.evidence).toBeDefined();
    // PATHS THAT EXIST. A recorded path nothing wrote is the oldest bug in this
    // repo, so the claim is checked on disk rather than in the object.
    expect(existsSync(verdict.evidence!.screenshot)).toBe(true);
    expect(existsSync(verdict.evidence!.aria)).toBe(true);
    expect(readFileSync(verdict.evidence!.aria, 'utf8')).toContain('Register employee');
    expect(wrote).toHaveLength(1);
  });

  test('E10: a VERIFIED entry writes nothing, and `auth` writes nothing either', async () => {
    // wrong: a writer that fired on every verdict would pass the test above and fill
    // an artifact directory with pictures of screens that were fine — and would then
    // make `auth` write a picture of the login form, which says nothing about the
    // module being verified. Both silences are the point.
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-entry-evidence-'));
    const { page, wrote } = capturingPage(1, dir);
    const { verify } = createEntryVerifier({
      map: MAP,
      capture,
      mapFile: 'm.json',
      page,
      signIn: async () => {},
      artifactDir: dir,
    });
    expect((await verify('Employee registration')).verified).toBe(true);
    expect(wrote).toEqual([]);

    // AUTH: a failure before the page is anywhere. No evidence, by design.
    const failing = capturingPage(0, dir);
    const authVerify = createEntryVerifier({
      map: MAP,
      capture,
      mapFile: 'm.json',
      page: failing.page,
      signIn: async () => {
        throw new Error('rejected');
      },
      artifactDir: dir,
    }).verify;
    const verdict = await authVerify('Employee registration');
    if (verdict.verified) throw new Error('unreachable');
    expect(verdict.reason).toBe('auth');
    expect(verdict.evidence).toBeUndefined();
    expect(failing.wrote).toEqual([]);
  });
});
