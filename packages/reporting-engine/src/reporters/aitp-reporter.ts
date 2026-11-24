import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase as PwTestCase,
  TestResult as PwTestResult,
} from '@playwright/test/reporter';
import {
  RunStatus,
  TestOutcome,
  newId,
  rootLogger,
  countBuckets,
  driftCsv,
  summarize,
  summariseRunNetwork,
  type DriftRow,
  type FailureContext,
  type Logger,
  type Run,
  type NetworkSummaryInput,
  type RunNetworkSummary,
  type RunTarget,
  type TestResult,
} from '@aitp/shared';
import { renderRunSummaryHtml } from '../html/summary';
import { NOTIFY_CONFIG_VAR } from '../notify/config';
import { notifyOffBecause, notifyRun, notifyTestFolder } from '../notify/drop';

/**
 * The attachment name the reporter aggregates, and the ONE place it is written.
 *
 * A spec attaches under this name and the reporter looks for it; two spellings
 * would mean the aggregate silently found nothing while every test reported (SS-AE).
 */
export const NETWORK_ATTACHMENT = 'network.json';

/**
 * The per-test attachment holding classified sheet-drift rows.
 *
 * Exported from the reporter that AGGREGATES them and imported by the spec that
 * WRITES them, for the same reason `NETWORK_ATTACHMENT` is: the writer and the
 * reader cannot then disagree about the name, and a rename cannot leave one side
 * silently finding nothing (§AE).
 */
export const SHEET_DRIFT_ATTACHMENT = 'sheet-drift.json';

/** The file a QA opens. Beside run.json, so it travels with the run it describes. */
export const SHEET_DRIFT_CSV = 'sheet-drift.csv';

export interface AitpReporterOptions {
  /** Directory for run.json / summary.html. Defaults to artifacts/reports. */
  outputDir?: string;
  /** POST live events here so the Phase 3 dashboard can stream them. */
  liveEndpoint?: string;
  /**
   * What this run is pointed at, resolved ONCE by whoever configures the
   * browsers — pass `describeTarget(env.name, env.baseUrl)` from the same
   * `env` that sets `use.baseURL`, so the URL recorded is the URL used.
   *
   * Not resolved here on purpose. Resolving again in the reporter would be a
   * second resolution that could disagree with the first, and reading
   * `process.env` would be SEC-2 again: a label taken from the same ambient
   * source that can redirect the run.
   */
  target?: RunTarget;
}

/**
 * Emits the platform's own canonical Run document alongside Playwright's HTML
 * report. Everything downstream — dashboard, email, Jira, Slack — reads this one
 * shape instead of parsing Playwright internals, so those integrations never
 * break when Playwright changes its report format.
 */
export default class AitpReporter implements Reporter {
  private readonly log = rootLogger.child('reporter');
  private readonly outputDir: string;
  private readonly liveEndpoint?: string;
  private readonly results: TestResult[] = [];
  private run: Run;
  private startedAt = Date.now();

  constructor(options: AitpReporterOptions = {}) {
    this.outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', 'reports');
    this.liveEndpoint = options.liveEndpoint ?? process.env.AITP_LIVE_ENDPOINT;
    // null, not undefined: JSON.stringify drops undefined, and an absent field
    // is indistinguishable from a run.json written before targets existed.
    const target = options.target ?? null;
    if (!target) {
      this.log.warn(
        'No target was passed to the reporter — run.json will record target: null, ' +
          'so this run cannot be audited for WHERE it ran. Pass describeTarget(env.name, env.baseUrl).',
      );
    }
    this.run = {
      id: process.env.AITP_RUN_ID ?? newId('run'),
      status: RunStatus.Queued,
      request: {
        // The label comes from the SAME object as the URL whenever there is one.
        // The TEST_ENV fallback exists only for a reporter given no target, and
        // that case is already recorded as target: null.
        environment: target?.environment ?? process.env.TEST_ENV ?? 'qa',
        browsers: ['chromium'],
        headed: false,
        metadata: {},
      },
      createdAt: new Date().toISOString(),
      results: [],
      target,
      artifacts: {},
    };
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.run.status = RunStatus.Running;
    this.run.startedAt = new Date().toISOString();
    this.log.info('Run started', { runId: this.run.id, tests: suite.allTests().length });
    void this.emit('run:started', { runId: this.run.id, total: suite.allTests().length });
  }

  onTestBegin(test: PwTestCase): void {
    void this.emit('test:started', { runId: this.run.id, title: test.title });
  }

  onTestEnd(test: PwTestCase, result: PwTestResult): void {
    const outcomeMap: Record<string, TestOutcome> = {
      passed: TestOutcome.Passed,
      failed: TestOutcome.Failed,
      timedOut: TestOutcome.TimedOut,
      skipped: TestOutcome.Skipped,
      interrupted: TestOutcome.Failed,
    };

    const outcome =
      test.outcome() === 'flaky'
        ? TestOutcome.Flaky
        : (outcomeMap[result.status] ?? TestOutcome.Failed);

    const entry: TestResult = {
      id: test.id,
      title: test.titlePath().slice(1).join(' › '),
      file: path.relative(process.cwd(), test.location.file),
      project: test.parent.project()?.name ?? 'default',
      tags: test.tags ?? [],
      outcome,
      durationMs: result.duration,
      retry: result.retry,
      steps: result.steps.map((step) => ({
        title: step.title,
        durationMs: step.duration,
        error: step.error?.message,
      })),
      // Includes both file-backed attachments (screenshots, video, trace) and
      // in-memory ones (locator telemetry, diagnostics) — the AI layer needs the
      // latter, so filtering on `path` alone would silently drop them.
      attachments: result.attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path ? path.relative(process.cwd(), attachment.path) : 'inline',
        contentType: attachment.contentType,
      })),
    };

    /**
     * ANNOTATIONS, which this reporter used to drop entirely.
     *
     * Measured on 2026-11-18: the Ecom smoke suite records `sheet-drift`,
     * `re-login`, `third-party-4xx` and `stepper`, and none of them reached
     * `run.json` — so a report built from it would have printed "sheet drift: 0"
     * while the truth was "nobody looked". That is the confident wrong number this
     * repo keeps finding, and the fix is one line plus a type.
     *
     * Only set when there ARE any, so an absent field keeps meaning "this producer
     * did not record them" and `[]` keeps meaning "this test had none". Playwright
     * puts a test's annotations on BOTH the test and the result; the result's are
     * the ones a spec pushed at runtime, and the test's are the static ones from
     * `test.describe`/`test.fixme`, so both are taken and de-duplicated.
     */
    const annotations = [...(test.annotations ?? []), ...(result.annotations ?? [])];
    if (annotations.length > 0) {
      const seen = new Set<string>();
      entry.annotations = annotations
        .filter((annotation) => {
          const key = `${annotation.type}\u0000${annotation.description ?? ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((annotation) => ({
          type: annotation.type,
          ...(annotation.description === undefined ? {} : { description: annotation.description }),
        }));
    }

    if (result.error) {
      entry.error = {
        message: stripAnsi(result.error.message ?? 'Unknown error'),
        stack: stripAnsi(result.error.stack ?? ''),
        // error.rca is filled in afterwards by the root cause analyzer.
      };
      const context = readFailureContext(result);
      if (context) entry.context = context;
    }

    this.results.push(entry);
    void this.emit('test:finished', { runId: this.run.id, result: entry });
  }

  async onEnd(result: FullResult): Promise<void> {
    // A retried test fires onTestEnd once per attempt, so `this.results` holds
    // one entry per attempt — kept in full below, because which attempt failed
    // and why is exactly the evidence RCA and manual triage need. But counting
    // straight from that list double-, triple- (or worse-) counts every
    // retried test: a suite of 45 tests with 18 retried failures reported a
    // total of 63. `total`/`failed`/`passRate` must reflect one row per
    // distinct test — its final attempt, the one that actually decided
    // pass/fail — not one row per attempt.
    this.run.results = this.results;
    this.run.summary = summarize(finalAttemptPerTest(this.results));

    /**
     * THE RUN-LEVEL NETWORK SUMMARY, read from the attachment FILES.
     *
     * Per-test records existed before this and were unreachable: they were attached
     * with `body:` rather than a file, so Playwright stored them inline and
     * `run.json` recorded `path: "inline"`. The run-level question a report and a
     * mail actually ask — how many 5xx, and where — could not be answered at all.
     *
     * Built from EVERY attempt's record rather than the final attempt's, because a
     * request a retried attempt made still reached the application. The summary is
     * about traffic, not about verdicts, and the two are counted differently on
     * purpose (`summary` above collapses retries; this does not).
     */
    const networkSummary = this.collectNetwork();
    if (networkSummary) this.run.network = networkSummary;
    this.run.finishedAt = new Date().toISOString();
    this.run.summary.durationMs = Date.now() - this.startedAt;
    this.run.status =
      result.status === 'passed'
        ? RunStatus.Passed
        : result.status === 'interrupted'
          ? RunStatus.Cancelled
          : RunStatus.Failed;

    mkdirSync(this.outputDir, { recursive: true });
    const jsonPath = path.join(this.outputDir, 'run.json');
    const htmlPath = path.join(this.outputDir, 'summary.html');

    // Artifact paths must be set BEFORE serialising — run.json is the source of
    // truth the API hydrates from, so anything assigned after the write is lost.
    this.run.artifacts = {
      runJson: path.relative(process.cwd(), jsonPath),
      summaryHtml: path.relative(process.cwd(), htmlPath),
      playwrightHtml: path.join('artifacts', 'reports', 'html', 'index.html'),
    };

    writeFileSync(jsonPath, JSON.stringify(this.run, null, 2), 'utf8');
    writeFileSync(htmlPath, renderRunSummaryHtml(this.run), 'utf8');

    /**
     * THE DRIFT CSV, before the archive so it is inside it.
     *
     * Order matters and it is not cosmetic: `archiveIfNotClean` copies this
     * directory, so a file written after it exists in `artifacts/reports` and NOT in
     * `artifacts/runs/<runId>/` — present on the machine that ran and missing from
     * the copy anybody else sees. The same trap `run.artifacts` has above.
     */
    this.writeSheetDrift();

    archiveIfNotClean(this.run, this.outputDir, this.log);

    /**
     * THE REPORT EMAIL, prepared after everything that decides the run's verdict.
     *
     * Last on purpose: it reads `run.json`'s contents from the object that was just
     * written, and `archiveIfNotClean` above must have run so the archive it may zip
     * is complete. It cannot change `result.status` — `notifyRun` catches everything
     * and returns an outcome — because a suite's verdict is about the application
     * under test and a mail that could not be prepared is about this machine's
     * folder. Conflating the two makes a green suite look red, or trains somebody to
     * ignore a red one.
     *
     * `--no-notify` is honoured via `AITP_NO_NOTIFY` as well as argv: `playwright
     * test` rejects flags it does not know, so a suite run has no way to pass one.
     * Both are resolved HERE and passed in, so nothing in the notify package reads
     * the environment (§AJ).
     */
    if (this.run.target) {
      const offBecause = notifyOffBecause(process.argv, process.env);
      const outcome = notifyRun({
        offBecause,
        // Both resolved HERE and passed in (§AJ). The override is what lets a test
        // exercise notification on the fixture surface, and it REDIRECTS: a suite
        // run cannot reach a configured folder even if one is set.
        testFolder: notifyTestFolder(process.env),
        // The raw value, validated inside `notifyRun` so a bad one reads as a broken
        // configuration rather than failing the suite. A spawned run gets this from
        // its parent, which is how a test points a REAL child at its own config file
        // instead of writing the developer's (§AJ: supplied here, never read there).
        configFileOverride: process.env[NOTIFY_CONFIG_VAR],
        root: path.dirname(path.dirname(this.outputDir)),
        run: this.run,
        application: this.run.target.application,
        environment: this.run.target.environment,
        baseUrl: this.run.target.baseUrl,
        /**
         * THE REPORTS DIRECTORY, not `html` inside it — the allowlist changed what
         * this means.
         *
         * It used to be `html/`, because the bundle WAS the Playwright report. That
         * report is no longer allowed to travel (its `data/` directory holds every
         * attachment a run produced, traces included), so pointing at it would now
         * produce an empty bundle. The allowed kinds — `run.json`, `junit.xml`,
         * `sheet-drift.csv`, `summary.md` — are written here, and the failure
         * screenshots are Playwright's, one directory across.
         */
        reportDir: this.outputDir,
        bundleSources: [
          { root: this.outputDir, prefix: '' },
          { root: path.join(path.dirname(this.outputDir), 'test-results'), prefix: 'test-results' },
        ],
        disabled: offBecause !== null,
        log: this.log,
      });
      // ONE LINE, always, whichever of the outcomes it was. A silent skip is how
      // somebody comes to believe mail is going out when it is not.
      this.log.info(outcome.message);
    } else {
      // No target means no application, so there is nothing to key a drop on. Said
      // rather than skipped silently, and it is the same gap the reporter already
      // warns about at construction.
      this.log.info(
        'notify: skipped — this run recorded no target, so the application is unknown. ' +
          'Pass describeTarget(env.name, env.baseUrl, env.application) to the reporter.',
      );
    }

    this.log.info('Run finished', {
      runId: this.run.id,
      status: this.run.status,
      ...this.run.summary,
    });
    await this.emit('run:finished', { runId: this.run.id, run: this.run });
  }

  printsToStdio(): boolean {
    return false;
  }

  /**
   * Every `network.json` attachment this run wrote, aggregated — or `undefined`.
   *
   * `undefined` rather than an empty summary when no test reported, because
   * "nothing was instrumented" and "nothing was requested" are different answers
   * and a summary of zeroes states the second while meaning the first.
   *
   * An attachment that cannot be read is COUNTED as a reporting test and skipped,
   * with a warning: a test that recorded something the reporter could not parse is
   * not a test that saw no traffic, and silently dropping it would make
   * `testsReporting` agree with a total it no longer explains.
   */
  private collectNetwork(): RunNetworkSummary | undefined {
    const perTest: NetworkSummaryInput[][] = [];
    let unreadable = 0;

    for (const result of this.results) {
      for (const attachment of result.attachments) {
        if (attachment.name !== NETWORK_ATTACHMENT) continue;
        // `inline` is the sentinel this reporter writes for a body-backed
        // attachment. There is nothing on disk to read, and counting it as a
        // reporting test with no requests would be the inline bug all over again.
        if (attachment.path === 'inline') {
          unreadable += 1;
          continue;
        }
        try {
          const parsed = JSON.parse(readFileSync(attachment.path, 'utf8')) as {
            requests?: NetworkSummaryInput[];
          };
          perTest.push(Array.isArray(parsed.requests) ? parsed.requests : []);
        } catch {
          unreadable += 1;
        }
      }
    }

    if (unreadable > 0) {
      this.log.warn(
        'Some network attachments could not be read, so the run summary is incomplete',
        { unreadable, read: perTest.length },
      );
    }
    if (perTest.length === 0) return undefined;
    return summariseRunNetwork(perTest);
  }

  /**
   * Gathers the per-test drift rows and writes the CSV a QA reviews.
   *
   * ## Nothing is written when nothing was classified
   *
   * No attachment means no spec classified any columns — which is NOT "no drift".
   * A header-only CSV sitting in every run would say "we looked and the sheet
   * matches", and on a run with no sheet-aware specs at all that is a confident
   * wrong answer. Absent file, absent claim; `driftCsv([])` writing a header row is
   * for the different case where a spec DID look and found nothing.
   *
   * ## A failure to read is reported, never silently skipped
   *
   * An unreadable attachment is warned about with a count, so a CSV short of a
   * module is distinguishable from a module with no drift. Same reason the network
   * aggregate counts `testsReporting`.
   */
  private writeSheetDrift(): void {
    const rows: DriftRow[] = [];
    let unreadable = 0;
    let found = 0;

    for (const result of this.results) {
      for (const attachment of result.attachments) {
        if (attachment.name !== SHEET_DRIFT_ATTACHMENT) continue;
        found += 1;
        if (attachment.path === 'inline') {
          unreadable += 1;
          continue;
        }
        try {
          const parsed = JSON.parse(readFileSync(attachment.path, 'utf8')) as {
            rows?: DriftRow[];
          };
          if (Array.isArray(parsed.rows)) rows.push(...parsed.rows);
          else unreadable += 1;
        } catch {
          unreadable += 1;
        }
      }
    }

    if (unreadable > 0) {
      this.log.warn('Some sheet-drift attachments could not be read, so the CSV is incomplete', {
        unreadable,
        read: found - unreadable,
      });
    }
    if (found === 0) return;

    const file = path.join(this.outputDir, SHEET_DRIFT_CSV);
    writeFileSync(file, `${driftCsv(rows)}\r\n`, 'utf8');

    const counts = countBuckets(rows);
    this.log.info('Sheet drift written for QA review', {
      file: path.relative(process.cwd(), file),
      ...counts,
      modules: new Set(rows.map((row) => row.module)).size,
    });
  }

  /** Fire-and-forget live event; never fails a run because the dashboard is down. */
  private async emit(event: string, payload: unknown): Promise<void> {
    if (!this.liveEndpoint) return;
    try {
      await fetch(this.liveEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, payload, at: new Date().toISOString() }),
      });
    } catch (error) {
      this.log.debug('Live event delivery failed', { event, error: (error as Error).message });
    }
  }
}

/**
 * Collapses per-attempt results down to one entry per distinct test id,
 * keeping the highest `retry` — the attempt that actually determined the
 * test's final outcome (Playwright retries in increasing order, and a test
 * that eventually passes after failing is reported as `flaky` only on that
 * last attempt). Exported so the counting rule has direct unit coverage
 * separate from a full reporter run.
 */
export function finalAttemptPerTest(results: TestResult[]): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const result of results) {
    const existing = byId.get(result.id);
    if (!existing || result.retry > existing.retry) byId.set(result.id, result);
  }
  return [...byId.values()];
}

/**
 * An intermittent failure is by definition rare — if the next run's cleanup
 * wipes its trace/video/screenshot before anyone can look, it can never be
 * diagnosed (this is exactly what happened investigating the
 * nav.fileExplorer/admin.new flake: the evidence was gone by the time it
 * mattered). Playwright wipes its own `outputDir` (test-results) internally
 * at the START of the next run, before global-setup.ts even gets a chance to
 * look at it — so archiving has to happen HERE, at the end of THIS run,
 * while the artifacts are still on disk. A clean run has nothing worth
 * keeping and is left for the next run's ordinary cleanup.
 */
function archiveIfNotClean(run: Run, reportsDir: string, log: Logger): void {
  const failed = run.summary?.failed ?? 0;
  const flaky = run.summary?.flaky ?? 0;
  if (failed === 0 && flaky === 0) return;

  const artifactsDir = path.dirname(reportsDir);
  const testResultsDir = path.join(artifactsDir, 'test-results');
  const archiveDir = path.join(artifactsDir, 'runs', run.id);

  log.info('This run had failures or flakes — archiving its artifacts', {
    runId: run.id,
    failed,
    flaky,
    // Relative to the CWD, like every other path this reporter logs, and not
    // to `artifactsDir` — that printed `runs\run_<id>` for a directory that is
    // actually at `artifacts\runs\run_<id>`, so the one line telling someone
    // where the evidence went named a path they could not open. These
    // artifacts exist precisely because a rare failure has to be diagnosable
    // later; a log that misdirects the person looking for them costs the whole
    // point of archiving.
    archiveDir: path.relative(process.cwd(), archiveDir),
  });

  cpSync(reportsDir, path.join(archiveDir, 'reports'), { recursive: true });
  if (existsSync(testResultsDir)) {
    cpSync(testResultsDir, path.join(archiveDir, 'test-results'), { recursive: true });
  }

  writeEvidenceManifest(run, archiveDir, log);
}

/** The three kinds of evidence recorded for a failed or flaky test. */
export const EVIDENCE_KINDS = ['trace', 'screenshot', 'network'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * The kind whose absence is ALWAYS a gap. See `requiredEvidenceFor` for the rest.
 *
 * `trace` is configured for every project in `playwright.config.ts`
 * (`retain-on-failure`), browserless ones included, so a failed test without one is
 * wrong wherever it ran.
 */
export const REQUIRED_EVIDENCE: readonly EvidenceKind[] = ['trace'];

/**
 * What THIS RUN should have produced, derived from what it DID produce.
 *
 * A fixed list of required kinds was wrong in both directions and the second was
 * found by running it: `network.json` is an application suite's convention, so
 * demanding it everywhere warned on every failed demo test — and `screenshot` is
 * impossible in a browserless project, so demanding it warned on every failed UNIT
 * test. Measured 2026-11-24: two failing zip tests reported "missing screenshot" for
 * tests that have no page and never could have one.
 *
 * Neither list could be hand-written without being wrong for some surface (§AE). So
 * the rule is derived: a kind is required when at least one failed or flaky test in
 * this run produced it, which is the run demonstrating that it CAN. That catches the
 * failure mode that matters — one test lost its trace while its neighbours kept
 * theirs — and stays quiet about a kind the surface cannot produce at all.
 *
 * `REQUIRED_EVIDENCE` is unioned in as a floor, because a derived set alone has a
 * silent hole: if EVERY failed test lost its trace, nothing would be observed and
 * nothing would be required.
 */
export function requiredEvidenceFor(
  entries: ReadonlyArray<{ present: readonly EvidenceKind[] }>,
): EvidenceKind[] {
  const observed = new Set<EvidenceKind>(REQUIRED_EVIDENCE);
  for (const entry of entries) for (const kind of entry.present) observed.add(kind);
  return EVIDENCE_KINDS.filter((kind) => observed.has(kind));
}

export const EVIDENCE_MANIFEST = 'evidence.json';

/** Which evidence kind an attachment is, or `null` if it is not evidence. */
export function evidenceKindOf(attachment: {
  name: string;
  contentType?: string;
}): EvidenceKind | null {
  if (attachment.name === 'trace') return 'trace';
  if (attachment.name === NETWORK_ATTACHMENT) return 'network';
  if (attachment.name === 'screenshot' || attachment.contentType === 'image/png') {
    return 'screenshot';
  }
  return null;
}

/**
 * RECORDS WHAT EVIDENCE EACH FAILED OR FLAKY TEST LEFT, and says what is missing.
 *
 * ## Why a copy is not enough
 *
 * `cpSync` of `test-results` is a claim that the evidence is in the archive, and it
 * is only as true as what Playwright left on disk. `trace: 'retain-on-failure'`
 * deletes the trace of an attempt that PASSED — so for a flaky test the retained
 * trace belongs to the failed attempt, which is the one worth having, but nothing
 * here checked that it was there. A copy of an empty directory succeeds silently and
 * the archive then looks complete: a directory exists, the log says "archived", and
 * the evidence is gone. That is this repo's oldest shape — a step that reports
 * success without asserting its own effect.
 *
 * So the archive writes down, per test, which of the three kinds it found, and warns
 * by NAME about any failed or flaky test missing one. The manifest is the auditable
 * half: "the archive exists" and "the archive has what I need" are different
 * questions, and only the second one matters at three in the morning.
 *
 * ## It warns rather than throwing
 *
 * A run whose evidence is incomplete has still produced a verdict about the
 * application, and failing the run over the state of its own artifacts would make a
 * reporting gap look like a product defect — the same reason `notifyRun` cannot
 * change an exit code. The warning names the tests, so the gap is loud without being
 * mistaken for something it is not.
 */
function writeEvidenceManifest(run: Run, archiveDir: string, log: Logger): void {
  /**
   * GROUPED BY TEST, not by attempt — which the first version got wrong.
   *
   * `run.results` holds one entry per ATTEMPT, so a flaky test appears twice: the
   * attempt that failed, carrying the trace and the screenshot, and the attempt that
   * passed, carrying neither because `retain-on-failure` deleted them. Reported per
   * attempt, the passing one showed `missing: ["trace", "screenshot"]` and warned —
   * on a run where the evidence was all present and correct.
   *
   * The requirement is about a TEST: a test that failed or flaked must have left all
   * three somewhere across its attempts. So the evidence is unioned over attempts,
   * and the outcome reported is the final one, which is what the run reports.
   */
  const byTest = new Map<
    string,
    { title: string; outcome: string; attempts: number; present: Set<EvidenceKind> }
  >();

  for (const result of run.results) {
    if (result.outcome !== TestOutcome.Failed && result.outcome !== TestOutcome.Flaky) continue;
    const entry = byTest.get(result.id) ?? {
      title: result.title,
      outcome: result.outcome,
      attempts: 0,
      present: new Set<EvidenceKind>(),
    };
    entry.attempts += 1;
    // The LAST attempt's outcome wins, because that is the verdict the run carries.
    entry.outcome = result.outcome;
    for (const attachment of result.attachments ?? []) {
      const kind = evidenceKindOf(attachment);
      // ON DISK, not merely listed. An attachment recorded as `inline` has no file,
      // and a path that no longer exists is the case this whole function is for.
      if (!kind) continue;
      if (attachment.path && attachment.path !== 'inline' && existsSync(attachment.path)) {
        entry.present.add(kind);
      }
    }
    byTest.set(result.id, entry);
  }

  const entries = [...byTest.entries()].map(([id, entry]) => ({
    id,
    title: entry.title,
    outcome: entry.outcome,
    attempts: entry.attempts,
    present: EVIDENCE_KINDS.filter((kind) => entry.present.has(kind)),
    missing: EVIDENCE_KINDS.filter((kind) => !entry.present.has(kind)),
  }));

  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    path.join(archiveDir, EVIDENCE_MANIFEST),
    `${JSON.stringify({ runId: run.id, kinds: EVIDENCE_KINDS, tests: entries }, null, 2)}\n`,
    'utf8',
  );

  // Only the required kinds raise a warning, and which those are is DERIVED from
  // what this run produced — see `requiredEvidenceFor`. Everything is recorded
  // either way: what we got and what should have been there are two questions.
  const required = requiredEvidenceFor(entries);
  const incomplete = entries
    .map((entry) => ({
      entry,
      lacking: entry.missing.filter((kind) => required.includes(kind)),
    }))
    .filter((row) => row.lacking.length > 0);

  if (incomplete.length > 0) {
    log.warn('Some failed or flaky tests archived WITHOUT all their evidence', {
      runId: run.id,
      tests: incomplete.map((row) => `${row.entry.title} (missing ${row.lacking.join(', ')})`),
    });
  } else if (entries.length > 0) {
    log.info('Every failed or flaky test archived with the evidence configured for it', {
      runId: run.id,
      tests: entries.length,
      recorded: entries.map((entry) => `${entry.title}: ${entry.present.join(', ') || 'none'}`),
    });
  }
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Lifts the JSON attachments the execution engine produced into structured
 * fields on the result, so run.json is self-contained: the analyzer, the
 * dashboard and the Jira integration never have to go hunting for side files.
 */
function readFailureContext(result: PwTestResult): FailureContext | undefined {
  const read = <T>(name: string): T | undefined => {
    const attachment = result.attachments.find((entry) => entry.name === name);
    if (!attachment?.body) return undefined;
    try {
      return JSON.parse(attachment.body.toString('utf8')) as T;
    } catch {
      return undefined;
    }
  };

  const diagnostics = read<{
    consoleErrors: string[];
    pageErrors: string[];
    failedRequests: string[];
  }>('diagnostics.json');
  const domSnapshot = read<FailureContext['domSnapshot']>('dom-snapshot.json');
  const locatorTelemetry = read<FailureContext['locatorTelemetry']>('locator-telemetry.json');
  const healingGate = read<FailureContext['healingGate']>('healing-gate.json');
  const healingContext = read<FailureContext['healingContext']>('healing-context.json');

  const context: FailureContext = {
    ...(diagnostics ?? {}),
    ...(domSnapshot ? { domSnapshot } : {}),
    ...(locatorTelemetry ? { locatorTelemetry } : {}),
    ...(healingGate ? { healingGate } : {}),
    ...(healingContext ? { healingContext } : {}),
  };

  return Object.keys(context).length > 0 ? context : undefined;
}
