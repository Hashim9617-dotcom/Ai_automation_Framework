import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  assertEveryModuleMapped,
  assertProvenByInCapture,
  findRepoRoot,
  loadModuleMap,
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
  test('MM2: every unmapped module is named', () => {
    // wrong: unmapped modules are skipped, the run reports only what it mapped,
    // and nobody learns their screen was never tested — with seven to nine
    // people sharing one file that is a silence nobody is looking for.
    expect(() =>
      assertEveryModuleMapped(['Login', 'Workflow', 'Audit Logs'], MAP, 'm.json'),
    ).toThrow(/2 module\(s\).*"Audit Logs", "Workflow"/s);
  });

  test('MM2: a fully mapped sheet passes', () => {
    // wrong: a check that threw for every input would pass the test above while
    // making any correct map unusable — the refuses-everything failure.
    expect(() => assertEveryModuleMapped(['Login', 'Login'], MAP, 'm.json')).not.toThrow();
  });
});

test.describe('a provenBy the capture does not hold fails at LOAD (MM3) @unit', () => {
  test('MM3: a proof element that is not in the capture is refused', () => {
    // wrong: it is accepted here and fails at 4d instead, in a browser, where
    // "not on the page" is indistinguishable from a stale capture.
    const map: ModuleMap = {
      Search: { route: '/', provenBy: { role: 'heading', name: 'Welcome to Search' } },
    };

    expect(() => assertProvenByInCapture(map, DEMO, 'm.json')).toThrow(
      /"Welcome to Search" is not in the capture.*"login", "employees"/s,
    );
  });

  test('MM3: a proof that is on TWO screens cannot prove either', () => {
    // wrong: the shared header is accepted, and a run "verifies" it is on the
    // employees screen while sitting on the login screen — the entry-state
    // mistake DEMO_4 made, now blessed by config.
    const map: ModuleMap = {
      'Employee registration': { route: '/', provenBy: { role: 'banner', name: 'Demo HR' } },
    };

    expect(() => assertProvenByInCapture(map, DEMO, 'm.json')).toThrow(
      /is in 2 states \("login", "employees"\)/,
    );
  });

  test('MM3: a proof matching twice on one screen is not a proof', () => {
    // wrong: two matches are treated as found, and the run proves it reached a
    // screen by pointing at an element it cannot tell apart from another.
    const twice = capture([
      state('files', [node('button', 'Open'), node('button', 'Open'), node('heading', 'Files')]),
    ]);
    const map: ModuleMap = {
      Files: { route: '/', provenBy: { role: 'button', name: 'Open' } },
    };

    expect(() => assertProvenByInCapture(map, twice, 'm.json')).toThrow(
      /matches 2 elements in state "files"/,
    );
  });

  test('MM3: a good map returns the state each module proved, derived not declared', () => {
    // wrong: the check passes and returns nothing, so 4d still has to be TOLD
    // which capture state a module means — and a state id written by hand in
    // config is one nobody verified against the capture.
    const map: ModuleMap = {
      Login: { route: '/', provenBy: { role: 'heading', name: 'Sign in' } },
      'Employee registration': {
        route: '/',
        provenBy: { role: 'heading', name: 'Register employee' },
      },
    };

    expect(assertProvenByInCapture(map, DEMO, 'm.json')).toEqual({
      Login: 'login',
      'Employee registration': 'employees',
    });
  });

  test('MM3: a capture with no states is refused rather than vacuously passing', () => {
    // wrong: zero states means zero modules checked, and the loader reports
    // clean — a scan that read nothing saying everything is fine.
    expect(() => assertProvenByInCapture(MAP, capture([]), 'm.json')).toThrow(/has no states/);
  });
});
