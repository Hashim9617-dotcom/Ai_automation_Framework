import { test, expect } from '@aitp/execution-engine';
import { LoginPage } from './pages/login.page';

test.describe('Authentication', { tag: ['@smoke', '@auth'] }, () => {
  test('valid credentials sign the user in', async ({ makePage, env, page }) => {
    const login = makePage(LoginPage);
    await login.open();

    const admin = env.users.admin;
    expect(admin, 'config/env/<env>.json must define a users.admin entry').toBeDefined();
    await login.login(admin!.username, admin!.password);

    await expect(page.getByTestId('current-user')).toHaveText(admin!.username);
    await expect(page.getByTestId('logout-button')).toBeVisible();
  });

  test('invalid credentials are rejected with a message', async ({ makePage }) => {
    const login = makePage(LoginPage);
    await login.open();
    await login.login('hr.admin', 'wrong-password');

    expect(await login.hasError()).toBe(true);
    expect(await login.errorMessage()).toContain('Invalid credentials');
  });

  test('locator fallbacks are recorded for the healing history', async ({
    makePage,
    locatorTelemetry,
    env,
  }) => {
    const login = makePage(LoginPage);
    await login.open();
    await login.login(env.users.admin!.username, env.users.admin!.password);

    // Every resolution is captured — this is the data the Phase 2 self-healing
    // engine trains on, and what the dashboard surfaces as "flaky selectors".
    expect(locatorTelemetry.length).toBeGreaterThan(0);
    for (const entry of locatorTelemetry) {
      expect(entry.attempts).toBeGreaterThan(0);
    }
  });
});
