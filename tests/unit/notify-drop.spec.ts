import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  RunStatus,
  TestOutcome,
  describeTarget,
  emptySummary,
  rootLogger,
  type Run,
  type TestResult,
} from '@aitp/shared';
import {
  NOTIFY_CONFIG_SCHEMA_VERSION,
  READY_SCHEMA_VERSION,
  READY_SUFFIX,
  notifyOffBecause,
  notifyRun,
  notifyTestFolder,
  subjectFor,
  type NotifyConfig,
  type ReadyDrop,
} from '@aitp/reporting-engine';

/**
 * THE DROP: written LAST, atomically, and never able to change a run's verdict.
 *
 * ## The ordering is the contract
 *
 * The Power Automate flow triggers on `*.ready.json` and then goes looking for the
 * zip the ready file names. So the zip has to land FIRST and the ready file LAST: a
 * flow that fired before the zip existed would send a mail promising an attachment
 * that is not there. D4 asserts the order from the filesystem rather than from the
 * code, because "the zip is written first" is a claim about execution.
 *
 * ## Six not-written outcomes, six sentences
 *
 * Switched off; never configured; configured for other applications but not this
 * one; the folder has gone; the config is broken; something failed. They ask
 * different things of the reader, and a single "notification skipped" would be
 * useless to all six — the same reason `failed` and `refused` are separate statuses.
 */

const log = rootLogger.child('notify-drop-spec');

function resultOf(overrides: Partial<TestResult> & Pick<TestResult, 'id' | 'title'>): TestResult {
  return {
    file: 'tests/apps/ecom/departments.spec.ts',
    project: 'chromium',
    tags: [],
    outcome: TestOutcome.Passed,
    durationMs: 1200,
    retry: 0,
    steps: [],
    attachments: [],
    ...overrides,
  };
}

function runOf(results: TestResult[]): Run {
  const failed = results.filter((r) => r.outcome === TestOutcome.Failed).length;
  return {
    id: 'run_dr0p0001',
    status: failed > 0 ? RunStatus.Failed : RunStatus.Passed,
    request: { environment: 'qa', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt: '2026-11-10T09:00:00.000Z',
    startedAt: '2026-11-10T09:00:01.000Z',
    finishedAt: '2026-11-10T09:02:11.000Z',
    summary: {
      ...emptySummary(),
      total: results.length,
      passed: results.length - failed,
      failed,
      durationMs: 130_000,
      passRate:
        results.length === 0
          ? 0
          : Number((((results.length - failed) / results.length) * 100).toFixed(2)),
    },
    target: describeTarget('qa', 'https://qa.example.test', 'ecom'),
    artifacts: {},
    results,
  };
}

/** A root, a drop folder and a report directory — all temporary, none of them this machine's. */
function fixture(): { root: string; folder: string; reportDir: string; config: NotifyConfig } {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-drop-'));
  const folder = path.join(root, 'synced', 'Ecom QA');
  mkdirSync(folder, { recursive: true });
  const reportDir = path.join(root, 'artifacts', 'reports', 'html');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, 'index.html'), '<p>the playwright report</p>', 'utf8');
  return {
    root,
    folder,
    reportDir,
    config: {
      schemaVersion: NOTIFY_CONFIG_SCHEMA_VERSION,
      apps: {
        ecom: {
          folder,
          // Off, so these tests are about the drop rather than about screenshots;
          // `notify-screenshots.spec.ts` is where the flag is the subject.
          includeScreenshots: false,
          to: ['qa@contoso.com'],
          cc: ['lead@contoso.com'],
          ranBy: 'me@contoso.com',
          ranBySource: 'upn',
          allowedDomain: 'contoso.com',
        },
      },
    },
  };
}

const notify = (
  f: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof notifyRun>[0]> = {},
) =>
  notifyRun({
    root: f.root,
    run: runOf([resultOf({ id: 't1', title: 'Departments › DEPT-001 list loads' })]),
    application: 'ecom',
    environment: 'qa',
    baseUrl: 'https://qa.example.test',
    reportDir: f.reportDir,
    disabled: false,
    log,
    config: f.config,
    ...overrides,
  });

const readyIn = (folder: string): ReadyDrop =>
  JSON.parse(
    readFileSync(
      path.join(
        folder,
        readdirSync(folder).find((name) => name.endsWith(READY_SUFFIX))!,
      ),
      'utf8',
    ),
  ) as ReadyDrop;

test.describe('the notification drop @unit', () => {
  test('D1: a configured run writes the ready file with every field the flow reads', () => {
    // wrong: a field missing. The flow's Parse JSON is generated from a schema, so an
    // absent field does not fail loudly there — it arrives as null and the mail is
    // sent with an empty subject or no recipients, which looks like a flow problem
    // and is not. Every field is asserted by name for that reason.
    const f = fixture();
    const outcome = notify(f);
    expect(outcome.written, outcome.message).toBe(true);

    const ready = readyIn(f.folder);
    expect(ready.schemaVersion).toBe(READY_SCHEMA_VERSION);
    expect(ready.runId).toBe('run_dr0p0001');
    expect(ready.app).toBe('ecom');
    expect(ready.environment).toBe('qa');
    expect(ready.ranBy).toBe('me@contoso.com');
    expect(ready.to).toEqual(['qa@contoso.com']);
    expect(ready.cc).toEqual(['lead@contoso.com']);
    expect(ready.verdict).toBe('PASSED');
    expect(ready.counts.total).toBe(1);
    expect(ready.counts.failed).toBe(0);
    expect(ready.bodyHtml).toContain('<!doctype html>');
    expect(ready.reportZipName).toBe('ecom-qa-run_dr0p0001.zip');
    expect(ready.reportZipTooLarge).toBe(false);
  });

  test('D2: the subject leads with app, environment and VERDICT, then the counts', () => {
    // wrong: a subject that needs the mail opened to learn whether anything failed —
    // which is what every report email that gets ignored has in common. A subject is
    // read left to right and truncated right, so the three things that must survive
    // a phone notification are which system, which environment, and whether it is
    // broken. The previous version led with counts and left the verdict to be
    // inferred by arithmetic.
    expect(
      subjectFor({
        app: 'ecom',
        environment: 'qa',
        verdict: 'FAILED',
        passed: 40,
        total: 42,
        startedAt: '2026-11-24T06:15:00.000Z',
      }),
    ).toBe('[ECOM][QA] FAILED — 40/42 passed — 24 Nov 2026');

    // And the DATE comes from the run's own instant, so the same run always produces
    // the same subject — no clock is read.
    expect(
      subjectFor({
        app: 'dms',
        environment: 'app',
        verdict: 'PASSED WITH FLAKY',
        passed: 42,
        total: 42,
        startedAt: '2026-01-02T23:00:00.000Z',
      }),
    ).toContain('[DMS][APP] PASSED WITH FLAKY — 42/42 passed — ');
  });

  test('D2b: an application whose environment shares its name gets ONE bracket', () => {
    // wrong: `[ECOM][ECOM] PASSED — …`, which is what the first real ecom mail said.
    // Two brackets exist to answer two questions; when the answers are the same word
    // the second one spends the most expensive characters on the line — the ones a
    // phone notification shows — saying nothing. The fixture discriminates because
    // the pair differs only in whether the two strings match: D2 above keeps the
    // both-brackets case, so this cannot be satisfied by collapsing them always.
    expect(
      subjectFor({
        app: 'ecom',
        environment: 'ecom',
        verdict: 'PASSED',
        passed: 66,
        total: 66,
        startedAt: '2026-11-24T06:15:00.000Z',
      }),
    ).toBe('[ECOM] PASSED — 66/66 passed — 24 Nov 2026');

    // Case is not what makes them the same thing: both are upper-cased first, so a
    // config written `Ecom` against an environment `ecom` still collapses.
    expect(
      subjectFor({
        app: 'Ecom',
        environment: 'ecom',
        verdict: 'PASSED',
        passed: 1,
        total: 1,
        startedAt: '2026-11-24T06:15:00.000Z',
      }),
    ).toContain('[ECOM] PASSED');
  });

  test('D3: the ready file name is the RUN ID plus the suffix the flow matches', () => {
    // wrong: a fixed name like `ready.json`, so two runs finishing close together
    // overwrite each other and one report is silently lost — and the flow, which
    // triggers on file CREATION, may never see the second at all.
    const f = fixture();
    notify(f);
    expect(readdirSync(f.folder).filter((n) => n.endsWith(READY_SUFFIX))).toEqual([
      `run_dr0p0001${READY_SUFFIX}`,
    ]);
  });

  test('D4: the ZIP lands before the ready file, and no temp file is left behind', () => {
    // wrong: the ready file first. The flow fires on it and immediately looks for the
    // zip it names, so a mail would go out promising an attachment that did not exist
    // yet. Asserted from the filesystem — the zip is present the moment the ready
    // file is, and the ready file is the LAST thing in the folder — because "written
    // first" is a claim about execution, not about source order.
    const f = fixture();
    const outcome = notify(f);
    const names = readdirSync(f.folder).sort();
    expect(names).toEqual(['ecom-qa-run_dr0p0001.zip', `run_dr0p0001${READY_SUFFIX}`]);
    // ATOMIC: a `.tmp` surviving would mean a reader could see a partial file, and a
    // flow reading truncated JSON fails in a way nobody can diagnose from the mail.
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(outcome.zipPath).toBeDefined();
    expect(outcome.readyPath!.endsWith(READY_SUFFIX)).toBe(true);
  });

  test('D5: --no-notify writes nothing, and says it was deliberate', () => {
    // wrong: a silent skip, which is how somebody comes to believe mail is going out
    // when it is not. The flag's own resolution is checked separately because the
    // reporter cannot receive a CLI flag at all — `playwright test` rejects unknown
    // ones — so the variable is the only route a suite run has.
    const f = fixture();
    const outcome = notify(f, { disabled: true });
    expect(outcome.written).toBe(false);
    expect(outcome.skipped).toBe('disabled');
    expect(outcome.message).toContain('--no-notify');
    expect(readdirSync(f.folder)).toEqual([]);

    expect(notifyOffBecause(['node', 'x', '--no-notify'], {})).toBe('flag');
    expect(notifyOffBecause(['node', 'x'], { AITP_NO_NOTIFY: '1' })).toBe('flag');
    // The must-NOT-skip half: a resolver returning a reason for everything would
    // disable notification permanently and pass every assertion above.
    expect(notifyOffBecause(['node', 'x'], {})).toBeNull();
    expect(notifyOffBecause(['node', 'x'], { AITP_NO_NOTIFY: '0' })).toBeNull();
    // A FIXTURE surface never notifies: `pnpm test:unit` and `pnpm test:demo` set
    // this, and they resolve `local` and therefore `bundled-demo` — so without it a
    // QA who configured the demo would get a report email every time they ran
    // `pnpm verify`, about the platform's own unit tests, landing in whatever folder
    // that configuration names.
    expect(notifyOffBecause(['node', 'x'], { AITP_FIXTURE_ONLY: '1' })).toBe('fixture-surface');
    // ...UNLESS a test says so AND says where. The override re-enables and REDIRECTS.
    expect(
      notifyOffBecause(['node', 'x'], {
        AITP_FIXTURE_ONLY: '1',
        AITP_NOTIFY_TEST_FOLDER: 'C:\\temp\\drop',
      }),
    ).toBeNull();
    // The explicit switch still wins over the override: somebody who said "not now"
    // meant it, and a test variable must not be able to overrule them.
    expect(
      notifyOffBecause(['node', 'x', '--no-notify'], {
        AITP_FIXTURE_ONLY: '1',
        AITP_NOTIFY_TEST_FOLDER: 'C:\\temp\\drop',
      }),
    ).toBe('flag');
    // An EMPTY override is not an override — only `'VAR' in env` could tell empty
    // from absent, and an empty string here would silently enable a fixture run with
    // nowhere bounded to write (the NODE_PATH trap, in a different variable).
    expect(notifyTestFolder({ AITP_NOTIFY_TEST_FOLDER: '' })).toBeUndefined();
    expect(notifyTestFolder({ AITP_NOTIFY_TEST_FOLDER: '  ' })).toBeUndefined();
    expect(notifyTestFolder({ AITP_NOTIFY_TEST_FOLDER: 'C:\\t' })).toBe('C:\\t');
  });

  test('D6: the five not-configured states are five different sentences', () => {
    // wrong: one "notification skipped" line. Each of these asks something different
    // of the reader — nothing, run setup, run setup FOR THIS APP, check OneDrive, fix
    // the file — and a merged message is useless to all of them. None of them writes
    // anything, and none of them throws.
    const f = fixture();

    // never configured
    const none = notify(f, { config: null });
    expect(none.skipped).toBe('not-configured');
    expect(none.message).toContain('pnpm notify:setup --app ecom');

    // configured, but not for this application
    const other = notify(f, {
      config: { schemaVersion: NOTIFY_CONFIG_SCHEMA_VERSION, apps: { dms: f.config.apps.ecom! } },
    });
    expect(other.skipped).toBe('no-entry-for-app');
    expect(other.message).toContain('configured applications: dms');

    // the folder has gone — OneDrive, or a renamed project
    rmSync(f.folder, { recursive: true, force: true });
    const gone = notify(f);
    expect(gone.skipped).toBe('folder-missing');
    expect(gone.message).toContain('not created automatically');
    // AND IT IS NOT CREATED. A folder no flow watches would swallow every report
    // while each run reported success.
    expect(readdirSync(path.dirname(f.folder))).toEqual([]);
  });

  test('D6b: a run that executed NOTHING is not mailed as a pass', () => {
    // wrong: the drop that actually landed in a real synced folder on 2026-11-26,
    // from a `playwright test --list` that opened no browser:
    //
    //     [ECOM][ECOM] PASSED — 0/0 passed — 26 Nov 2026
    //
    // Every count is zero, so `failed > 0` is false, so the verdict is PASSED — a
    // criterion satisfied by knowing nothing, reaching an audience. The fixture
    // discriminates on the one thing that differs from D1: the same configuration,
    // the same folder, an empty result list. D1 writes; this must not.
    const f = fixture();
    const outcome = notify(f, { run: runOf([]) });

    expect(outcome.written).toBe(false);
    expect(outcome.skipped).toBe('no-tests');
    expect(outcome.message).toContain('"nothing ran" is not "everything passed"');
    // And NOTHING was written — a reason without an empty drop beside it, because a
    // zip with no ready file still clutters a folder somebody reads.
    expect(readdirSync(f.folder)).toEqual([]);

    // The gate is on the COUNT, not on the invocation: one real test and the same
    // configuration writes, so this is not a rule that refuses everything.
    expect(notify(f).written, 'a run with one test must still be written').toBe(true);
  });

  test('D7: a broken config is NOT reported as "not configured"', () => {
    // wrong: the two collapsed into one. "Not configured" sends the reader to create
    // something that already exists, and the broken file stays broken forever — the
    // exact failure the test inventory had, where a corrupted search was reported as
    // an empty result. The `config` parameter is omitted here on purpose so the real
    // loader runs against a file this test wrote.
    const f = fixture();
    const file = path.join(f.root, '.aitp-local', 'notify.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json', 'utf8');

    const outcome = notifyRun({
      root: f.root,
      run: runOf([resultOf({ id: 't1', title: 'A › b' })]),
      application: 'ecom',
      environment: 'qa',
      baseUrl: 'https://qa.example.test',
      reportDir: f.reportDir,
      disabled: false,
      log,
      // config deliberately NOT injected: the loader is the subject here.
    });
    expect(outcome.skipped).toBe('config-broken');
    expect(outcome.message).toContain('BROKEN configuration');
    expect(outcome.message).not.toContain('not configured for');
  });

  test('D8: a failure anywhere is caught — notifyRun never throws', () => {
    // wrong: an exception escaping into the reporter's onEnd or run-sheet's main,
    // turning a green suite red because a folder was read-only. A suite's verdict is
    // about the application under test; a mail that could not be prepared is about
    // this machine. The fixture makes the drop genuinely impossible: `folder` is a
    // FILE, so it passes existsSync and fails isDirectory, and then the write fails.
    const f = fixture();
    rmSync(f.folder, { recursive: true, force: true });
    writeFileSync(f.folder, 'not a directory', 'utf8');

    let outcome!: ReturnType<typeof notifyRun>;
    expect(() => {
      outcome = notify(f);
    }).not.toThrow();
    expect(outcome.written).toBe(false);
    expect(outcome.message).toContain('NOT SENT');
  });

  test('D9: a failing run is queued too, with the failure in the subject and the body', () => {
    // wrong: notifying only on success, or only on failure. Both halves exist for
    // the same reason the comparison does — a green run is when somebody wants to
    // know what got fixed — and the subject must carry the failure count or the mail
    // has to be opened to learn the one thing that matters.
    const f = fixture();
    const outcome = notifyRun({
      root: f.root,
      run: runOf([
        resultOf({
          id: 't1',
          title: 'Departments › DEPT-001 list loads',
          outcome: TestOutcome.Failed,
          error: { message: 'grid never rendered' },
        }),
        resultOf({ id: 't2', title: 'Departments › DEPT-002 create' }),
      ]),
      application: 'ecom',
      environment: 'qa',
      baseUrl: 'https://qa.example.test',
      reportDir: f.reportDir,
      disabled: false,
      log,
      config: f.config,
    });
    expect(outcome.written).toBe(true);
    const ready = readyIn(f.folder);
    expect(ready.verdict).toBe('FAILED');
    expect(ready.subject).toContain('[ECOM][QA] FAILED — 1/2 passed');
    expect(ready.bodyHtml).toContain('grid never rendered');
    // The plain-text fallback carries the same failure, from the same input.
    expect(ready.bodyText, 'no plain-text fallback was written').toContain('grid never rendered');
    // Importance is keyed on `failed`, not on the verdict: a run that passed after a
    // retry is worth reading and is not worth interrupting somebody for.
    expect(ready.importance).toBe('High');
  });

  test('D10: a second run carries the comparison with the first', () => {
    // wrong: every mail saying "no previous run", because the history was never
    // written or was written after the comparison was computed. This is the
    // end-to-end half of B8 and B11: two real drops through the real code path, not
    // two records handed to `compareRuns`.
    const f = fixture();
    const first = runOf([
      resultOf({ id: 'a', title: 'A › breaks later' }),
      resultOf({ id: 'b', title: 'A › gets fixed', outcome: TestOutcome.Failed }),
    ]);
    expect(notify(f, { run: first }).written).toBe(true);
    expect(readyIn(f.folder).bodyHtml).toContain('No previous run recorded');

    const second: Run = {
      ...runOf([
        resultOf({ id: 'a', title: 'A › breaks later', outcome: TestOutcome.Failed }),
        resultOf({ id: 'b', title: 'A › gets fixed' }),
      ]),
      id: 'run_dr0p0002',
      finishedAt: '2026-11-10T10:00:00.000Z',
    };
    expect(notify(f, { run: second }).written).toBe(true);
    const ready = JSON.parse(
      readFileSync(path.join(f.folder, `run_dr0p0002${READY_SUFFIX}`), 'utf8'),
    ) as ReadyDrop;
    expect(ready.bodyHtml).toContain('New failures (1)');
    expect(ready.bodyHtml).toContain('Fixed (1)');
    expect(ready.bodyHtml).not.toContain('No previous run recorded');
  });

  test('D12: a FIXTURE run with a folder configured writes NOTHING into it', () => {
    // wrong: the platform's own unit and demo suites dropping a report every time
    // somebody runs `pnpm verify` — about the platform's tests rather than about any
    // application, and into whatever folder the configuration names, which on a real
    // machine is a customer project's synced OneDrive folder. The configuration is
    // DELIBERATELY present and valid here: a test over an unconfigured machine would
    // pass for the wrong reason, because nothing would be written either way.
    const f = fixture();
    const outcome = notify(f, { disabled: true, offBecause: 'fixture-surface' });
    expect(outcome.written).toBe(false);
    expect(outcome.skipped).toBe('disabled');
    expect(outcome.message).toContain('fixture-only run');
    expect(outcome.message).toContain('whatever is configured');
    expect(readdirSync(f.folder)).toEqual([]);
  });

  test('D13: the test override REDIRECTS — the configured folder is never written to', () => {
    // wrong: an override that merely PERMITS. A fixture run would then write into the
    // configured folder, so a test that forgot to redirect would post a report about
    // the platform's unit tests into a customer project — the fail-open shape. This
    // is also the discriminating half of D12: without it, D12 is satisfied by an
    // implementation that can never notify at all.
    const f = fixture();
    const temp = mkdtempSync(path.join(tmpdir(), 'aitp-override-'));
    const outcome = notify(f, { testFolder: temp });
    expect(outcome.written, outcome.message).toBe(true);
    // The drop is in the TEMP folder...
    expect(readdirSync(temp).filter((n) => n.endsWith(READY_SUFFIX))).toHaveLength(1);
    // ...and the CONFIGURED folder is untouched, which is the property.
    expect(readdirSync(f.folder)).toEqual([]);
    expect(outcome.readyPath!.startsWith(temp)).toBe(true);
    // The config is still READ — recipients and sender come from it, only the
    // destination is overridden.
    const ready = JSON.parse(
      readFileSync(
        path.join(
          temp,
          readdirSync(temp).find((n) => n.endsWith(READY_SUFFIX))!,
        ),
        'utf8',
      ),
    ) as ReadyDrop;
    expect(ready.to).toEqual(['qa@contoso.com']);
    expect(ready.ranBy).toBe('me@contoso.com');
  });

  test('D11: with no report directory the drop still goes, saying nothing is attached', () => {
    // wrong: refusing to notify because there is no Playwright HTML report — which is
    // the ordinary state of a run-sheet run and of any suite whose reporter wrote
    // elsewhere. The mail is the deliverable; the attachment is a convenience, and
    // the three attachment states are three sentences (B12).
    const f = fixture();
    const outcome = notify(f, { reportDir: path.join(f.root, 'no-such-dir') });
    expect(outcome.written).toBe(true);
    const ready = readyIn(f.folder);
    expect(ready.reportZipName).toBeNull();
    expect(ready.reportZipTooLarge).toBe(false);
    expect(ready.bodyHtml).toContain('No report archive was attached');
  });
});
