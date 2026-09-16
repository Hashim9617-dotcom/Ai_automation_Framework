import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
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
    port = 3600 + Math.floor(Math.random() * 300);
    api = spawnClean(process.execPath, [ENTRY], {
      cwd: API_DIR,
      env: { API_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (api.exitCode !== null) throw new Error(`the API exited with ${api.exitCode}`);
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
