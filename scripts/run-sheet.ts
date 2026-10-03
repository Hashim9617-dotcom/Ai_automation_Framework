#!/usr/bin/env node
/**
 * One authored QA sheet, run end to end.
 *
 *   pnpm run-sheet --app <application> --sheet "<sheet name>" "<C:/path/to/book.xlsx>"
 *
 * `runSheet` has existed since 4d and had exactly one caller — a test. This is what
 * ties it to something a person invokes, and almost all of it is REFUSALS: the
 * composition itself is twenty lines at the bottom.
 *
 * ## The workbook is read-only input and stays outside the repo
 *
 * It carries live credentials in its Test Data column, so a copy inside the working
 * tree is one `git add` away from being committed. `tests/unit/no-workbooks.spec.ts`
 * guards the tracked set; this refuses the path, which is the half that stops it
 * getting there.
 *
 * ## It cannot turn writes on, and there is no flag for it
 *
 * `runSheet` takes no `allowWrites`, so neither does this. `ALLOW_WRITES` in the
 * environment refuses the run instead of being ignored: ignoring it silently would
 * let a QA believe a held row was going to run, and the next thing they do is go
 * looking for why it did not.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  describeTargetBanner,
  authStatePath,
  loadCaptureFromDisk,
  loadEnvironment,
  requireApplicationArg,
  resolveEnvName,
  runSheet,
} from '@aitp/execution-engine';
import { findRepoRoot, newId } from '@aitp/shared';

const USAGE =
  'usage: pnpm run-sheet --app <application> --sheet "<sheet name>" "<path/to/workbook.xlsx>"';

const valueOf = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function main(): Promise<void> {
  /**
   * ALLOW_WRITES REFUSES THE RUN, before anything else.
   *
   * First, because it is the only check whose answer does not depend on any other:
   * a QA who set it is expecting writes, and every later refusal would be read as
   * the reason they did not happen. `runSheet` has no parameter for it — this is
   * about the belief, not the capability.
   */
  if (process.env.ALLOW_WRITES !== undefined) {
    throw new Error(
      'refusing to start: ALLOW_WRITES is set in the environment, and this command cannot ' +
        'honour it. A write-risky row is HELD here whatever that variable says — there is no ' +
        'parameter to turn writes on, by design (§9.4).\n' +
        '  Unset ALLOW_WRITES and run again. Nothing would have been written either way; the ' +
        'refusal exists so you are not left wondering why.',
    );
  }

  const application = requireApplicationArg({ argv: process.argv, usage: USAGE });

  const sheet = valueOf('--sheet');
  if (!sheet) {
    throw new Error(
      `${USAGE}\n` +
        '  --sheet is required and has no default: the real workbook holds five ' +
        'test-case-shaped sheets with different layouts, and reading one with another ' +
        "sheet's reader produces garbage that looks like data.",
    );
  }

  const workbookArg = process.argv.slice(2).find((arg) => /\.xlsx?$/i.test(arg));
  if (!workbookArg) {
    throw new Error(`${USAGE}\n  no workbook path was given (expected a .xlsx argument).`);
  }
  const workbook = path.resolve(workbookArg);
  if (!existsSync(workbook)) {
    throw new Error(`refusing to run: there is no workbook at ${workbook}.`);
  }

  /**
   * THE WORKBOOK MAY NOT LIVE INSIDE THE REPO.
   *
   * `artifacts/` is the exception and the only one: it is gitignored, and a test
   * fixture has to be written somewhere a run can read it.
   */
  const root = findRepoRoot();
  const artifacts = path.join(root, 'artifacts') + path.sep;
  if (workbook.startsWith(root + path.sep) && !workbook.startsWith(artifacts)) {
    throw new Error(
      `refusing to run: the workbook is inside the repository (${path.relative(root, workbook)}).\n` +
        '  It carries live credentials in its Test Data column, so a copy in the working tree ' +
        'is one `git add` away from being committed. Keep it outside the repo and pass the ' +
        'full path.',
    );
  }

  const env = loadEnvironment(resolveEnvName());

  // THE TARGET, FIRST, and where every part of it came from. A wrong environment is
  // then obvious on line one rather than forty-five failures later (SEC-2).
  process.stdout.write(`\nRunning against:\n${describeTargetBanner(env)}\n\n`);

  /**
   * THE SESSION FILE, before the browser.
   *
   * Two failures that look alike and are not:
   *
   * - NO FILE — nobody has signed in on this machine. Refused here, because
   *   launching a browser to discover it wastes thirty seconds and reports an
   *   `auth` entry failure that reads like expired credentials.
   * - EXPIRED — the file is there and the application rejects it. That one CANNOT be
   *   known without asking the app, so it stays a `given-not-reached` row with
   *   `reason: auth`, owner environment, which is what `runSheet` already produces.
   */
  const session = authStatePath(env);
  if (!existsSync(session)) {
    throw new Error(
      `refusing to run: no saved session at ${path.relative(root, session)}.\n` +
        '  Run `pnpm auth` first — it signs in once, interactively, and saves the session ' +
        'here. This is NOT the same as an expired session: nothing has signed in yet.',
    );
  }

  const source = loadCaptureFromDisk(application, { targetHost: hostOf(env.baseUrl) });
  if (source.kind === 'none') {
    throw new Error(
      `refusing to run: ${source.reason}\n` +
        (source.skipped.length > 0
          ? `  ${source.skipped.length} session(s) were skipped:\n` +
            source.skipped.map((s) => `    - ${s.sessionId}: ${s.why}`).join('\n') +
            '\n'
          : '') +
        '  Rows are resolved against the capture, so there is nothing to resolve them with.',
    );
  }

  const ageDays = (iso: string | null): string =>
    iso === null
      ? 'unknown'
      : `${Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)} day(s) old`;

  process.stdout.write(
    [
      `Capture:   ${source.sessions.length} session(s), ${source.capture.states.length} state(s)`,
      `           oldest ${ageDays(source.oldest)}, newest ${ageDays(source.newest)}`,
      ...(source.emptyStatesDropped > 0
        ? [`           ${source.emptyStatesDropped} empty state(s) dropped`]
        : []),
      ...(source.skipped.length > 0
        ? [`           ${source.skipped.length} session(s) skipped:`]
        : []),
      ...source.skipped.map((s) => `             - ${s.sessionId}: ${s.why}`),
      ...(source.unlabelled > 0
        ? [
            `           ${source.unlabelled} pre-move session(s) under artifacts/inspect/ are NOT used`,
          ]
        : []),
      '',
    ].join('\n'),
  );

  const runId = newId('run');
  // PER APPLICATION, and deliberately not `artifacts/runs/` — that is where the
  // Playwright reporter archives a failed browser run, which is a different thing
  // with a different lifetime.
  const outDir = path.join(root, 'artifacts', application, 'sheet-runs', runId);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      // THE BASE URL, or every relative route is an invalid URL.
      //
      // The module map holds paths on purpose — `/employees`, not a host — so the same
      // file works across environments, and both `signIn` below and the entry
      // verifier's `page.goto(route)` hand Playwright one of those. Without a
      // `baseURL` the browser answers `Cannot navigate to invalid URL`, which arrives
      // as `auth: signing in failed` and reads like a credential problem. A Playwright
      // test gets this from the project config; a CLI has to pass it.
      baseURL: env.baseUrl,
      ignoreHTTPSErrors: true,
      storageState: session,
    });
    const page = await context.newPage();

    const result = await runSheet({
      workbook,
      sheet,
      env,
      capture: source.capture,
      page,
      // The saved session IS the sign-in. A failure here can only be the session
      // being refused by the application, which is why the message names `pnpm auth`
      // rather than describing a form that was never filled in.
      signIn: async () => {
        await page.goto('/');
        if (/\/login(\b|$)/.test(page.url())) {
          throw new Error(
            `the saved session at ${path.relative(root, session)} was rejected — the ` +
              'application redirected to its login screen. Run `pnpm auth` again.',
          );
        }
      },
      outDir,
      runId,
      provenance: {
        target: `${application} at ${hostOf(env.baseUrl)} (environment "${env.name}")`,
        proves: `these rows behaved this way against ${application} at the moment of this run`,
        doesNotProve:
          'that the capture still matches the application — it is ' +
          `${ageDays(source.newest)} — nor anything about a row this run refused or held`,
      },
    });

    process.stdout.write(
      [
        '',
        `Rows read: ${result.run.tally.rowsRead}`,
        `Report:    ${path.relative(process.cwd(), result.reportPath).split(path.sep).join('/')}`,
        `CSV:       ${path
          .relative(process.cwd(), result.automationSheetPath)
          .split(path.sep)
          .join('/')}`,
        '',
      ].join('\n'),
    );

    // ASSERTS ITS OWN EFFECT. A run that reported a path and wrote nothing is this
    // repo's oldest rule, and the report is the artifact nobody opens again.
    if (!existsSync(result.reportPath) || statSync(result.reportPath).size === 0) {
      throw new Error(`the report at ${result.reportPath} was not written, or is empty.`);
    }
    if (result.rowsRead === 0) {
      throw new Error(`read 0 rows from "${sheet}" — refusing to report a run over nothing (§T).`);
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

/**
 * A refusal must read as a refusal, not as a crash — the same entry-point shape
 * `triage-sheet.ts` was corrected to on 2026-10-01, for the same reason: every
 * refusal above is a sentence a QA is meant to act on, and fifteen frames of
 * `Module._compile` under it says "this tool is broken" instead.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.ts$|\.js$/, '') ===
    path.resolve(__filename).replace(/\.ts$|\.js$/, '');

// GUARDED, because `inspect-app.ts` was not: a unit spec imported it, `main()` ran at
// module scope in every worker, and the stray capture directories that produced were
// hunted for a day.
if (invokedDirectly) {
  main().catch((error: Error) => {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
  });
}
