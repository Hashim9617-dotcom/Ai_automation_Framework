import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * `tests/app/**` IS COLLECTED ONLY FOR THE APPLICATION IT WAS WRITTEN AGAINST.
 *
 * Six specs and seven page objects under `tests/app/` describe DmsSynergy — its
 * sidebar, its upload wizard, its admin screens. Nothing said so. The project split
 * in `playwright.config.ts` was demo-vs-live, so ANY non-local environment collected
 * all of it. Measured 2026-09-30 with a second application declared as `app2`:
 *
 *     Total: 47 tests in 8 files
 *
 * every one a DMS spec. A QA who adds their own application and runs `pnpm test`
 * would have driven DMS's page objects against their app, and the `@write` tests
 * live in that same suite.
 *
 * ## Why this test spawns
 *
 * The decision is a module-level `const` in `playwright.config.ts`, evaluated when
 * the config loads. There is no function to call: the config cannot be imported
 * twice with two values of `TEST_ENV` in one process, and a copy of the rule here
 * would be a second rule that drifts — which is the thing `spawn-clean` exists for.
 * So this asks the runner, which is the only thing whose answer is the real one.
 *
 * `--list` collects and prints; it runs no test and opens no browser.
 */

const ROOT = findRepoRoot();

/**
 * `playwright test --list` for one environment — BOTH streams, joined.
 *
 * Stdout alone is not the answer. The collected list goes to stdout and the "no
 * specs for application X" notice goes to STDERR, deliberately: this repo has a
 * standing finding that its own logger corrupted `--list --reporter=json` by
 * writing to stdout, so a notice belongs on the other stream. A test reading only
 * stdout finds no message and concludes the guard did not fire — which is what the
 * first draft of this test concluded.
 */
const listFor = (testEnv: string, extra: Record<string, string> = {}): string => {
  const { stdout, stderr } = runList(testEnv, extra);
  return `${stdout}\n${stderr}`;
};

const runList = (testEnv: string, extra: Record<string, string>) =>
  spawnSyncClean(
    // `process.execPath` and the CLI's own entry point, NOT `npx`. Node 24 on
    // Windows refuses to spawn a `.cmd` without `shell: true` (EINVAL), and a shell
    // is the layer this repo does not put between itself and a command.
    process.execPath,
    [
      path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--project=chromium',
      '--list',
    ],
    {
      cwd: ROOT,
      maxBuffer: 20 * 1024 * 1024,
      // Both streams captured, so neither the list nor the notice is lost.
      stdio: ['ignore', 'pipe', 'pipe'],
      // TEST_ENV is the whole input. `.env` in the repo may say something else, and
      // a shell-exported value wins over it, so this is the value under test.
      env: { TEST_ENV: testEnv, LOG_LEVEL: 'error', ...extra },
    },
  );

/**
 * ONE APPLICATION'S SPECS DO NOT IMPORT ANOTHER'S.
 *
 * `tests/apps/<application>/` exists so a live project finds one application's specs
 * BY PATH rather than by a comparison in the config. A page object borrowed across
 * that line puts a second application's selectors into a run, and the structure that
 * was supposed to keep them apart stops meaning anything.
 *
 * ## Why this is a test and not a lint rule
 *
 * The first attempt was `no-restricted-imports` in `eslint.config.mjs`. A planted
 * violation — `tests/apps/other/probe.spec.ts` importing
 * `../dms/pages/admin/admin-list.page` — was NOT caught: that rule matches the
 * literal import SOURCE STRING, and `../dms/…` is indistinguishable from
 * `../pages/…` without knowing how deep the importing file sits.
 * `eslint-plugin-import`'s path-aware `no-restricted-paths` is not installed.
 *
 * So this resolves each import against its importing file, which is the only way to
 * ask the question. Same mechanism as `no-unscrubbed-spawn.spec.ts`.
 */
const APPS_DIR = path.join(ROOT, 'tests', 'apps');

/** Every `.ts` file under `tests/apps/`, with the application it belongs to. */
const appFiles = (): Array<{ file: string; application: string }> => {
  const found: Array<{ file: string; application: string }> = [];
  for (const application of readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!application.isDirectory()) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts'))
          found.push({ file: full, application: application.name });
      }
    };
    walk(path.join(APPS_DIR, application.name));
  }
  return found;
};

/** The application directory a resolved import lands in, if any. */
const applicationOf = (resolved: string): string | undefined => {
  const relative = path.relative(APPS_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep)[0];
};

test.describe('no application imports another application @unit', () => {
  test('every relative import inside tests/apps/ stays in its own application', () => {
    // wrong: a page object is borrowed across applications, and a run for one system
    // drives selectors written for another — while the directory layout still reads
    // as though they are separate.
    const files = appFiles();
    // §T — a scan that read nothing would report clean while checking nothing.
    expect(files.length, 'no files under tests/apps/ were scanned').toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const { file, application } of files) {
      const source = readFileSync(file, 'utf8');
      for (const [, specifier] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        const landed = applicationOf(path.resolve(path.dirname(file), specifier!));
        if (landed !== undefined && landed !== application) {
          offenders.push(`${path.relative(ROOT, file)} imports ${landed}'s "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a relative import WITHIN one application is fine', () => {
    // The other half, and without it the check above is satisfied by a rule that
    // forbids every relative import — which would ban `../app.page`, the ordinary
    // way a page object reaches its own base class.
    //
    // Asserted as a fact about the tree rather than a hypothetical: these imports
    // exist today and the scan above passes, so it is not refusing everything.
    const withinApp = appFiles().filter(({ file }) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/from\s+'(\.[^']+)'/g)].some(
        ([, s]) => applicationOf(path.resolve(path.dirname(file), s!)) !== undefined,
      );
    });
    expect(
      withinApp.length,
      'no intra-application relative import exists, so the scan above proves nothing',
    ).toBeGreaterThan(0);
  });
});

test.describe('the DMS suite is scoped to the DMS application @unit', () => {
  test.slow();

  test('TEST_ENV=app (application: dms) collects the app suite', () => {
    // wrong: the guard is keyed on the environment NAME, so `qa` and `staging` —
    // the same application — stop collecting the specs written for them. And then
    // the refusal below would prove nothing: a rule that collects for nobody
    // satisfies it while automating nothing.
    const listed = listFor('app', {
      // The config only needs these to PARSE; nothing connects during `--list`.
      BASE_URL: 'https://example.invalid',
      APP_USERNAME: 'listing-only',
      APP_PASSWORD: 'listing-only',
    });

    expect(listed).toMatch(/tests in \d+ files/);
    const files = Number(/(\d+) files/.exec(listed)?.[1] ?? 0);
    expect(files, 'the DMS suite was not collected at all').toBeGreaterThan(5);
    // Named, so this cannot pass on a suite that happens to be large.
    expect(listed).toContain('dms\\smoke.spec.ts');
    expect(listed).not.toMatch(/No specs for application/);
  });

  test('a DIFFERENT application collects no app spec, and says so', () => {
    // wrong: it collects all 47 DMS specs and runs them against another
    // application — measured, before this guard existed.
    //
    // The second application is declared in a TEMPORARY REPO ROOT rather than in
    // `config/env/`. Two reasons, and the second is the one that matters:
    //
    // - `loadEnvironment` resolves `config/env/<name>.json` under `repoRoot()`,
    //   which honours `AITP_REPO_ROOT`, while Playwright loads its own config from
    //   `cwd`. So the environment can be faked without the repo being touched —
    //   isolation rather than vigilance, no residue to clean up and nothing to
    //   leave behind if this crashes.
    // - Committing a second application would put its slug into the set
    //   `app-agnostic.spec.ts` derives from `config/env/`, which would then police
    //   a fixture name across `packages/` forever.
    //
    // `local` cannot stand in for this: `playwright.config.ts` only resolves
    // `liveEnv` for a NON-local environment, so on `local` the guard is not the
    // thing under test and no message is printed.
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'aitp-app2-'));
    try {
      writeFileSync(path.join(fakeRoot, 'pnpm-workspace.yaml'), '');
      mkdirSync(path.join(fakeRoot, 'config', 'env'), { recursive: true });
      // `playwright.config.ts` PINS the demo environment (`loadEnvironment('local')`)
      // so the demo project cannot be redirected by an ambient variable. That pin is
      // resolved under the same root, so the fake root needs the real file — copied,
      // not invented, or this fixture would be testing a different config.
      copyFileSync(
        path.join(ROOT, 'config', 'env', 'local.json'),
        path.join(fakeRoot, 'config', 'env', 'local.json'),
      );
      writeFileSync(
        path.join(fakeRoot, 'config', 'env', 'app2.json'),
        JSON.stringify({
          name: 'app2',
          application: 'app2',
          baseUrl: 'http://127.0.0.1:4173',
          users: { admin: { username: 'listing-only', password: 'listing-only' } },
        }),
        'utf8',
      );

      const listed = listFor('app2', { AITP_REPO_ROOT: fakeRoot });

      expect(listed).toContain('No specs for application "app2"');
      expect(listed).toContain('tests/apps/app2/ does not exist');
      // NOT ONE DMS SPEC. The `[chromium]` prefix is what the project lists under;
      // the two `[live-setup]` entries are the sign-in and the environment-name
      // guard, neither of which is application-specific.
      expect(listed).not.toContain('[chromium]');
      expect(listed).not.toContain('dms\\smoke.spec.ts');
      // And the message explains the non-zero count rather than leaving a puzzle.
      expect(listed).toMatch(/sign-in setup and the environment-name/);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
