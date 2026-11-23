import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import { EVIDENCE_MANIFEST } from '@aitp/reporting-engine';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * A REAL RUN WITH A REAL FLAKY TEST KEEPS ITS EVIDENCE.
 *
 * ## What the unit suite cannot establish
 *
 * `tests/unit/failure-evidence.spec.ts` drives the reporter with synthetic results
 * and proves the ARCHIVE's rules: flaky counts as failure, a listed-but-absent file
 * is reported missing, an inline attachment is not evidence. What it cannot prove is
 * that Playwright LEAVES the files there — `trace: 'retain-on-failure'` deletes the
 * trace of an attempt that passed, and whether the failed attempt's survives is a
 * fact about a process (§R).
 *
 * So this runs `tests/synthetic/flaky.spec.ts` for real: one test that fails on its
 * first attempt and passes on the retry, which is the case that loses evidence
 * silently because the run ends GREEN.
 *
 * ## Fully isolated, and that was learned the hard way
 *
 * The child gets its own config, its own `testDir` and its own output directories in
 * a temp folder. `notify-drop-e2e.spec.ts` spent a session being intermittently red
 * because its child ran this repo's `globalSetup`, which deletes
 * `artifacts/test-results` — the directory the PARENT run is writing into. This
 * config names no `globalSetup` at all, so there is nothing to collide with.
 *
 * The config file is written INSIDE the repository, under gitignored `.aitp-local/`,
 * for one reason: Playwright resolves `tsconfig` from the config's own directory, so
 * a config in a temp folder cannot resolve `@aitp/*` and the synthetic spec's import
 * of `NETWORK_ATTACHMENT` would fail.
 */

const ROOT = findRepoRoot();
const PLAYWRIGHT = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const REPORTER = path.join(
  ROOT,
  'packages',
  'reporting-engine',
  'src',
  'reporters',
  'aitp-reporter.ts',
);

/** Forward slashes: this text goes into a TypeScript source as string literals. */
const posix = (value: string): string => value.split(path.sep).join('/');

function childConfig(options: { artifacts: string }): string {
  const reports = posix(path.join(options.artifacts, 'reports'));
  return [
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    `  testDir: ${JSON.stringify(posix(path.join(ROOT, 'tests', 'synthetic')))},`,
    "  testMatch: '**/*.spec.ts',",
    `  outputDir: ${JSON.stringify(posix(path.join(options.artifacts, 'test-results')))},`,
    '  retries: 1,',
    '  workers: 1,',
    '  reporter: [',
    "    ['list'],",
    `    [${JSON.stringify(posix(REPORTER))}, { outputDir: ${JSON.stringify(reports)} }],`,
    '  ],',
    '  use: {',
    "    ...devices['Desktop Chrome'],",
    "    trace: 'retain-on-failure',",
    "    screenshot: 'only-on-failure',",
    '  },',
    '});',
    '',
  ].join('\n');
}

test.describe('a flaky test keeps its evidence in a real run @demo', () => {
  test.setTimeout(240_000);

  test('F1: the run ends GREEN and the failed attempt’s evidence is in the archive', () => {
    // wrong: archiving on `failed` only, so this run — which Playwright reports as
    // passed, with one flaky test — would keep nothing at all. The trace of the
    // attempt that failed is the only one `retain-on-failure` keeps, and it belongs
    // to an attempt whose result the run does not report. That is how Run A's flaky
    // evidence for SQ-002 and TAX-001 was lost before anybody read it.
    const artifacts = mkdtempSync(path.join(tmpdir(), 'aitp-flaky-ev-'));
    const marker = path.join(artifacts, 'attempted.marker');
    const configFile = path.join(ROOT, '.aitp-local', `synthetic-${process.pid}.config.ts`);
    writeFileSync(configFile, childConfig({ artifacts }), 'utf8');
    try {
      const result = spawnSyncClean(
        process.execPath,
        [PLAYWRIGHT, 'test', '--config', configFile],
        {
          cwd: ROOT,
          maxBuffer: 40 * 1024 * 1024,
          env: {
            TEST_ENV: 'local',
            LOG_LEVEL: 'info',
            AITP_FIXTURE_ONLY: '1',
            AITP_FLAKY_MARKER: marker,
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;

      // §T — the run has to have HAPPENED and have been FLAKY, or everything below
      // is about an empty directory. Both halves: a green run that never retried
      // would satisfy "exit 0" while proving nothing.
      expect(result.status, `the child did not end green:\n${output}`).toBe(0);
      expect(output, 'the child did not produce a flaky test').toMatch(/1 flaky/);

      const runsDir = path.join(artifacts, 'runs');
      expect(existsSync(runsDir), `nothing was archived:\n${output}`).toBe(true);
      const runIds = readdirSync(runsDir);
      expect(runIds).toHaveLength(1);
      const archive = path.join(runsDir, runIds[0]!);

      // THE MANIFEST, which is the auditable claim rather than the directory's
      // existence. All three kinds, for the one flaky test.
      const manifest = JSON.parse(readFileSync(path.join(archive, EVIDENCE_MANIFEST), 'utf8')) as {
        tests: Array<{
          title: string;
          outcome: string;
          attempts: number;
          present: string[];
          missing: string[];
        }>;
      };
      // ONE entry, for one test, over two attempts. This assertion is the reason the
      // manifest groups by test: the first run of this spec found two entries — the
      // failed attempt with all three kinds, and the passing retry with only the
      // network record, warning about a run whose evidence was complete.
      expect(manifest.tests).toHaveLength(1);
      expect(manifest.tests[0]!.attempts).toBe(2);
      expect(manifest.tests[0]!.outcome).toBe('flaky');
      expect(
        manifest.tests[0]!.missing,
        `evidence missing from a real flaky run: ${manifest.tests[0]!.missing.join(', ')}`,
      ).toEqual([]);
      expect(manifest.tests[0]!.present).toEqual(['trace', 'screenshot', 'network']);

      // AND THE FILES ARE REALLY THERE. The manifest is written from the result's
      // attachment paths; this walks the archived copy, so a manifest that was right
      // about the original and wrong about the copy cannot pass.
      const archived = walk(path.join(archive, 'test-results'));
      expect(
        archived.some((file) => file.endsWith('trace.zip')),
        'no trace in the archive',
      ).toBe(true);
      expect(
        archived.some((file) => file.endsWith('.png')),
        'no screenshot in the archive',
      ).toBe(true);
      expect(
        archived.some((file) => file.endsWith('network.json')),
        'no network record in the archive',
      ).toBe(true);
    } finally {
      rmSync(configFile, { force: true });
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
});

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}
