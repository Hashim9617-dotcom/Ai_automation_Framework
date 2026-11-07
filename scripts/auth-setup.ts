#!/usr/bin/env node
/**
 * One-time interactive login.
 *
 *   pnpm auth --app dms                                 # the configured URL
 *   pnpm auth --app dms https://app.test/login
 *
 * Opens a real browser, you sign in by hand, and the resulting session is saved
 * to artifacts/<application>/auth/<environment>.json. Every test run afterwards
 * starts already logged in.
 *
 * `--app` is REQUIRED. It used to resolve the application from an ambient
 * `TEST_ENV`, which meant this command signed in to whatever the last run
 * happened to point at — see `resolveEnvironmentForApp`.
 *
 * This is what makes the platform work against ANY identity provider — SAML,
 * OIDC, Azure AD, Okta, an OTP on your phone, a captcha, a consent screen.
 * Scripting those is brittle at best and impossible at worst; doing it once by
 * hand is neither.
 *
 * The saved file contains live cookies and tokens. It lives under artifacts/,
 * which is gitignored, and it expires whenever your application's session does —
 * re-run this command when tests start landing on the login page again.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, type Browser } from '@playwright/test';
import {
  assertKitIntegrity,
  authStatePath,
  describeTargetBanner,
  maintainerMarkerPath,
  resolveEnvironmentForApp,
} from '@aitp/execution-engine';
import { findRepoRoot, rootLogger } from '@aitp/shared';

const log = rootLogger.child('auth');

const USAGE = 'usage: pnpm auth --app <application> [url]';

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, () => {
      rl.close();
      resolve();
    }),
  );
}

async function main(): Promise<void> {
  /**
   * THE INTEGRITY CHECK RUNS FIRST — before `.env`, before a browser, before
   * anything else this command would otherwise refuse on (C: kit lock).
   *
   * The position is the whole guarantee. A modified kit must not get as far as
   * reading a credential or opening the customer's application, so this cannot sit
   * after the argument parsing that happens to be convenient — and it goes ahead of
   * the ALLOW_WRITES refusal, which used to be first: a modified kit's ALLOW_WRITES
   * message is not a message anybody should trust either.
   *
   * `root` and the marker are computed here and passed in, never read inside the
   * check (§AJ), which is what lets the tests hand it fixture directories.
   */
  const kitRoot = findRepoRoot();
  assertKitIntegrity({ root: kitRoot, markerPath: maintainerMarkerPath(kitRoot) });
  /**
   * `--app` IS REQUIRED, and it is required HERE more than anywhere else.
   *
   * This used to be bare `loadEnvironment()`, which resolves `TEST_ENV` from the
   * ambient environment. On any machine that has ever run against the customer
   * system `.env` says `TEST_ENV=app`, so typing `pnpm auth` while onboarding a
   * SECOND application opened a browser at DMS and saved a live session under
   * `artifacts/dms/auth/app.json`. The banner below printed that faithfully, which
   * is SEC-2 exactly: a target stated from the source that chose it.
   */
  const env = resolveEnvironmentForApp({ argv: process.argv, usage: USAGE });
  // THE TARGET, FIRST, BEFORE A BROWSER OPENS. A human is about to sign in to a real
  // system; the one check they can make is which one, and the one they cannot make
  // afterwards is where the saved session came from.
  process.stdout.write(`\nSigning in to:\n${describeTargetBanner(env)}\n\n`);
  // A positional URL, never the `--app` flag or its value.
  const positional = process.argv.slice(2).filter((arg) => /^https?:\/\//i.test(arg));
  const url = positional[0] ?? env.baseUrl;
  const statePath = authStatePath(env);
  mkdirSync(path.dirname(statePath), { recursive: true });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    process.stdout.write(
      [
        '',
        '─────────────────────────────────────────────────────────────',
        ' Sign in to the application in the browser window.',
        '',
        ' Any login works — password, SSO, MFA, OTP, consent screens.',
        ' Get all the way to the landing page you would normally see',
        ' after logging in.',
        '',
        ' Then come back here and press Enter to save the session.',
        '─────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );

    await waitForEnter('Press Enter once you are logged in… ');

    const landedOn = page.url();
    await context.storageState({ path: statePath });

    log.info('Session saved', {
      environment: env.name,
      landedOn,
      file: path.relative(process.cwd(), statePath),
    });
    process.stdout.write(
      [
        '',
        `Saved to ${path.relative(process.cwd(), statePath)}`,
        `You landed on: ${landedOn}`,
        '',
        'Tests will now start already authenticated. Re-run',
        `\`pnpm auth --app ${env.application}\` whenever the session expires`,
        '(tests will start failing on the login page).',
        '',
      ].join('\n'),
    );
  } finally {
    await browser?.close();
  }
}

main().catch((error: Error) => {
  log.error('Could not save the session', { error: error.message });
  process.exitCode = 1;
});
