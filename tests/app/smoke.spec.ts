import { test, expect, captureDomSnapshot } from '@aitp/execution-engine';
import { DashboardPage } from './pages/dashboard.page';

/**
 * The first thing to run against DmsSynergy. It proves the plumbing before any
 * feature test is worth trusting: the app is reachable, the saved session still
 * works, and the shell rendered.
 *
 * If this file fails, nothing else in tests/app/ is meaningful — fix this first.
 */
test.describe('DmsSynergy is reachable', { tag: ['@smoke', '@platform'] }, () => {
  test('the application responds', async ({ page, env, log }) => {
    const response = await page.goto(env.baseUrl, { waitUntil: 'domcontentloaded' });

    expect(response, `no response from ${env.baseUrl}`).not.toBeNull();
    expect(response!.status(), 'should not be a server error').toBeLessThan(500);
    log.info('Application responded', { url: page.url(), status: response!.status() });
  });

  test('the saved session keeps us signed in', async ({ makePage, page, log }) => {
    const dashboard = makePage(DashboardPage);
    await dashboard.open();

    // Bounced to /login means artifacts/auth/<env>.json is missing or expired.
    expect(
      await dashboard.isSignedOut(),
      'redirected to the login page — run `pnpm auth` again to refresh the saved session',
    ).toBe(false);

    await dashboard.expectLoaded();
    log.info('Signed in', { landedOn: page.url() });
  });

  test('records what the engine can see, for tracking over time', async ({ makePage, page, log }) => {
    const dashboard = makePage(DashboardPage);
    await dashboard.open();
    await dashboard.waitForStable();

    const snapshot = await captureDomSnapshot(page);
    const withTestId = snapshot.elements.filter((element) => element.testId).length;
    const coverage = snapshot.elements.length
      ? Math.round((withTestId / snapshot.elements.length) * 100)
      : 0;

    // Not a pass/fail bar — a number to watch. DmsSynergy currently ships no
    // test ids at all, so every locator leans on roles and accessible names.
    // If this ever rises, the suite gets cheaper and steadier for free.
    log.info('Dashboard inventory', {
      elements: snapshot.elements.length,
      withTestId,
      testIdCoveragePercent: coverage,
    });

    expect(snapshot.elements.length, 'no interactive elements — wrong URL?').toBeGreaterThan(0);
  });
});
