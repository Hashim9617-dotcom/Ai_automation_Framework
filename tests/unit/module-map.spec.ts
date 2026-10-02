import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  assertEveryModuleMapped,
  assertProvenByInCapture,
  findRepoRoot,
  loadModuleMap,
  partitionMappedModules,
  validateModuleMap,
  type AccessibilityNode,
  type BoundedCapture,
  type CapturedState,
  type ModuleMap,
} from '@aitp/shared';

/**
 * The module map (`docs/phase-2-authored-cases.md`, step 4a).
 *
 *   MM1  the shipped map loads, and a broken one says what to do about it
 *   MM2  falsifier 1 — a module in the sheet with no entry is refused, by name
 *   MM3  falsifier 2 — a provenBy the capture does not hold fails at load
 *
 * `assertProvenByInCapture` is called by `createEntryVerifier` as of 4d, when
 * the verifier is built — so a `provenBy` the capture does not hold refuses
 * before a browser is opened, not row by row inside a run.
 */

const node = (role: string, name: string): AccessibilityNode => ({ role, name, enabled: true });

const state = (id: string, nodes: AccessibilityNode[]): CapturedState => ({
  id,
  label: id,
  url: `https://app.example/${id}`,
  nodes,
  truncated: false,
});

const capture = (states: CapturedState[]): BoundedCapture => ({
  sessionId: 's',
  states,
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
});

/** Two screens that share a header and differ in one heading each. */
const DEMO = capture([
  state('login', [node('heading', 'Sign in'), node('button', 'Login'), node('banner', 'Demo HR')]),
  state('employees', [
    node('heading', 'Register employee'),
    node('button', 'Save employee'),
    node('banner', 'Demo HR'),
  ]),
]);

const MAP: ModuleMap = {
  Login: { route: '/', provenBy: { role: 'heading', name: 'Sign in' } },
};

let dir: string;
const write = (contents: unknown): string => {
  const file = path.join(dir, `map-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
};

test.beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aitp-module-map-'));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.describe('the module map loads, or says what to fix (MM1) @unit', () => {
  test('MM1: the map shipped for the demo app loads', () => {
    // wrong: the file committed for QAs to copy is itself invalid, and the first
    // person to follow the example gets an error about their own edit.
    const map = loadModuleMap(
      path.join(findRepoRoot(), 'config', 'apps', 'bundled-demo', 'module-map.json'),
    );

    expect(Object.keys(map).length).toBeGreaterThan(0);
    for (const entry of Object.values(map)) expect(entry.route.startsWith('/')).toBe(true);
  });

  test('MM1: the DERIVED map for the customer application loads too', () => {
    // wrong: the derived file is invalid and nobody finds out until a run needs it —
    // and `runSheet` has no production caller yet, so "nobody" could be months.
    //
    // It is a separate test from the demo map above because the two are different
    // claims: that one is an example a QA copies, this one is computed from real
    // captures and is the file a DMS run would actually load.
    const map = loadModuleMap(
      path.join(findRepoRoot(), 'config', 'apps', 'dms', 'module-map.json'),
    );

    expect(Object.keys(map).length).toBeGreaterThan(5);
    for (const [module, entry] of Object.entries(map)) {
      expect(entry.route.startsWith('/'), `${module} route`).toBe(true);
      expect(entry.provenBy.name.trim().length, `${module} provenBy`).toBeGreaterThan(0);
    }
    // The comment keys that record the derivation are NOT modules.
    expect(Object.keys(map).filter((k) => k.startsWith('//'))).toEqual([]);
  });

  test('MM1: a `//` key is a comment, and a malformed entry still refuses', () => {
    // wrong: the skip rule is written as "ignore anything that fails validation", so
    // a genuinely broken entry is swallowed and the module silently goes unmapped —
    // which `assertEveryModuleMapped` then reports as a sheet problem.
    //
    // Both halves, in one fixture: the comment is skipped and the bad entry is not.
    const withComment = write({
      '//': 'why this map looks the way it does',
      '//checkByEye': 'another note',
      Dashboard: { route: '/dashboard', provenBy: { role: 'heading', name: 'Dashboard' } },
    });
    const map = loadModuleMap(withComment);
    expect(Object.keys(map)).toEqual(['Dashboard']);

    const withBadEntry = write({
      '//': 'a note',
      Dashboard: 'not an object',
    });
    expect(() => loadModuleMap(withBadEntry)).toThrow(/module "Dashboard"/);
  });

  test('MM1: a map of ONLY comments is refused, not read as empty', () => {
    // wrong: the filter drops every key and the emptiness check passes a map with
    // nothing in it — the `catch`-returns-empty shape, where a file that explains
    // itself and defines nothing reads as a valid map.
    expect(() => loadModuleMap(write({ '//': 'all notes, no modules' }))).toThrow(
      /has no modules in it/,
    );
  });

  test('MM1: a map with no modules in it is refused', () => {
    // wrong: an empty map validates perfectly, and then every module in the
    // sheet is unmapped — a file that says nothing reads as a file that agrees.
    expect(() => loadModuleMap(write({}))).toThrow(/no modules in it/);
  });

  test('MM1: a route that is not a path names the module and the fix', () => {
    // wrong: "https://dms.example/search" is accepted, and the same file then
    // cannot be used against a second environment, which is why it holds paths.
    const file = write({
      'Global Search': {
        route: 'https://dms.example/search',
        provenBy: { role: 'heading', name: 'Welcome to Search' },
      },
    });

    expect(() => loadModuleMap(file)).toThrow(/module "Global Search".*must start with "\/"/s);
  });

  test('MM1: a role no run can address is refused, with examples of what to use', () => {
    // wrong: "RootWebArea" is accepted, and at 4d the proof silently resolves to
    // nothing — the §11.2 failure, where a getByRole that returns zero without
    // throwing reads as "the element is gone".
    const file = write({
      Login: { route: '/', provenBy: { role: 'RootWebArea', name: 'Demo' } },
    });

    expect(() => loadModuleMap(file)).toThrow(/RootWebArea.*button, heading, link/s);
  });

  test('MM1: a missing provenBy says what it is FOR, not just that it is missing', () => {
    // wrong: "provenBy is required" tells a QA nothing about where to get one;
    // the message has to send them to the capture for that screen.
    const file = write({ Login: { route: '/' } });

    expect(() => loadModuleMap(file)).toThrow(/proves a run reached this screen/);
  });
});

test.describe('an unmapped module is refused, never skipped (MM2) @unit', () => {
  test('MM2: every unmapped module is named, and its rows are the only ones refused', () => {
    // wrong: unmapped modules are skipped, the run reports only what it mapped,
    // and nobody learns their screen was never tested — with seven to nine
    // people sharing one file that is a silence nobody is looking for.
    //
    // 3b changed the CONSEQUENCE, not the detection: the partition returns both
    // halves so a caller refuses those modules' rows and runs the rest. One
    // misspelt Module cell used to cost 400 rows.
    const { mapped, unmapped } = partitionMappedModules(
      ['Login', 'Workflow', 'Audit Logs'],
      MAP,
      'm.json',
    );

    expect(mapped).toEqual(['Login']);
    expect(unmapped.map((entry) => entry.module)).toEqual(['Audit Logs', 'Workflow']);
    // The reason travels with the module, because it becomes a row's `detail` and
    // a QA reading the report has to know which file to edit.
    expect(unmapped[0]!.why).toMatch(/no entry in m\.json/);
    expect(unmapped[0]!.why).toMatch(/Module column/);
  });

  test('MM2: a fully mapped sheet leaves nothing unmapped', () => {
    // wrong: a partition that reported everything unmapped would pass the test
    // above while refusing every correct map — the refuses-everything failure.
    const { mapped, unmapped } = partitionMappedModules(['Login', 'Login'], MAP, 'm.json');

    expect(unmapped).toEqual([]);
    // Deduplicated: 400 rows of one module are one module.
    expect(mapped).toEqual(['Login']);
  });

  test('MM2: the whole-run refusal is still expressible', () => {
    // wrong: `assertEveryModuleMapped` is kept for a caller that cannot report per
    // module, and nothing exercises it — so the guarantee it names could rot while
    // reading as present. It is a thin wrapper now, which is exactly the kind of
    // code that stops matching its wrapper without anybody noticing.
    expect(() => assertEveryModuleMapped(['Login', 'Workflow'], MAP, 'm.json')).toThrow(
      /1 module\(s\).*"Workflow"/s,
    );
    expect(() => assertEveryModuleMapped(['Login'], MAP, 'm.json')).not.toThrow();
  });
});

test.describe('a provenBy the capture cannot prove is settled at LOAD (MM3) @unit', () => {
  test('MM3: a proof element that is not in the capture is unprovable', () => {
    // wrong: it is accepted here and fails at 4d instead, in a browser, where
    // "not on the page" is indistinguishable from a stale capture.
    const map: ModuleMap = {
      Search: { route: '/search', provenBy: { role: 'heading', name: 'Welcome to Search' } },
    };

    const { provable, unprovable } = validateModuleMap(map, DEMO, 'm.json');

    expect(provable).toEqual({});
    expect(unprovable[0]!.why).toMatch(/"Welcome to Search" is not in the capture/);
    // And it says what the capture DOES have, or the reader has to go and look.
    expect(unprovable[0]!.why).toMatch(/Sign in|Register employee/);
  });

  test('MM3: a proof at TWO ROUTES cannot prove either', () => {
    // wrong: the shared header is accepted, and a run "verifies" it is on the
    // employees screen while sitting on the login screen — the entry-state
    // mistake DEMO_4 made, now blessed by config.
    const map: ModuleMap = {
      'Employee registration': {
        route: '/employees',
        provenBy: { role: 'banner', name: 'Demo HR' },
      },
    };

    const { unprovable } = validateModuleMap(map, DEMO, 'm.json');

    expect(unprovable[0]!.why).toMatch(/at 2 different routes \("\/employees", "\/login"\)/);
  });

  test('MM3: the SAME anchor across many states of ONE route is provable', () => {
    // wrong: "is in 58 states, so it cannot say which screen a run reached" — the
    // old rule, which counted STATES. Measured 2026-10-02 against the 10 DMS
    // sessions on disk: all nine mapped modules were refused, `File Explorer` and
    // `Document` for being in 58 states of the SAME screen. Fifty-eight captures of
    // one screen are still one screen.
    //
    // DISCRIMINATING on purpose: three states, one route, so a state-counting rule
    // refuses this fixture and a route-grouping one accepts it.
    const walkedThrice = capture([
      state('files-1', [node('tree', 'Workspaces'), node('heading', 'Shared with me')]),
      state('files-2', [node('tree', 'Workspaces'), node('button', 'New workspace')]),
      state('files-3', [node('tree', 'Workspaces')]),
    ]);
    // All three at the same route — `state()` derives the URL from the id, so they
    // are set explicitly here.
    const oneRoute = {
      ...walkedThrice,
      states: walkedThrice.states.map((s) => ({ ...s, url: 'https://app.example/files' })),
    };
    const map: ModuleMap = {
      'File Explorer': { route: '/files', provenBy: { role: 'tree', name: 'Workspaces' } },
    };

    const { provable, unprovable } = validateModuleMap(map, oneRoute, 'm.json');

    expect(unprovable).toEqual([]);
    expect(provable['File Explorer']).toEqual({ route: '/files', states: 3 });
  });

  test('MM3: a proof matching twice on one screen is not a proof', () => {
    // wrong: two matches are treated as found, and the run proves it reached a
    // screen by pointing at an element it cannot tell apart from another.
    //
    // An ambiguous state is excluded from the hits rather than refusing outright,
    // so one bad capture among 58 cannot disqualify a good anchor. With nothing
    // left, the message says ambiguity was why — which is `Dashboard` in the real
    // DMS map: 0 clean hits and 4 ambiguous states.
    const twice = capture([
      state('files', [node('button', 'Open'), node('button', 'Open'), node('heading', 'Files')]),
    ]);
    const map: ModuleMap = {
      Files: { route: '/files', provenBy: { role: 'button', name: 'Open' } },
    };

    const { provable, unprovable } = validateModuleMap(map, twice, 'm.json');

    expect(provable).toEqual({});
    expect(unprovable[0]!.why).toMatch(/matches 2 elements in every state that has it/);
  });

  test('MM3: a proof captured at a route the map does not name is unprovable', () => {
    // wrong: an anchor that identifies /login is accepted as proof for a module the
    // map sends to /employees, so the run opens one screen and proves another. The
    // old rule could not ask this question at all — hits carried no route.
    const map: ModuleMap = {
      'Employee registration': {
        route: '/employees',
        provenBy: { role: 'heading', name: 'Sign in' },
      },
    };

    const { unprovable } = validateModuleMap(map, DEMO, 'm.json');

    expect(unprovable[0]!.why).toMatch(/the map sends this module to "\/employees"/);
    expect(unprovable[0]!.why).toMatch(/captured at "\/login"/);
  });

  test('MM3: a good map returns the route each module proved, derived not declared', () => {
    // wrong: the check passes and returns nothing, so 4d still has to be TOLD
    // which screen a module means — and a route written by hand in config and
    // never compared to the capture is one nobody verified.
    const map: ModuleMap = {
      Login: { route: '/login', provenBy: { role: 'heading', name: 'Sign in' } },
      'Employee registration': {
        route: '/employees',
        provenBy: { role: 'heading', name: 'Register employee' },
      },
    };

    expect(validateModuleMap(map, DEMO, 'm.json')).toEqual({
      provable: {
        Login: { route: '/login', states: 1 },
        'Employee registration': { route: '/employees', states: 1 },
      },
      unprovable: [],
    });
  });

  test('MM3: an entry no sheet names is still VALIDATED, not skipped', () => {
    // wrong: only the modules a sheet mentions get checked, so an unprovable entry
    // sits in the file for months and announces itself the first time somebody
    // writes a row for that screen. That breadth is what caught `Login`'s anchor in
    // the demo fixture (tests/demo/run-sheet.spec.ts), and it is kept: the triage of
    // WHICH unprovable entries refuse rows happens in the caller, not here.
    const map: ModuleMap = {
      Login: { route: '/login', provenBy: { role: 'heading', name: 'Sign in' } },
      Nobody: { route: '/nobody', provenBy: { role: 'heading', name: 'Not Captured' } },
    };

    const { provable, unprovable } = validateModuleMap(map, DEMO, 'm.json');

    expect(Object.keys(provable)).toEqual(['Login']);
    expect(unprovable.map((entry) => entry.module)).toEqual(['Nobody']);
  });

  test('MM3: a capture with no states is refused rather than vacuously passing', () => {
    // wrong: zero states means zero modules checked, and the validator reports
    // clean — a scan that read nothing saying everything is fine. A THROW and not
    // an empty partition, because "nothing was searched" is not "nothing matched".
    expect(() => validateModuleMap(MAP, capture([]), 'm.json')).toThrow(/has no states/);
  });

  test('MM3: the whole-map refusal is still expressible', () => {
    // wrong: `assertProvenByInCapture` is kept so the old guarantee stays sayable,
    // and nothing exercises it — a wrapper that rots while reading as present.
    expect(() =>
      assertProvenByInCapture(
        { Search: { route: '/search', provenBy: { role: 'heading', name: 'Nope' } } },
        DEMO,
        'm.json',
      ),
    ).toThrow(/is not in the capture/);
    expect(
      assertProvenByInCapture(
        { Login: { route: '/login', provenBy: { role: 'heading', name: 'Sign in' } } },
        DEMO,
        'm.json',
      ),
    ).toEqual({ Login: { route: '/login', states: 1 } });
  });
});
