import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { freePort } from '../support/free-port';
import { execFileSyncClean, spawnClean } from '../support/spawn-clean';

/**
 * The AI Command Box, over HTTP.
 *
 * `docs/phase-2-command-box.md`. The planner's precedence is unit-tested as a
 * pure function in `command-plan.spec.ts`; this covers the things only the
 * running endpoint can show — that a request reaches it, that the answer names
 * its target, and that the two safety properties hold at the boundary.
 *
 * Every command here is `dryRun`, so no suite is started: these must stay fast
 * enough to run on every commit.
 */

const ROOT = findRepoRoot();
const API_DIR = path.join(ROOT, 'apps', 'api');
const ENTRY = path.join(API_DIR, 'dist', 'apps', 'api', 'src', 'main.js');

let api: ChildProcess | undefined;
let port = 0;

async function post(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

test.describe('the AI Command Box @api', () => {
  test.beforeAll(async () => {
    if (!existsSync(ENTRY)) {
      execFileSyncClean('pnpm', ['--filter', '@aitp/api', 'build'], {
        cwd: ROOT,
        stdio: 'pipe',
        shell: process.platform === 'win32',
      });
    }
    port = await freePort();
    api = spawnClean(process.execPath, [ENTRY], {
      cwd: API_DIR,
      env: { API_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Kept, not discarded: "the API exited with 1" alone is a failure that
    // cannot be diagnosed, and this one was flaky in the gate on 2026-09-16.
    let output = '';
    api.stdout?.on('data', (chunk) => (output += String(chunk)));
    api.stderr?.on('data', (chunk) => (output += String(chunk)));

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (api.exitCode !== null) {
        throw new Error(`the API exited with ${api.exitCode} (port ${port}):
${output.slice(-2000)}`);
      }
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw new Error('the API did not start within 40s');
  });

  test.afterAll(() => api?.kill());

  test('CB1: every answer states the target it resolved, computed not declared', () => {
    // wrong: without this a demo run and a customer-system run are indis-
    // tinguishable in the response, which is how "we tested it, it was green"
    // gets said about the wrong system. On 2026-09-11 every environment key on
    // this machine resolved to a customer system, `local` included.
    return post({ command: 'the and of', environment: 'local', dryRun: true }).then((body) => {
      const target = body.target as Record<string, unknown>;
      expect(target.environment).toBe('local');
      expect(target.baseUrl).toContain('4173');
      expect(target.isDemoApp).toBe(true);
    });
  });

  test('CB2: a stop-word command says nothing was searched FOR', async () => {
    // wrong: reported as "no tests matched", the person rephrases the same empty
    // query forever — nothing was searched for, which is a different fix.
    const body = await post({ command: 'the and of', environment: 'local', dryRun: true });

    expect(body.door).toBe('none');
    expect((body.searched as { keywords: string[] }).keywords).toEqual([]);
    expect(String(body.reason)).toContain('stop word');
  });

  test('CB3: a no-match answer names the corpus of every door', async () => {
    // wrong: "no tests found" leaves the reader unable to tell a missing capture
    // from a missing workbook from a badly-phrased command — three problems with
    // three different next steps, collapsed into one sentence.
    const body = await post({
      command: 'test the notification preferences drawer',
      environment: 'local',
      dryRun: true,
    });
    const searched = body.searched as Record<string, unknown>;
    const skipped = body.skipped as Array<{ door: string; why: string }>;

    // The inventory was really searched — a number, not null, and not zero.
    expect(typeof searched.existingTests).toBe('number');
    expect(searched.existingTests as number).toBeGreaterThan(0);
    expect(skipped.some((entry) => entry.door === 'existing')).toBe(true);
    // And a corpus that is absent says so as `null`, never as 0.
    expect(searched.sheetRows).toBeNull();
    expect(skipped.find((entry) => entry.door === 'sheet')!.why).toContain('no QA workbook');
  });

  test('CB4: the inventory is listed for the REQUESTED environment', async () => {
    // wrong: listing under the API's own TEST_ENV answered a request for `local`
    // with the DMS suite — and a match would then have run a test written for a
    // customer system against the demo app. The config chooses which tests exist
    // from TEST_ENV, so the inventory is a function of the environment.
    const body = await post({
      command: 'test employee registration',
      environment: 'local',
      dryRun: true,
    });

    expect(body.door).toBe('existing');
    const matched = body.matchedTests as Array<{ title: string }>;
    // Discriminating: `tests/demo/**` is only listed when TEST_ENV=local, and
    // `tests/app/**` only when it is not. Seeing a demo title proves which
    // environment the listing ran under.
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((entry) => entry.title.includes('demo'))).toBe(true);
  });

  test('CB4b: the inventory spans BOTH surfaces, or it is a smaller corpus in silence', async () => {
    // wrong: the corpus holds only the fixture surface — every DMS spec missing —
    // and nothing says so. A narrowed corpus does not fail: it answers "no existing
    // test matched" more often and less truthfully, which is the empty-result
    // failure this service exists to avoid, wearing a costume.
    //
    // Measured, which is why this test exists: `playwright.config.ts` now partitions
    // its projects on AITP_FIXTURE_ONLY (SEC-3e), so ONE listing can never see both.
    // With the live listing dropped, all 8 api tests still passed — CB3 and CB4 both
    // ask about `local`, where the fixture half answers everything.
    //
    // `local` ONLY, and the comparison is against a listing this test takes itself.
    // The first version asked for `local` and `app` and compared the two counts; on a
    // fresh clone `app` cannot resolve (no BASE_URL), the response carried no
    // `searched`, and it died on `undefined` — the third time in one day that a guard
    // of mine required the machine to be configured. `local`'s own live half is the
    // api and live-setup files, which need no credential at all.
    const local = await post({
      command: 'test the notification preferences drawer',
      environment: 'local',
      dryRun: true,
    });
    const searched = local.searched as { existingTests: number };

    // The fixture surface's whole size, from Playwright rather than from a number
    // written here: a literal would drift as the suite grows, and it would drift in
    // the direction that keeps this test green.
    //
    // Playwright's total counts one entry per project, while the service dedups on
    // `file::title` — equal here, because the two fixture projects share no file.
    const fixtureOnly = execFileSyncClean(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=line'],
      {
        cwd: ROOT,
        maxBuffer: 20 * 1024 * 1024,
        env: { AITP_FIXTURE_ONLY: '1', LOG_LEVEL: 'error' },
      },
    );
    const total = Number(/Total: (\d+) tests/.exec(fixtureOnly)?.[1] ?? 0);
    expect(
      total,
      `no fixture listing to compare against:\n${fixtureOnly.slice(-400)}`,
    ).toBeGreaterThan(0);

    expect(
      searched.existingTests,
      'the corpus is exactly the fixture surface — the live listing is missing',
    ).toBeGreaterThan(total);
  });

  test('CB5: no request body can turn ALLOW_WRITES on', async () => {
    // wrong: a field that reaches the runner lets an HTTP caller create records
    // in a live customer system — the one flag this project has never set, and
    // a sheet cannot escalate its own privileges either (§9.4).
    const body = await post({
      command: 'test employee registration',
      environment: 'local',
      dryRun: true,
      allowWrites: true,
      ALLOW_WRITES: '1',
    });

    // The schema drops unknown keys, so the request is answered and the flag is
    // simply gone — asserted on the response rather than assumed from the schema.
    expect(JSON.stringify(body)).not.toMatch(/allowWrites|ALLOW_WRITES/i);
  });

  test('CB6: command text never reaches the grep', async () => {
    // wrong: interpolating the command into `--grep` puts attacker-controlled
    // text on a command line. The grep is built ONLY from escaped titles this
    // repo owns — so even a command full of metacharacters contributes none of
    // its own characters to it.
    const body = await post({
      command: 'employee registration & whoami | calc.exe',
      environment: 'local',
      dryRun: true,
    });

    const grep = String(body.grep ?? '');
    expect(grep.length).toBeGreaterThan(0);
    expect(grep).not.toContain('whoami');
    expect(grep).not.toContain('calc.exe');
    expect(grep).not.toContain('&');
  });
});
