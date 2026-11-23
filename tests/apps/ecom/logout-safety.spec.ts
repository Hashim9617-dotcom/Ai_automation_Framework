import { test, expect, isLoginRoute, signedInPage, REFRESH_WAIT_MS } from './fixtures';
import { ModulePage } from './components';

/**
 * A LOGOUT MUST STAY LOGGED OUT — which the session fix could silently undo.
 *
 * ## The hazard this exists for
 *
 * The fixture seeds the worker's sessionStorage into every document a test's context
 * opens, through `addInitScript`. That is what makes one sign-in serve a whole
 * worker. It also runs on EVERY document load, including the one after a logout — so
 * in a seeded context a logged-out page would be handed a live access token by the
 * next navigation and signed straight back in.
 *
 * A logout test in a seeded context would therefore PASS while proving the opposite
 * of its own name: it would see `/login` immediately after clicking logout (the
 * application put it there) and never discover that the next navigation undoes it.
 *
 * So these tests take `unseededContext` — no restored state, no init script — and
 * sign in for themselves. The claim is then about the application rather than about
 * the fixture.
 *
 * ## Why the second test is the one that matters
 *
 * L1 asserts the familiar thing: clicking logout lands on the login route. L2 is the
 * one that catches a seeding leak, because it navigates AFTER the logout — which is
 * the only moment an init script could re-seed. If seeding ever reaches this
 * context, L2 fails and L1 does not, which is exactly the asymmetry a guard needs:
 * the test that can fail is the test that is doing work.
 *
 * READ-ONLY: it signs in, signs out and navigates. Nothing is created or saved.
 */

const MODULE = 'Department';

test.describe('Ecom logout stays logged out @ecom @smoke @readonly', () => {
  test('L1 signing out returns to the login route', async ({ unseededContext, env }, testInfo) => {
    // wrong: running this in the SHARED seeded context, which would destroy the
    // session every later test in the worker depends on — and the failures would
    // land on whichever module ran next, looking like an application problem. Its
    // own context is not tidiness; it is the only way this test can exist beside
    // the others.
    const page = await signedInPage(unseededContext, env);
    expect(page.url(), 'the sign-in did not leave the login route').not.toContain('/login');

    const module = new ModulePage(page, MODULE);
    await module.topBar.openUserMenu();
    const logout = module.topBar.logout().first();
    await expect(logout).toBeVisible();
    await logout.click();

    await page.waitForURL((url) => isLoginRoute(url.toString()), { timeout: 30_000 });
    expect(isLoginRoute(page.url())).toBe(true);
    testInfo.annotations.push({
      type: 'own-context',
      description: 'logout ran in an unseeded context of its own',
    });
  });

  test('L2 after a logout, an authenticated route STAYS on the login route', async ({
    unseededContext,
    env,
  }, testInfo) => {
    // wrong: a seeded context would hand this page the worker's live access token on
    // the navigation below — the init script runs before any application script on
    // every document — so the page would land on the module and this test would
    // report that logging out does not log you out. That is the leak this exists to
    // catch, and L1 cannot catch it because L1 never navigates after the logout.
    const page = await signedInPage(unseededContext, env);
    const module = new ModulePage(page, MODULE);

    await module.topBar.openUserMenu();
    await module.topBar.logout().first().click();
    await page.waitForURL((url) => isLoginRoute(url.toString()), { timeout: 30_000 });

    // THE NAVIGATION IS THE TEST. Asking for an authenticated route after a logout
    // must come back to the login route and stay there.
    await page.goto(`/admin/domains/${MODULE}`, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + REFRESH_WAIT_MS;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const here = new URL(page.url()).pathname;
      if (seen.at(-1) !== here) seen.push(here);
      await page.waitForTimeout(100);
    }

    testInfo.annotations.push({
      type: 'logout-safety',
      description: `after logout, ${REFRESH_WAIT_MS}ms of navigation went: ${seen.join(' -> ')}`,
    });

    /**
     * THE FIRST SAMPLE IS THE MODULE PATH, ALWAYS, and the first version of this
     * test asserted it was not.
     *
     * `goto` puts the requested path in the address bar before the application's own
     * guard has run, so "every path seen was the login route" is unsatisfiable — it
     * failed on a correctly logged-out page with
     * `visited /admin/domains/Department -> /login`, which is the right behaviour
     * described as a fault. Same observation-point mistake the session diagnostic
     * made, in a different costume.
     *
     * What a re-seeding leak would actually look like is the page STAYING on the
     * module path, so the two assertions are: it reached the login route, and from
     * the moment it got there it never left. Both are needed — "it reached /login"
     * alone would also be satisfied by a page that bounced back out a second later.
     */
    const firstLogin = seen.findIndex((pathname) => isLoginRoute(`https://host${pathname}`));
    expect(
      firstLogin,
      `a logged-out page never reached the login route at all: ${seen.join(' -> ')} — the ` +
        'session was re-seeded after a logout',
    ).toBeGreaterThanOrEqual(0);
    expect(
      seen.slice(firstLogin).every((pathname) => isLoginRoute(`https://host${pathname}`)),
      `a logged-out page LEFT the login route again: ${seen.join(' -> ')}`,
    ).toBe(true);
    // Bounded on the same window a real expiry gets, so "it stayed" means the same
    // thing here as it does in `ensureSignedIn` rather than being a second rule.
    expect(
      isLoginRoute(page.url()),
      `a logged-out page ended on ${new URL(page.url()).pathname}`,
    ).toBe(true);
  });
});
