import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { FullConfig, FullResult, Suite } from '@playwright/test/reporter';
import { describeTarget, type Run, type RunTarget } from '@aitp/shared';
import { AitpReporter } from '@aitp/reporting-engine';
import { resolveEnvName } from '@aitp/execution-engine';
import config from '../../playwright.config';

/**
 * run.json records the label AND the URL it resolved to, together.
 *
 * SEC-2 in docs/security-findings.md. An ambient BASE_URL once redirected every
 * environment key — `local` included — to a live customer system. Every run
 * stated its target, and the archive could not show it had happened: the
 * reporter recorded `environment: process.env.TEST_ENV ?? 'qa'` (a label read
 * from the ambient source that did the redirecting) and no baseUrl at all. An
 * audit afterwards could return only "no evidence, in a corpus unable to hold
 * any".
 */

const CUSTOMER = 'https://a-customer-system.example.com';

async function runJsonFor(target: RunTarget | undefined): Promise<Run> {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitp-reporter-target-'));
  try {
    const reporter = new AitpReporter({ outputDir: dir, target });
    const suite = { allTests: () => [] } as unknown as Suite;
    reporter.onBegin({} as FullConfig, suite);
    await reporter.onEnd({ status: 'passed' } as FullResult);
    return JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as Run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('run.json records where a run went, not only what it was called @unit', () => {
  const originalEnv = { ...process.env };

  test.beforeEach(() => {
    delete process.env.AITP_LIVE_ENDPOINT;
  });

  test.afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('R1: a `local` label that resolved to a customer system is visible in the record', async () => {
    // wrong: only the label is recorded, and this run reads as an ordinary
    // `local` run — the exact SEC-2 case, invisible to any later audit.
    const run = await runJsonFor(describeTarget('local', CUSTOMER));

    expect(run.target).toEqual({ environment: 'local', baseUrl: CUSTOMER, isDemoApp: false });
    expect(run.request.environment).toBe('local');
  });

  test('R2: the label is taken from the target, never separately from TEST_ENV', async () => {
    // wrong: the label is read from process.env.TEST_ENV and says `app` while
    // the target says `local` — two sources for one fact, which is SEC-2's
    // shape. Discriminating on purpose: TEST_ENV and the target DISAGREE here.
    process.env.TEST_ENV = 'app';
    const run = await runJsonFor(describeTarget('local', 'http://127.0.0.1:4173'));

    expect(run.request.environment).toBe('local');
    expect(run.target?.environment).toBe(run.request.environment);
  });

  test('R3: a reporter given no target records null, not silence', async () => {
    // wrong: the field is omitted (undefined is dropped by JSON.stringify), and
    // a run from a misconfigured reporter is indistinguishable from an archive
    // written before targets existed — different causes, different fixes.
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-reporter-target-'));
    try {
      const reporter = new AitpReporter({ outputDir: dir });
      reporter.onBegin({} as FullConfig, { allTests: () => [] } as unknown as Suite);
      await reporter.onEnd({ status: 'passed' } as FullResult);
      const raw = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as Record<
        string,
        unknown
      >;

      expect('target' in raw).toBe(true);
      expect(raw.target).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R4: the real config hands the reporter the URL the browsers use', () => {
    // wrong: the reporter supports a target but the config never passes one (or
    // passes one resolved separately), so every real run.json says null or a
    // URL that is not the one in use — a guard nothing in production triggers.
    // BOTH halves are checked: a mutation hard-coding the label to `local` next
    // to the real URL survived a URL-only version of this test, and a label
    // disagreeing with its URL is precisely the SEC-2 shape.
    //
    // Known limit, measured: a target re-read from process.env.BASE_URL gives
    // the SAME url here (app.json is ${BASE_URL}), so equality cannot see
    // provenance. That mutation survives by construction; the guarantee there is
    // the config reading the one `env` object, not this test.
    const reporters = Array.isArray(config.reporter) ? config.reporter : [];
    const entry = reporters.find((r) => String(r[0]).includes('aitp-reporter'));
    const options = entry?.[1] as { target?: RunTarget } | undefined;

    expect(options?.target, 'aitp-reporter is configured without a target').toBeDefined();
    expect(options?.target?.baseUrl).toBe(config.use?.baseURL);
    expect(options?.target?.environment).toBe(resolveEnvName());
  });
});
