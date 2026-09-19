import { test, expect, createEntryVerifier } from '@aitp/execution-engine';
import {
  executeAuthoredRows,
  type BoundedCapture,
  type EntryControl,
  type ModuleMap,
  type ResolvedAuthoredRow,
  type StepExecutor,
} from '@aitp/shared';
import { LoginPage } from './pages/login.page';

/**
 * The entry verifier against a REAL browser and the bundled demo app.
 *
 * Everything before this was accounting: inputs in, results out, a stub on the
 * other side of the seam. This is the first thing that can only pass if the
 * verifier drives a page — and it earned its place immediately. The unit suite
 * was 7/7 green when the first real run contradicted it: the demo app had no
 * session, so `goto` erased the sign-in and no route reached the employees
 * screen. That is 4d0, and this file is why it was found.
 *
 * | case           | how                                                        |
 * | -------------- | ---------------------------------------------------------- |
 * | `auth`         | a wrong password; the reason is the app's OWN refusal       |
 * | `state-assert` | signed in and navigated, asking for the signed-OUT view's   |
 * |                | proof — both earlier stages succeeded                       |
 * | verified       | signed in, navigated, and the proof of the view now showing |
 *
 * **The positive control is the point of the file, not a courtesy.** Without
 * one, a verifier that refused everything would pass both failure cases, which
 * is the refuses-everything failure this repo has already met once. And it is
 * only a control if it DISCRIMINATES: D2 passes only because the session
 * survived `goto`, so deleting the sign-in makes it fail. Before 4d0 it would
 * have passed with the sign-in deleted, which is what made 4d0 necessary.
 *
 * **What this file does not cover:** `navigation`. The demo server answers every
 * path with the same document, so navigation here cannot fail. That reason is
 * covered by the stub in `tests/unit/entry-verifier.spec.ts` and by nothing
 * here. Stated rather than implied.
 *
 * **And a route cannot be validated here at all.** This app ignores the path and
 * lets the session decide the view, so every `route` string would behave
 * identically. Whether a route opens the screen it names is answerable only
 * against an application that has routes.
 */

/** Both views, as a capture of this app records them. */
const capture: BoundedCapture = {
  sessionId: 'demo',
  states: [
    {
      id: 'login',
      label: 'login',
      url: 'http://127.0.0.1:4173/login',
      nodes: [
        { role: 'heading', name: 'Sign in', enabled: true },
        { role: 'button', name: 'Login', enabled: true },
      ],
      truncated: false,
    },
    {
      id: 'employees',
      label: 'employees',
      url: 'http://127.0.0.1:4173/employees',
      nodes: [
        { role: 'heading', name: 'Register employee', enabled: true },
        { role: 'button', name: 'Log out', enabled: true },
      ],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/**
 * Two modules whose entry states are mutually exclusive.
 *
 * "Employee registration" is provable only while signed IN. "Sign-in screen" is
 * provable only while signed OUT — so during a run, which signs in once, its
 * proof is genuinely absent while auth and navigation have both succeeded. That
 * is what makes `state-assert` a real outcome here rather than a stage skipped
 * to see what breaks.
 */
const MAP: ModuleMap = {
  'Employee registration': {
    route: '/employees',
    provenBy: { role: 'heading', name: 'Register employee' },
  },
  'Sign-in screen': {
    route: '/login',
    provenBy: { role: 'heading', name: 'Sign in' },
  },
};

const MAP_FILE = 'config/apps/bundled-demo/module-map.json';

/**
 * Signs in, and FAILS when the application refuses — reporting what it said.
 *
 * The thrown text is the app's own message, not a sentence written here. A
 * hand-written throw would make the `auth` verdict a fact about the test.
 */
const signInOrThrow =
  (login: LoginPage, username: string, password: string) => async (): Promise<void> => {
    await login.open();
    await login.login(username, password);
    if (await login.hasError()) {
      throw new Error(await login.errorMessage());
    }
  };

const row = (rowId: string): ResolvedAuthoredRow =>
  ({
    rowId,
    scenarioId: rowId.split(' / ')[0]!,
    testCaseId: rowId.split(' / ')[1]!,
    sheetRow: 3,
    title: rowId,
    outcome: 'ok',
    owner: 'none',
    steps: [
      {
        kind: 'assert',
        role: 'heading',
        name: 'Register employee',
        property: 'present',
        expected: true,
      },
    ],
    targets: [{ stepIndex: 0, role: 'heading', name: 'Register employee' }],
    clauseKinds: ['assert'],
    givenClauses: [],
    refusals: [],
    grades: [],
    writeRisk: 'read-only',
    summary: 'resolved',
  }) as ResolvedAuthoredRow;

test.describe('the entry verifier against the real demo app @demo', () => {
  test('D1: a wrong password is `auth`, in the application’s own words', async ({
    page,
    makePage,
    env,
  }) => {
    // wrong: reported as `state-assert`, and a QA is sent to look for a missing
    // element on a screen the run never got past the login form to see.
    const login = makePage(LoginPage);
    // The username is the environment's; only the wrong password is the test's,
    // and it is a literal here rather than anything read from a sheet.
    const verify = createEntryVerifier({
      map: MAP,
      capture,
      mapFile: MAP_FILE,
      page,
      signIn: signInOrThrow(login, env.users.admin!.username, 'not-the-password'),
    });

    expect(await verify('Employee registration')).toEqual({
      verified: false,
      reason: 'auth',
      detail: expect.stringContaining('Invalid credentials'),
    });
  });

  test('D2: signed in and navigated, the right proof verifies and the wrong one is `state-assert`', async ({
    page,
    makePage,
    env,
  }) => {
    // wrong: with no entry gate a run treats "not on the page" as a stale
    // capture and tells whoever captured the screen to re-run `pnpm inspect` —
    // about a capture that is current. That is §11.4's correction exactly.
    const login = makePage(LoginPage);
    const verify = createEntryVerifier({
      map: MAP,
      capture,
      mapFile: MAP_FILE,
      page,
      signIn: signInOrThrow(login, env.users.admin!.username, env.users.admin!.password),
    });

    // The positive control. It passes only because the sign-in happened AND
    // survived the navigation: with `signIn` removed, `goto('/employees')`
    // renders the signed-out view and this line fails.
    expect(await verify('Employee registration')).toEqual({ verified: true });

    // Discriminating against the line above: the same verifier, the same run,
    // the same sign-in — only the module differs, and so does the verdict.
    expect(await verify('Sign-in screen')).toEqual({
      verified: false,
      reason: 'state-assert',
      detail: expect.stringContaining('Sign in'),
    });
  });

  test('D3: an unreached module stops its rows while a reached one runs them', async ({
    page,
    makePage,
    env,
  }) => {
    // wrong: the unreached module's rows run anyway against whatever screen is
    // open, and their verdicts describe a page they were never written for.
    const login = makePage(LoginPage);
    const moduleByRow = new Map([
      ['REACHED / TC_1', 'Employee registration'],
      ['UNREACHED / TC_1', 'Sign-in screen'],
    ]);
    const entry: EntryControl = {
      moduleOf: (r) => moduleByRow.get(r.rowId)!,
      verify: createEntryVerifier({
        map: MAP,
        capture,
        mapFile: MAP_FILE,
        page,
        signIn: signInOrThrow(login, env.users.admin!.username, env.users.admin!.password),
      }),
    };

    let stepsRun = 0;
    const execute: StepExecutor = async ({ target }) => {
      stepsRun += 1;
      const count = await page.getByRole('heading', { name: target!.name, exact: true }).count();
      return count > 0
        ? { kind: 'passed', observed: `heading "${target!.name}" present=true` }
        : { kind: 'target-not-on-page', observed: `no heading named "${target!.name}"` };
    };

    const outcome = await executeAuthoredRows({
      resolved: [row('REACHED / TC_1'), row('UNREACHED / TC_1')],
      unreadable: [],
      execute,
      entry,
    });

    const byId = Object.fromEntries(outcome.results.map((r) => [r.rowId, r]));
    expect(byId['REACHED / TC_1']!.status).toBe('passed');

    const stopped = byId['UNREACHED / TC_1']!;
    expect(stopped.status).toBe('given-not-reached');
    if (stopped.status === 'given-not-reached') {
      expect(stopped.reason).toBe('state-assert');
      expect(stopped.module).toBe('Sign-in screen');
    }

    // Exactly one step ran — the reached module's. The other row never started,
    // which is the whole point of gating before the executor.
    expect(stepsRun).toBe(1);
    expect(outcome.tally.rowsRead).toBe(2);
  });
});
