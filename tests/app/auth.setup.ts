import { test as setup, expect, authStatePath } from '@aitp/execution-engine';
import { LoginPage } from './pages/login.page';

/**
 * Automated counterpart to `pnpm auth`. A human running `pnpm auth` is the
 * only option for SSO/MFA/OTP — nothing scriptable there — but DmsSynergy's
 * own login form takes a plain username/password, and the suite otherwise has
 * no way to get a fresh session on CI, where nobody is at the browser. This
 * project reuses that same form via LoginPage and runs automatically before
 * every browser project (see the `dependencies` wiring in playwright.config.ts).
 *
 * It exists because the 15-minute `refresh_token` TTL (see
 * docs/dms-findings.md) means one saved session cannot outlive a ~19-minute
 * full run — the suite needs a session that is guaranteed fresh at the start
 * of every run, not whenever someone last remembered to run `pnpm auth`.
 *
 * `pnpm auth` keeps working exactly as before for SSO/MFA — this does not
 * replace it, it just means CI does not depend on it.
 */
setup('authenticate', async ({ makePage, env, page, log }) => {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'APP_USERNAME and APP_PASSWORD must be set in .env for automated login. ' +
        'If this application requires SSO, MFA, or an OTP, run `pnpm auth` by ' +
        'hand instead — that saved session is used as-is and this setup project ' +
        'is skipped by nothing needing it (delete artifacts/auth/<env>.json if ' +
        'you want a fresh manual login to take priority).',
    );
  }

  const login = makePage(LoginPage);
  await login.open();
  await login.login(username, password); // never logged — read from env, passed straight through

  await expect(page, 'login did not reach the app — check APP_USERNAME/APP_PASSWORD').not.toHaveURL(
    /\/login\b/,
    { timeout: env.timeouts.navigation },
  );

  const statePath = authStatePath(env.name);
  await page.context().storageState({ path: statePath });
  log.info('Automated session saved', { environment: env.name, landedOn: page.url() });
});
