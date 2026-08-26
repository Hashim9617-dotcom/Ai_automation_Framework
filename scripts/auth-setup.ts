#!/usr/bin/env node
/**
 * One-time interactive login.
 *
 *   pnpm auth                       # uses BASE_URL from .env
 *   pnpm auth https://app.test/login
 *
 * Opens a real browser, you sign in by hand, and the resulting session is saved
 * to artifacts/auth/<TEST_ENV>.json. Every test run afterwards starts already
 * logged in.
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
import { authStatePath, loadEnvironment } from '@aitp/execution-engine';
import { rootLogger } from '@aitp/shared';

const log = rootLogger.child('auth');

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
  const env = loadEnvironment();
  const url = process.argv[2] ?? env.baseUrl;
  const statePath = authStatePath(env.name);
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
        'Tests will now start already authenticated. Re-run `pnpm auth` whenever',
        'the session expires (tests will start failing on the login page).',
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
