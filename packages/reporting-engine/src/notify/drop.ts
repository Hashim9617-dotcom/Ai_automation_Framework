import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger, Run } from '@aitp/shared';
import { renderReportEmailHtml, renderReportEmailText, verdictOf, type RunTrigger } from './body';
import {
  compareRuns,
  describeRunForHistory,
  previousRunRecord,
  recordRun,
  runHistoryDir,
} from './history';
import {
  howToConfigure,
  loadNotifyConfigFile,
  notifyConfigPath,
  validateNotifyConfigOverride,
  type NotifyAppConfig,
  type NotifyConfig,
} from './config';
import { REPORT_ZIP_LIMIT_BYTES, isReportZipTooLarge, zipSources, type BundleSource } from './zip';

/**
 * THE DROP: everything a Power Automate flow needs, in one file, written LAST.
 *
 * ## Why a file in a synced folder and not an SMTP send
 *
 * Sending mail from here would need a credential on every QA's machine, and a
 * credential is the one thing this repo has spent batches making impossible to hold.
 * Instead a run writes a file into a SharePoint-synced project folder, and a flow
 * owned by a person sends the mail under their own identity. Nothing here can send
 * anything, which is the property rather than the limitation.
 *
 * ## The ORDER is the contract, and the ready file is the commit point
 *
 * The flow triggers on `*.ready.json` and then goes looking for the zip named in it.
 * So the zip lands FIRST and the ready file LAST, atomically — a flow that fired on a
 * half-written ready file would read truncated JSON, and one that fired before the
 * zip existed would send a mail promising an attachment that is not there yet. The
 * rename is what makes the ready file appear complete or not at all.
 *
 * Both files are written with a temp name and renamed within the same directory,
 * which is atomic on NTFS and POSIX. OneDrive uploads a renamed file as a new file,
 * so the flow sees one creation event rather than a series of partial writes.
 *
 * ## It NEVER changes a run's exit code
 *
 * Every failure here is caught and logged. A test suite's verdict is about the
 * application under test; a mail that could not be prepared is about this machine's
 * folder, and conflating the two would make a green suite look red — or, far worse,
 * train somebody to ignore a red one.
 */

/** Bumped when the shape changes in a way the flow's Parse JSON must notice. */
export const READY_SCHEMA_VERSION = 1;

/** The suffix the flow's trigger condition matches on. */
export const READY_SUFFIX = '.ready.json';

export interface ReadyDrop {
  schemaVersion: number;
  runId: string;
  app: string;
  environment: string;
  ranBy: string;
  to: string[];
  cc: string[];
  subject: string;
  verdict: string;
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    durationMs: number;
    passRate: number;
  };
  bodyHtml: string;
  /**
   * The same report as plain text, for the multipart fallback.
   *
   * OPTIONAL in the type so every archived `ready.json` written before this field
   * existed still parses as a `ReadyDrop` — the same reason `annotations` and
   * `network` are optional on a run. The flow coalesces it.
   */
  bodyText?: string;
  /**
   * Outlook's Importance header: `High` when something failed, `Normal` otherwise.
   *
   * A notification that is always High is a notification nobody triages, so this is
   * keyed on `failed > 0` and NOT on the verdict — a run that passed after a retry
   * is worth reading and is not worth interrupting somebody for. OPTIONAL and
   * coalesced in the flow, so an older drop still sends.
   */
  importance?: 'High' | 'Normal';
  /**
   * The archive's file name, or `null` when none was written.
   *
   * `null` rather than absent, and never `''`: the flow's Parse JSON needs the field
   * to exist so its expressions do not break, and a reader has to be able to tell
   * "no archive" from "a field that was dropped".
   */
  reportZipName: string | null;
  /** True when an archive exists but is over the limit, so the mail says so. */
  reportZipTooLarge: boolean;
}

/**
 * `[<APP>] <environment> run — <passed> passed, <failed> failed (<duration>) — <ranBy>`
 *
 * The APP IS UPPER-CASED and comes first, because a subject line is what somebody
 * sees in a notification on a phone and the first question is always which system.
 * The counts are in the subject for the same reason: a manager should not have to
 * open the mail to learn whether anything failed.
 */
export function subjectFor(input: {
  app: string;
  environment: string;
  verdict: string;
  passed: number;
  total: number;
  startedAt: string;
}): string {
  /**
   * `[APP][ENV] VERDICT — p/t passed — date`.
   *
   * The VERDICT is third because a subject line is read left to right and truncated
   * right: in a crowded inbox the three things that have to survive are which
   * system, which environment, and whether it is broken. The previous subject led
   * with counts and buried the verdict in arithmetic the reader had to do.
   *
   * The date is the run's own start, formatted from the instant already recorded —
   * no clock is read here, so the same run always produces the same subject.
   */
  const started = new Date(input.startedAt);
  const date = Number.isNaN(started.getTime())
    ? input.startedAt
    : started.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  /**
   * ONE BRACKET WHEN THE TWO ARE THE SAME WORD.
   *
   * An application's only environment is routinely named after it, so the first
   * real ecom subject read `[ECOM][ECOM] PASSED — …`. Two brackets are there to
   * answer two questions; when they give the same answer the second one is noise
   * in the most expensive characters on the line, the ones a phone shows.
   */
  const app = input.app.toUpperCase();
  const environment = input.environment.toUpperCase();
  const where = app === environment ? `[${app}]` : `[${app}][${environment}]`;
  return `${where} ${input.verdict} — ` + `${input.passed}/${input.total} passed — ${date}`;
}

export interface BuildReadyDropInput {
  run: Run;
  application: string;
  environment: string;
  baseUrl: string;
  app: NotifyAppConfig;
  reportZipName: string | null;
  reportZipTooLarge: boolean;
  comparison: Parameters<typeof renderReportEmailHtml>[0]['comparison'];
  /** What started the run, resolved by the caller (§AJ). */
  trigger?: RunTrigger | undefined;
}

export function buildReadyDrop(input: BuildReadyDropInput): ReadyDrop {
  const summary = input.run.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
    passRate: 0,
  };
  return {
    schemaVersion: READY_SCHEMA_VERSION,
    runId: input.run.id,
    app: input.application,
    environment: input.environment,
    ranBy: input.app.ranBy,
    to: input.app.to,
    cc: input.app.cc,
    subject: subjectFor({
      app: input.application,
      environment: input.environment,
      verdict: verdictOf(input.run),
      passed: summary.passed,
      total: summary.total,
      startedAt: input.run.startedAt ?? input.run.createdAt,
    }),
    verdict: verdictOf(input.run),
    counts: { ...summary },
    // ONE input object for both renderings, so the HTML and the text cannot be
    // given different facts about the same run.
    bodyHtml: renderReportEmailHtml(emailInputOf(input)),
    bodyText: renderReportEmailText(emailInputOf(input)),
    importance: summary.failed > 0 ? 'High' : 'Normal',
    reportZipName: input.reportZipName,
    reportZipTooLarge: input.reportZipTooLarge,
  };
}

/** The body renderers' input, built once from the drop's input. */
function emailInputOf(input: BuildReadyDropInput): Parameters<typeof renderReportEmailHtml>[0] {
  return {
    run: input.run,
    application: input.application,
    environment: input.environment,
    baseUrl: input.baseUrl,
    ranBy: input.app.ranBy,
    comparison: input.comparison,
    trigger: input.trigger,
    includeScreenshots: input.app.includeScreenshots,
    reportZipName: input.reportZipName ?? undefined,
    reportZipTooLarge: input.reportZipTooLarge,
  };
}

/** Writes a file so that it appears complete or not at all. */
function writeAtomically(file: string, contents: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, file);
}

/** Why no drop was written, when none was. Each is a different sentence to a reader. */
export type NotifySkipReason =
  | 'disabled'
  | 'not-configured'
  | 'no-entry-for-app'
  | 'folder-missing'
  | 'config-broken'
  | 'no-tests'
  | 'failed';

export interface NotifyOutcome {
  written: boolean;
  /** Absolute path of the ready file, when one was written. */
  readyPath?: string;
  zipPath?: string;
  skipped?: NotifySkipReason;
  /** One line, already phrased for a human. The caller prints it. */
  message: string;
}

export interface NotifyRunInput {
  root: string;
  run: Run;
  application: string;
  environment: string;
  baseUrl: string;
  /** The directory whose contents become the attachment, if it exists. */
  reportDir: string;
  /**
   * Where the bundle's files are gathered from, and where each sits inside it.
   *
   * Defaults to `reportDir` at the bundle's top level, which is what a sheet run
   * wants. A suite run passes two — the reports directory and `test-results` —
   * because the allowed kinds do not live together.
   *
   * The ALLOWLIST decides what survives either way, so naming a wider root cannot
   * smuggle anything in; it only makes the walk bigger.
   */
  bundleSources?: readonly BundleSource[] | undefined;
  /**
   * What started this run — resolved by the caller, never read here (§AJ).
   *
   * `jenkins` when the pipeline set its own variables, `manual` otherwise. The
   * notify package reads no environment, which is what lets the body's sentinel
   * test assert that no environment value can reach a mail.
   */
  trigger?: RunTrigger | undefined;
  /** Resolved by the caller via `notifyOffBecause`, never read here (§AJ). */
  disabled: boolean;
  /** Which of the reasons, so the skip line says the right sentence. */
  offBecause?: NotifyOffReason | null | undefined;
  /**
   * `AITP_NOTIFY_TEST_FOLDER`, resolved by the caller. REPLACES the configured
   * folder when set.
   *
   * It is a redirect and not merely a permission, which is what bounds a fixture
   * run: the only destination such a run can reach is the one the test chose, so a
   * machine whose config points at a real OneDrive project folder cannot be written
   * to by the platform's own test suite.
   */
  testFolder?: string | undefined;
  /**
   * The RAW `AITP_NOTIFY_CONFIG` value, supplied by the caller (§AJ).
   *
   * Raw rather than validated, so the one implementation of the rule lives beside
   * the rule and a bad value becomes a `config-broken` outcome here — the same
   * sentence a broken file gets — instead of a throw at two call sites that would
   * each have to catch it and could disagree about what to say.
   */
  configFileOverride?: string | undefined;
  log: Logger;
  /** Injected so a test can supply a config without writing one to disk. */
  config?: NotifyConfig | null;
}

/**
 * Prepares the report email for one run. Returns what happened; never throws.
 *
 * The five not-written outcomes are kept apart because they ask different things of
 * the reader: notification is switched off (nothing to do), it was never configured
 * (run `notify:setup`), it is configured for other applications but not this one
 * (run `notify:setup` for this one), the folder has gone (OneDrive, or a renamed
 * project), the config is broken (fix the file — NOT the same as missing), or
 * something genuinely failed (the log says what). A single "notification skipped"
 * would be useless to all six.
 */
export function notifyRun(input: NotifyRunInput): NotifyOutcome {
  const { log } = input;
  try {
    if (input.disabled) {
      return {
        written: false,
        skipped: 'disabled',
        message:
          input.offBecause === 'fixture-surface'
            ? 'notify: skipped — this is a fixture-only run (the platform testing itself), ' +
              'not a run against an application. Nothing was written, whatever is configured.'
            : 'notify: skipped (--no-notify / AITP_NO_NOTIFY).',
      };
    }

    /**
     * A RUN THAT EXECUTED NOTHING IS NOT A PASS.
     *
     * Found on 2026-11-26 by running `playwright test --list`, which builds a
     * reporter, starts a run and ends it having executed nothing. The drop that
     * landed in a real synced folder said:
     *
     *     [ECOM][ECOM] PASSED — 0/0 passed — 26 Nov 2026
     *
     * That is this repo's oldest shape — a criterion satisfied by knowing nothing —
     * reaching an audience. Every count is zero, so `failed > 0` is false, so the
     * verdict is PASSED and the importance is Normal, and a reader is told their
     * application is healthy by a command that never opened a browser.
     *
     * The guard is on the COUNT rather than on the invocation, because `--list` is
     * only the way it was found: a grep that matches nothing, a project with no
     * collected specs and a run cancelled before its first test all arrive here the
     * same way, and all of them mean the same thing to a reader. Three states, and
     * "nothing ran" is not the one that gets mailed.
     */
    // `?? 0` rather than a check for absence: a run with NO summary at all is even
    // less of a pass than one whose summary says zero, so both take this path.
    if ((input.run.summary?.total ?? 0) === 0) {
      return {
        written: false,
        skipped: 'no-tests',
        message:
          'notify: NOT SENT — this run executed no tests, and "nothing ran" is not ' +
          '"everything passed". Nothing was written. If tests were expected, the ' +
          'grep or the project selected none.',
      };
    }

    let config: NotifyConfig | null;
    // Resolved HERE because a bad override and a broken file are the same answer to
    // the reader — fix the configuration — and because the refusal must not fall back
    // to the repo's own file (§AC).
    let configFile = notifyConfigPath(input.root);
    try {
      configFile = validateNotifyConfigOverride(input.configFileOverride) ?? configFile;
      config = input.config !== undefined ? input.config : loadNotifyConfigFile(configFile);
    } catch (error) {
      // A BROKEN config is not a missing one, and the sentences differ: this one says
      // fix the file. Reporting it as "not configured" would send the reader to
      // create something that already exists.
      return {
        written: false,
        skipped: 'config-broken',
        message: `notify: NOT SENT — ${(error as Error).message}`,
      };
    }

    if (!config) {
      return {
        written: false,
        skipped: 'not-configured',
        message: howToConfigure(input.application, input.root, configFile),
      };
    }

    const app = config.apps[input.application];
    if (!app) {
      const others = Object.keys(config.apps).sort().join(', ') || '(none)';
      return {
        written: false,
        skipped: 'no-entry-for-app',
        message:
          `notify: no entry for "${input.application}" — configured applications: ${others}. ` +
          `Add one with: pnpm notify:setup --app ${input.application} --folder "<folder>" ` +
          '--to someone@example.com',
      };
    }

    /**
     * THE DESTINATION, and the test override REPLACES it rather than adding to it.
     *
     * Resolved once, here, and used for every write below — so there is no path by
     * which a fixture run reaches the configured folder. The config is still read
     * (recipients, sender, the domain bound all come from it); only where the files
     * land is overridden.
     */
    const folder = input.testFolder ?? app.folder;

    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      // NOT created. A folder the flow is not watching would collect ready files
      // forever while every run reported success — the exact failure `notify:setup`
      // refuses a missing folder for, arriving later because OneDrive unsynced it or
      // somebody renamed the project.
      return {
        written: false,
        skipped: 'folder-missing',
        message:
          `notify: NOT SENT — the drop folder for "${input.application}" is not there: ` +
          `${folder}. It is not created automatically, because a folder no flow watches ` +
          'would swallow every report silently. Check OneDrive, or re-run `pnpm notify:setup`.',
      };
    }

    // ---- what changed since last time ----
    const historyDir = runHistoryDir(input.root, input.application);
    const record = describeRunForHistory(input.run, input.application, input.environment);
    const previous = previousRunRecord(historyDir, record);
    const comparison = previous ? compareRuns(previous, record) : null;
    // Recorded BEFORE the drop, so the baseline advances whether or not the mail is
    // picked up — the comparison is about runs, not about delivery. Safe in this
    // order because `previousRunRecord` bounds its answer by this run's finishedAt.
    recordRun(historyDir, record);

    /**
     * ---- the human summary, BEFORE the bundle so it is IN the bundle ----
     *
     * The same text that becomes `bodyText`, written once and used twice: a reader
     * who opens the attachment gets the mail's own words rather than a third summary
     * that can disagree with them.
     *
     * It goes into the reports directory, which `archiveIfNotClean` has ALREADY
     * copied by the time notify runs — so `summary.md` is in the bundle and not in
     * `artifacts/runs/<id>/`. Said out loud because that asymmetry is the kind of
     * thing somebody later reads as a bug.
     *
     * The zip fields are deliberately absent from this rendering: a file inside the
     * bundle has no business describing the bundle, and its name is not decided yet.
     */
    if (existsSync(input.reportDir)) {
      writeAtomically(
        path.join(input.reportDir, 'summary.md'),
        renderReportEmailText({
          run: input.run,
          application: input.application,
          environment: input.environment,
          baseUrl: input.baseUrl,
          ranBy: app.ranBy,
          comparison,
          trigger: input.trigger,
          includeScreenshots: app.includeScreenshots,
        }),
      );
    }

    // ---- the archive, FIRST ----
    let reportZipName: string | null = null;
    let reportZipTooLarge = false;
    let zipPath: string | undefined;
    const sources: readonly BundleSource[] = input.bundleSources ?? [
      { root: input.reportDir, prefix: '' },
    ];
    if (sources.some((source) => existsSync(source.root))) {
      // The application's own answer, read from its config and passed in — never a
      // default chosen here. `zipSources` defaults to the restrictive value, so a
      // config without the key produces a bundle with no pictures in it.
      const zipped = zipSources(sources, { includeScreenshots: app.includeScreenshots });
      reportZipName = `${input.application}-${input.environment}-${input.run.id}.zip`;
      reportZipTooLarge = isReportZipTooLarge(zipped.bytes.length);
      zipPath = path.join(folder, reportZipName);
      writeAtomically(zipPath, zipped.bytes);
      if (zipped.excluded.length > 0) {
        // SAID, every time. The archive is deliberately incomplete — traces and
        // saved sessions carry live tokens — and a mail implying completeness is
        // worse than one that names the gap.
        log.info('notify: excluded from the report archive', {
          count: zipped.excluded.length,
          reasons: [...new Set(zipped.excluded.map((entry) => entry.why))],
        });
      }
      if (reportZipTooLarge) {
        log.warn('notify: the report archive is over the attachment limit', {
          bytes: zipped.bytes.length,
          limitBytes: REPORT_ZIP_LIMIT_BYTES,
        });
      }
    }

    // ---- the ready file, LAST, atomically ----
    const drop = buildReadyDrop({
      run: input.run,
      application: input.application,
      environment: input.environment,
      baseUrl: input.baseUrl,
      app,
      reportZipName,
      reportZipTooLarge,
      comparison,
      trigger: input.trigger,
    });
    const readyPath = path.join(folder, `${input.run.id}${READY_SUFFIX}`);
    writeAtomically(readyPath, `${JSON.stringify(drop, null, 2)}\n`);

    return {
      written: true,
      readyPath,
      ...(zipPath ? { zipPath } : {}),
      message:
        `notify: report queued for ${app.to.join(', ')}` +
        `${app.cc.length ? ` (cc ${app.cc.join(', ')})` : ''} — wrote ` +
        `${path.basename(readyPath)}${reportZipName ? ` and ${reportZipName}` : ''} to ${folder}`,
    };
  } catch (error) {
    // NEVER rethrows. A suite's verdict is about the application under test; a mail
    // that could not be prepared is about this machine's folder, and failing the run
    // for it would make a green suite look red — or train somebody to ignore a red one.
    log.warn('notify: could not prepare the report email', { error: (error as Error).message });
    return {
      written: false,
      skipped: 'failed',
      message: `notify: NOT SENT — ${(error as Error).message} (the run's result is unaffected)`,
    };
  }
}

/**
 * `--no-notify` from an argv, or `AITP_NO_NOTIFY`.
 *
 * Both, because the two callers are reached differently: `pnpm run-sheet` takes its
 * own flags, while the Playwright reporter runs inside `playwright test`, which
 * rejects flags it does not know — so a suite run needs the variable. Resolved by
 * the caller and PASSED IN to `notifyRun` (§AJ), so nothing in the package reads the
 * environment.
 */
export function notifyDisabled(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  return notifyOffBecause(argv, env) !== null;
}

/** Why notification is off, when it is. `null` means it is on. */
export type NotifyOffReason = 'flag' | 'fixture-surface';

/**
 * The variable a TEST sets to exercise notification deliberately, naming its folder.
 *
 * `AITP_NOTIFY_TEST_FOLDER` does two things, and the second is the one that makes it
 * safe: it re-enables notification on a fixture surface, AND it REDIRECTS the drop to
 * the folder it names, ignoring the configured one. So a suite run on a machine where
 * `bundled-demo` points at somebody's real OneDrive project folder cannot write
 * there, whatever the config says — the only destination a fixture run can reach is
 * the one the test itself chose.
 *
 * A bare boolean override would have enabled the drop without bounding it, which is
 * the fail-open shape: a test that forgot to redirect would quietly post a report
 * about the platform's own unit tests into a customer project's folder.
 */
/**
 * What started this run — `jenkins` or `manual`. The environment is PASSED IN (§AJ).
 *
 * Jenkins sets `BUILD_NUMBER` and `JENKINS_URL` on every build, and nothing else
 * does. Either one is enough; both are checked because a pipeline can run a step in
 * a container that inherits only some of them, and the cost of being wrong is one
 * word in a mail header rather than a wrong destination.
 *
 * `manual` is the answer when neither is set, not "unknown": somebody typed a
 * command. The field is still optional on the way in, so a caller that does not
 * resolve it gets "not recorded" rather than a guess made on its behalf.
 */
export function notifyTrigger(env: Record<string, string | undefined>): RunTrigger {
  const jenkins = (env.BUILD_NUMBER ?? '').trim() !== '' || (env.JENKINS_URL ?? '').trim() !== '';
  return jenkins ? 'jenkins' : 'manual';
}

export const NOTIFY_TEST_FOLDER_VAR = 'AITP_NOTIFY_TEST_FOLDER';

export function notifyTestFolder(env: Record<string, string | undefined>): string | undefined {
  const folder = env[NOTIFY_TEST_FOLDER_VAR];
  return folder && folder.trim() !== '' ? folder : undefined;
}

/**
 * Is notification switched off, and WHY.
 *
 * ## A FIXTURE surface never notifies
 *
 * `AITP_FIXTURE_ONLY=1` is set by `pnpm test:unit` and `pnpm test:demo` — the
 * platform testing ITSELF. Those runs resolve `local` and therefore the
 * `bundled-demo` application, so without this a QA who had configured the demo for a
 * walkthrough would get a report email every time they ran `pnpm verify`, about the
 * platform's unit tests rather than about any application. Worse, the drop would land
 * in whatever folder that configuration names.
 *
 * ## And the hole that nearly made this wrong
 *
 * A first attempt at this suppression was REMOVED mid-batch, because it made the
 * feature undemonstrable: measured rather than reasoned, the fixture PROJECTS only
 * exist under that flag — `playwright test --project=demo` without it answers
 * `Available projects: live-setup, chromium, firefox, webkit, mobile-chrome, api` —
 * and the bundled demo app has no `tests/apps/bundled-demo/`, so the live projects
 * match nothing for it. The only runnable Playwright surface for the demo app IS the
 * fixture one.
 *
 * Removing the suppression was the wrong half of that trade. `NOTIFY_TEST_FOLDER_VAR`
 * is the right one: the surface stays suppressed by default, and a test that means to
 * exercise notification says so AND says where. Both halves are asserted — a fixture
 * run with a configured folder writes nothing, and the same run with the override
 * writes into the temp folder and not the configured one.
 *
 * Resolved by the caller and PASSED IN to `notifyRun` (§AJ), so nothing in the
 * package reads the environment itself.
 */
export function notifyOffBecause(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): NotifyOffReason | null {
  // The explicit switch wins over everything, including the test override: somebody
  // who said "not now" meant it.
  if (argv.includes('--no-notify') || env.AITP_NO_NOTIFY === '1') return 'flag';
  if (env.AITP_FIXTURE_ONLY === '1' && notifyTestFolder(env) === undefined) {
    return 'fixture-surface';
  }
  return null;
}
