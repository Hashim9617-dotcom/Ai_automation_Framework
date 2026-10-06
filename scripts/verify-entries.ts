#!/usr/bin/env node
/**
 * Every module map entry, checked against the LIVE application. Read-only.
 *
 *   pnpm verify-entries --app <application>
 *
 * ## What this answers that nothing else can
 *
 * `validateModuleMap` proves a map against the CAPTURE — the screen as it was when
 * somebody walked it. That is a fact about a recording, and the run depends on a
 * different claim: that the route still opens today and the element that proves the
 * screen is still on it. Those two come apart silently, because a stale capture
 * validates perfectly.
 *
 * So this is the capture's falsifier, and the cheapest one there is: no sheet, no
 * workbook, no rows, one `goto` and one `count()` per module.
 *
 * ## It cannot click anything, and that is structural rather than careful
 *
 * The only browser calls below are `page.goto` and a locator `count()`, both inside
 * `createEntryVerifier` — the SAME function the run uses, which is the point. A
 * verifier written separately here would be a second opinion about the entry gate,
 * and the question is whether the gate the run uses still passes.
 *
 * There is no step executor, no `allowWrites` parameter anywhere in the call, and
 * nothing reads a row. `ALLOW_WRITES` in the environment refuses the command rather
 * than being ignored: a QA who set it is expecting writes, and silence would let
 * them believe this tool had performed some.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  authStatePath,
  createEntryVerifier,
  describeTargetBanner,
  loadCaptureFromDisk,
  loadEnvironment,
  requireApplicationArg,
  resolveEnvName,
} from '@aitp/execution-engine';
import { findRepoRoot, loadModuleMap } from '@aitp/shared';

const USAGE = 'usage: pnpm verify-entries --app <application>';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function main(): Promise<void> {
  /**
   * ALLOW_WRITES REFUSES FIRST, for the reason `pnpm run-sheet` refuses on it:
   * its answer depends on nothing else, so every later refusal would otherwise be
   * read as the reason no writes happened.
   */
  if (process.env.ALLOW_WRITES !== undefined) {
    throw new Error(
      'refusing to start: ALLOW_WRITES is set in the environment, and this command has ' +
        'nothing to do with writes. It opens a route and counts one element per module — ' +
        'there is no step executor in it and no parameter to turn anything on.\n' +
        '  Unset ALLOW_WRITES and run again. The refusal exists so you are not left ' +
        'wondering what it did with the flag.',
    );
  }

  const application = requireApplicationArg({ argv: process.argv, usage: USAGE });

  const root = findRepoRoot();
  const mapFile = path.join(root, 'config', 'apps', application, 'module-map.json');
  if (!existsSync(mapFile)) {
    throw new Error(
      `refusing to run: there is no module map for application "${application}" at ` +
        `${path.relative(root, mapFile)}.\n` +
        '  Either the name is wrong, or this application has not been set up yet — see ' +
        'docs/ADD-AN-APPLICATION.md.',
    );
  }
  const map = loadModuleMap(mapFile);

  const env = loadEnvironment(resolveEnvName());

  // THE TARGET, FIRST, before a browser exists. A wrong environment is then
  // obvious on line one rather than ten state-assert failures later (SEC-2).
  process.stdout.write(`\nRunning against:\n${describeTargetBanner(env)}\n\n`);

  /**
   * THE SESSION FILE, before the browser — the same two-failure split
   * `pnpm run-sheet` makes.
   *
   * NO FILE means nobody has signed in on this machine, and that is knowable here.
   * EXPIRED cannot be known without asking the application, so it stays a per-module
   * `auth` verdict, which is what `createEntryVerifier` already produces.
   */
  const session = authStatePath(env);
  if (!existsSync(session)) {
    throw new Error(
      `refusing to run: no saved session at ${path.relative(root, session)}.\n` +
        '  Run `pnpm auth` first — it signs in once, interactively, and saves the session ' +
        'here. This is NOT the same as an expired session: nothing has signed in yet.',
    );
  }
  const sessionAgeHours = (Date.now() - statSync(session).mtimeMs) / 3_600_000;

  /**
   * THE CAPTURE, because the map is validated against it.
   *
   * Not optional and not skippable: `createEntryVerifier` refuses a map it cannot
   * check, and a tool that compared the live page against nothing would report
   * every module `verified` while proving only that a route opens.
   */
  const source = loadCaptureFromDisk(application, { targetHost: hostOf(env.baseUrl) });
  if (source.kind !== 'loaded') {
    throw new Error(
      `refusing to run: ${source.reason}\n` +
        (source.skipped.length > 0
          ? `  ${source.skipped.length} session(s) were skipped:\n` +
            source.skipped.map((entry) => `    - ${entry.sessionId}: ${entry.why}`).join('\n') +
            '\n'
          : '') +
        '  The map is proven against the capture before the live page is asked anything, so ' +
        'with no capture there is nothing to prove it against.',
    );
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      // Routes in the map are PATHS, so a relative `goto` needs a base. Without it
      // Playwright answers "Cannot navigate to invalid URL", which arrives as an
      // `auth` failure and reads like a credential problem.
      baseURL: env.baseUrl,
      ignoreHTTPSErrors: true,
      storageState: session,
    });
    const page = await context.newPage();

    const { verify, validation } = createEntryVerifier({
      map,
      capture: source.capture,
      mapFile,
      page,
      /**
       * The saved session IS the sign-in, so this only checks it was not rejected.
       * A redirect to the login screen is the one thing a storage state cannot tell
       * us by itself.
       */
      signIn: async () => {
        await page.goto('/');
        if (/\/login(\b|$)/.test(page.url())) {
          throw new Error(
            `the saved session at ${path.relative(root, session)} was rejected — the ` +
              'application redirected to its login screen. Run `pnpm auth` again.',
          );
        }
      },
    });

    const provable = Object.keys(validation.provable).sort();

    /**
     * ZERO PROVABLE MODULES IS A REFUSAL, not a clean run (§T).
     *
     * A loop over nothing prints a tidy "0 failed" and means the map proves nothing
     * about the capture — the check had no subject, which is a different answer
     * from "every module passed" and must not be able to look like it.
     */
    if (provable.length === 0) {
      throw new Error(
        `refusing to report: not one of the ${Object.keys(map).length} entries in ` +
          `${path.relative(root, mapFile)} can be proven against the capture, so there is ` +
          'nothing to check against the live application:\n' +
          validation.unprovable.map((entry) => `  - ${entry.why}`).join('\n'),
      );
    }

    process.stdout.write(
      [
        `Capture:   ${source.sessions.length} session(s), ${source.capture.states.length} state(s)`,
        `Session:   ${sessionAgeHours.toFixed(1)} h old`,
        `Modules:   ${provable.length} provable of ${Object.keys(map).length} in the map`,
        ...(validation.unprovable.length > 0
          ? [
              `           ${validation.unprovable.length} not provable against the capture, so not checked here:`,
              ...validation.unprovable.map((entry) => `             - ${entry.module}`),
            ]
          : []),
        '',
        'module                           route                          verdict',
        '-------------------------------- ------------------------------ -------',
      ].join('\n') + '\n',
    );

    const verdicts = new Map<string, number>();
    const details: string[] = [];
    for (const module of provable) {
      const verdict = await verify(module);
      const label = verdict.verified ? 'verified' : verdict.reason;
      verdicts.set(label, (verdicts.get(label) ?? 0) + 1);
      process.stdout.write(`${module.padEnd(32)} ${map[module]!.route.padEnd(30)} ${label}\n`);
      if (!verdict.verified) details.push(`  ${module}: ${verdict.detail}`);
    }

    process.stdout.write(
      '\n' +
        [...verdicts]
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => `${count} ${label}`)
          .join(', ') +
        ` of ${provable.length}\n`,
    );
    if (details.length > 0) process.stdout.write('\n' + details.join('\n') + '\n');
    process.stdout.write('\n');

    /**
     * ASSERTS ITS OWN EFFECT. A verifier that checked nothing and printed a table
     * is this repo's oldest rule, and the loop above is exactly the shape that can
     * run zero times without saying so.
     */
    const checked = [...verdicts.values()].reduce((total, count) => total + count, 0);
    if (checked !== provable.length) {
      throw new Error(
        `reported ${checked} verdict(s) for ${provable.length} provable module(s) — refusing ` +
          'to let a partial check read as a complete one.',
      );
    }

    // A NON-ZERO EXIT when anything failed, so this is usable as a gate. The table
    // above is the report; this is the answer.
    if (details.length > 0) process.exitCode = 1;

    await context.close();
  } finally {
    await browser.close();
  }
}

/** A refusal must read as a refusal, not as a crash — the same shape as 3b's CLIs. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.ts$|\.js$/, '') ===
    path.resolve(__filename).replace(/\.ts$|\.js$/, '');

if (invokedDirectly) {
  main().catch((error: Error) => {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
  });
}
