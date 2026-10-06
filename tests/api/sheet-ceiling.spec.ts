import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { buildXlsx } from '../support/xlsx-fixture';
import { freePort } from '../support/free-port';
import { execFileSyncClean, spawnClean } from '../support/spawn-clean';

/**
 * THE COMMAND BOX MUST NOT TURN A WITHHELD NUMBER INTO A MISSING WORKBOOK (B1).
 *
 * `withAllModulesCaptured` became `number | null` in B1: null whenever a module has
 * no capture, because `automatable` is the resolver's verdict and those rows have no
 * state to resolve against. This service is the reader that ALREADY turns a null
 * into "no workbook is configured" — `sheetRows: null` means exactly that — so a
 * null ceiling arriving here was one careless `??` away from telling a QA their
 * workbook was missing when it had been read perfectly well.
 *
 * Three states, three sentences, measured over HTTP rather than asserted about a
 * function: the confusion this guards against is a RENDERING one, and it can only
 * happen at the boundary.
 *
 * ## §AJ: this test supplies every environment it reads
 *
 * The API is spawned with its own `AITP_REPO_ROOT`, holding the environment file,
 * the module map, the capture and the workbook path it will use. Nothing here reads
 * this machine's `.env`, its `artifacts/` or its captures — four guards in two days
 * were green on a configured machine and red on a clean checkout, every one of them
 * because it read an environment it had not supplied.
 */

const ROOT = findRepoRoot();
const API_DIR = path.join(ROOT, 'apps', 'api');
const ENTRY = path.join(API_DIR, 'dist', 'apps', 'api', 'src', 'main.js');

/** One module captured, one named by the sheet and never captured. */
const CAPTURE = {
  application: 'bundled-demo',
  baseUrl: 'http://127.0.0.1:4173',
  capturedAt: '2026-01-01T00:00:00.000Z',
  states: [
    {
      id: 'dashboard',
      label: 'dashboard',
      url: 'http://127.0.0.1:4173/dashboard',
      nodes: [
        { role: 'heading', name: 'Recent Files', enabled: true },
        { role: 'link', name: 'Reports', enabled: true },
      ],
      truncated: false,
    },
  ],
  transitions: [],
};

const MODULE_MAP = {
  Dashboard: {
    route: '/dashboard',
    provenBy: { role: 'heading', name: 'Recent Files' },
  },
};

const ENVIRONMENT = {
  name: 'local',
  application: 'bundled-demo',
  baseUrl: 'http://127.0.0.1:4173',
  apiBaseUrl: 'http://127.0.0.1:4173',
  timeouts: { action: 10000, navigation: 20000, expect: 8000, test: 60000 },
  retries: 0,
  workers: 1,
  users: { admin: { username: 'fixture.admin', password: 'fixture-only', role: 'admin' } },
  features: { selfHealing: false, aiRootCause: false, video: false, trace: true },
};

/**
 * A two-row sheet: one row in the CAPTURED module, one in a module the map and the
 * capture have never heard of.
 *
 * That second row is what makes the fixture discriminating. Without it every module
 * is captured, the second ceiling is a number, and this file could not tell a
 * withheld figure from a present one.
 */
/**
 * THE REAL 22-COLUMN HEADER, because the layout is a GATE (8d27ac1).
 *
 * The first draft of this fixture invented a tidy 16-column header, and
 * `readFinalTestCases` threw — correctly: a sheet named `Final Test cases` whose
 * headers are not that layout is refused, because column positions come from the
 * layout and reading it anyway populates every row from the wrong columns.
 *
 * `loadSheetRows` caught the throw and returned `null`, the sheet door was never
 * selected, and the symptom was `door: 'none'`. That is the gate working and it is
 * worth recording: the fixture had to be made REAL, not the reader made lenient.
 */
const HEADER = [
  'Module',
  'Feature',
  'Scenario ID',
  'Test Case ID',
  'Scenario Name',
  'Test Objective',
  'Test Type',
  'Priority',
  'Preconditions',
  'Given',
  'When',
  'And',
  'Then',
  'Test Data',
  'Actual Result',
  'Status',
  'Issue No.',
  'Type',
  'SOC DMS',
  'Issue No.',
  'Status 4',
  'Status 5',
];

const sheetRow = (module: string, scenarioId: string): string[] => {
  const cells = new Array<string>(22).fill('');
  cells[0] = module;
  cells[1] = 'reports';
  cells[2] = scenarioId;
  cells[3] = 'TC_1';
  cells[4] = 'open the reports link';
  cells[5] = 'reports open';
  cells[6] = 'Functional';
  cells[7] = 'High';
  cells[10] = 'click the "Reports" link';
  cells[12] = 'verify "Recent Files" is visible';
  cells[17] = 'Positive';
  return cells;
};

const SHEET_ROWS = [HEADER, sheetRow('Dashboard', 'SI_1'), sheetRow('Workflow', 'SI_2')];

let api: ChildProcess | undefined;
let port = 0;
let fixtureRoot = '';

async function post(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

test.describe('the sheet ceiling over HTTP @api', () => {
  test.beforeAll(async () => {
    if (!existsSync(ENTRY)) {
      execFileSyncClean('pnpm', ['--filter', '@aitp/api', 'build'], {
        cwd: ROOT,
        stdio: 'pipe',
        shell: process.platform === 'win32',
      });
    }

    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'aitp-ceiling-'));
    const write = (relative: string, contents: string | Buffer): string => {
      const file = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
      return file;
    };

    write(path.join('config', 'env', 'local.json'), JSON.stringify(ENVIRONMENT));
    write(
      path.join('config', 'apps', 'bundled-demo', 'module-map.json'),
      JSON.stringify(MODULE_MAP),
    );
    write(
      path.join('artifacts', 'bundled-demo', 'inspect', '2026-01-01T00-00-00Z', 'capture.json'),
      JSON.stringify(CAPTURE),
    );
    const workbook = write(
      'fixture-sheet.xlsx',
      buildXlsx([{ name: 'Final Test cases', rows: SHEET_ROWS }]),
    );

    port = await freePort();
    api = spawnClean(process.execPath, [ENTRY], {
      cwd: API_DIR,
      // EVERYTHING THIS TEST READS, SUPPLIED BY THIS TEST (§AJ). `spawnClean`
      // removes NODE_PATH and NODE_OPTIONS; these three are the whole world the
      // ceiling is computed from.
      env: {
        API_PORT: String(port),
        AITP_REPO_ROOT: fixtureRoot,
        AITP_SHEET_PATH: workbook,
        TEST_ENV: 'local',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    api.stdout?.on('data', (chunk) => (output += String(chunk)));
    api.stderr?.on('data', (chunk) => (output += String(chunk)));

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (api.exitCode !== null) {
        throw new Error(
          `the API exited with ${api.exitCode} (port ${port}):\n${output.slice(-2000)}`,
        );
      }
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw new Error(`the API did not answer on ${port}:\n${output.slice(-2000)}`);
  });

  test.afterAll(() => {
    api?.kill();
  });

  test('CB7: a withheld second ceiling says NOT MEASURABLE, never "not configured"', async () => {
    // wrong: passed through a `??` or an `|| 0`, the null becomes `0.0%` — "the
    // ceiling stays at nothing even with every screen captured", which nobody has
    // measured — or it falls into this service's existing null handling and the QA
    // is told their workbook is missing while the first ceiling, on the same
    // response, was computed from it.
    const body = await post({
      command: 'test open the reports link',
      source: 'sheet',
      environment: 'local',
      dryRun: true,
    });

    expect(body.door).toBe('sheet');
    const ceiling = body.ceiling as Record<string, unknown>;

    // THE SHEET WAS READ. That is the half a "not configured" answer would deny,
    // and asserting it first is what makes the rest meaningful (§T: the check had
    // a subject).
    expect(ceiling.state).toBe('measured');
    expect(typeof ceiling.withCurrentCaptures).toBe('number');
    expect(ceiling.modulesTotal).toBe(2);
    expect(ceiling.modulesCaptured).toBe(1);

    // AND THE SECOND NUMBER IS WITHHELD, in words, as its own thing.
    expect(ceiling.withAllModulesCaptured).toBeNull();
    expect(String(ceiling.withAllModulesCapturedWhy)).toContain('not measurable');
    expect(String(ceiling.withAllModulesCapturedWhy)).toContain('resolve-based');
    // Never the other two answers, which mean "fix your configuration".
    expect(ceiling.state).not.toBe('not-configured');
    expect(ceiling.state).not.toBe('could-not-load');
    expect(JSON.stringify(ceiling)).not.toContain('no workbook is configured');
  });

  test('CB7: with EVERY module captured the second number is present, and the sentence is gone', async () => {
    // wrong: a response hard-wired to report "not measurable" would pass the test
    // above forever, and the second ceiling would never come back once the screens
    // were walked. This is the only case that tells a withheld number from a
    // permanently withheld one — the refuses-everything failure, applied to a field.
    //
    // The same running API, a DIFFERENT environment file: `every` names an
    // application whose map and capture cover both of the sheet's modules. So the
    // only thing that changed is capture coverage, which is what the pair is about.
    const every = {
      ...ENVIRONMENT,
      name: 'every',
      application: 'every-module',
    };
    const write = (relative: string, contents: string): void => {
      const file = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    };
    write(path.join('config', 'env', 'every.json'), JSON.stringify(every));
    write(
      path.join('config', 'apps', 'every-module', 'module-map.json'),
      JSON.stringify({
        ...MODULE_MAP,
        Workflow: { route: '/workflow', provenBy: { role: 'heading', name: 'Requests' } },
      }),
    );
    write(
      path.join('artifacts', 'every-module', 'inspect', '2026-01-01T00-00-00Z', 'capture.json'),
      JSON.stringify({
        ...CAPTURE,
        application: 'every-module',
        states: [
          ...CAPTURE.states,
          {
            id: 'workflow',
            label: 'workflow',
            url: 'http://127.0.0.1:4173/workflow',
            nodes: [
              { role: 'heading', name: 'Requests', enabled: true },
              { role: 'link', name: 'Reports', enabled: true },
              { role: 'heading', name: 'Recent Files', enabled: true },
            ],
            truncated: false,
          },
        ],
      }),
    );

    const body = await post({
      command: 'test open the reports link',
      source: 'sheet',
      environment: 'every',
      dryRun: true,
    });
    const ceiling = body.ceiling as Record<string, unknown>;

    expect(ceiling.state).toBe('measured');
    expect(ceiling.modulesCaptured).toBe(2);
    expect(ceiling.modulesTotal).toBe(2);
    expect(typeof ceiling.withAllModulesCaptured).toBe('number');
    // No explanation beside a number that exists. A sentence printed either way is
    // how a reader learns to ignore both.
    expect(ceiling.withAllModulesCapturedWhy).toBeNull();
  });
});
