import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { test, expect } from './fixtures';
import { ModulePage } from './components';
import { summariseStatuses } from './network';

/**
 * THE ECOM READ-ONLY SMOKE SUITE, driven by `config/apps/ecom/smoke.json`.
 *
 * ## Read-only, in three layers
 *
 * 1. **The Drawer component throws** on any submit-shaped control. Prevention.
 * 2. **The network guard fails** any test that sends a non-GET request to the
 *    application outside the two allowlisted auth paths. Detection — after the
 *    fact, which is why it is second and not first.
 * 3. **No `@write` tag exists in this directory**, so `ALLOW_WRITES` has nothing
 *    to act on, and `tests/unit/write-spec-scope.spec.ts` holds that.
 *
 * ## Sheet expectations are SOFT
 *
 * The sheet was AI-generated from requirement documents and walkthrough videos; it
 * has never been through a human run. So a column it names that the page does not
 * have is a fact about the SHEET, and it is recorded as a `sheet-drift` annotation
 * rather than a failure. Making it hard would mean this suite reports the
 * application as broken on the strength of a document nobody has checked — and the
 * drift list is the deliverable that gets the sheet corrected.
 */

interface SmokeEntry {
  caseId: string;
  module: string;
  entity: string;
  url: string;
  expectGrid?: boolean;
  expectedColumns?: string[];
}
interface Manifest {
  listLoad: SmokeEntry[];
  createOpens: SmokeEntry[];
  named: Array<{ caseId: string; kind: string; route: string }>;
}

const manifest = JSON.parse(
  readFileSync(path.join(findRepoRoot(), 'config', 'apps', 'ecom', 'smoke.json'), 'utf8'),
) as Manifest;

// §T — a manifest that failed to load would produce a suite of ZERO tests, and an
// empty run reports as a pass. This refuses at collection instead.
if (manifest.listLoad.length === 0) {
  throw new Error('config/apps/ecom/smoke.json has no list-load entries — refusing to collect');
}

test.describe('Ecom list pages load @ecom @smoke @readonly', () => {
  for (const entry of manifest.listLoad) {
    test(`${entry.caseId} ${entry.module} list page loads`, async ({
      page,
      ensureSignedIn,
      network,
    }, testInfo) => {
      // wrong: a page that rendered the LOGIN form would satisfy "no 5xx and no
      // console errors" perfectly — the session expires during long runs, and a
      // silent redirect to /login is this application's failure mode, not an
      // exception. So the first thing asserted after navigating is that we are
      // still signed in, and a re-login is annotated rather than hidden.
      const module = new ModulePage(page, entry.entity);
      await module.open();
      const reLogged = await ensureSignedIn(page);
      if (reLogged) await module.open();

      expect(page.url(), 'landed on the login page even after re-signing in').toContain(entry.url);

      const heading = await module.heading();
      expect(heading, `${entry.module} rendered no heading`).not.toBeNull();

      if (entry.expectGrid === false) {
        // PutAway: its list was never captured without a dialog open, so no
        // evidence says a grid renders there. Asserting one would fail for a
        // reason about the capture rather than about the application.
        testInfo.annotations.push({
          type: 'list-layout-not-captured',
          description:
            `no capture of ${entry.entity}'s list page without a dialog open, so the grid ` +
            'assertion is skipped for it. Capture the screen to turn this into a real check.',
        });
      } else {
        expect(await module.grid.isPresent(), `${entry.module} rendered no grid`).toBe(true);
      }

      // ---- the SOFT half: what the sheet expects, recorded not enforced ----
      const expected = entry.expectedColumns ?? [];
      if (expected.length > 0) {
        const actual = await module.grid.headers();
        const lower = actual.map((h) => h.toLowerCase());
        const missing = expected.filter((c) => !lower.includes(c.toLowerCase()));
        if (missing.length > 0) {
          testInfo.annotations.push({
            type: 'sheet-drift',
            description:
              `${entry.caseId} ${entry.module}: the sheet expects ${expected.length} column(s), ` +
              `${missing.length} not on the page — ${missing.join(', ')}. The sheet is ` +
              'AI-generated and has never been through a human run, so this is a note for the ' +
              'QA rather than an application defect.',
          });
        }
      }

      testInfo.annotations.push({
        type: 'network',
        description: summariseStatuses(network),
      });
    });
  }
});

test.describe('Ecom create forms open and close @ecom @smoke @readonly', () => {
  for (const entry of manifest.createOpens) {
    test(`${entry.caseId} ${entry.module} create form opens`, async ({
      page,
      ensureSignedIn,
      network,
    }, testInfo) => {
      // wrong: a test that opened the drawer and left it, or one that clicked the
      // drawer's own submit control. The second is the dangerous one and it cannot
      // happen here: `openCreate` refuses to look for a trigger while a dialog is
      // open, and `Drawer.click` throws on anything submit-shaped. What this adds
      // is the POSITIVE half — the form really opened, really had fields, and was
      // really dismissed, so the refusals above are not passing vacuously.
      const module = new ModulePage(page, entry.entity);
      await module.open();
      const reLogged = await ensureSignedIn(page);
      if (reLogged) await module.open();

      await module.openCreate();
      expect(await module.drawer.isOpen(), 'the create drawer did not open').toBe(true);

      const form = module.form();
      const fields = await form.fieldCount();
      expect(fields, `${entry.module}'s create form rendered no fields`).toBeGreaterThan(0);

      const stepper = module.stepper();
      if (await stepper.hasSteps()) {
        testInfo.annotations.push({
          type: 'stepper',
          description: `${entry.module}: ${(await stepper.stepLabels()).join(' | ')}`,
        });
      }

      const how = await module.drawer.dismiss();
      testInfo.annotations.push({ type: 'dismissed-by', description: how });
      expect(await module.drawer.isOpen(), 'the drawer did not close').toBe(false);

      // NOTHING WAS SENT. The fixture's guard asserts this for every test; saying
      // it here too makes the create case's own claim explicit, because this is
      // the one case that deliberately opens a write-capable form.
      expect(
        network.writeAttempts,
        'opening and dismissing a create form sent a non-GET request',
      ).toEqual([]);

      testInfo.annotations.push({ type: 'network', description: summariseStatuses(network) });
    });
  }
});

test.describe('Ecom auth and dashboard @ecom @smoke @readonly', () => {
  test('AUTH-001 a signed-in session reaches the application', async ({ page, ensureSignedIn }) => {
    // wrong: asserting the login FORM works by filling it again — which is a
    // second sign-in, not a check that the first one took. The fixture has already
    // signed this worker in, so the claim being made is that the resulting session
    // reaches an authenticated page, which is what every other test depends on.
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const reLogged = await ensureSignedIn(page);
    if (reLogged) await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(page.url()).toContain('/dashboard');
  });

  test('AUTH-009 an authenticated route is reachable without re-entering credentials', async ({
    page,
    ensureSignedIn,
  }) => {
    // wrong: navigating to a page that is public anyway, which proves nothing
    // about the session. A module list page is behind auth, so reaching one
    // without a login form is the discriminating observation.
    const module = new ModulePage(page, 'Department');
    await module.open();
    const reLogged = await ensureSignedIn(page);
    if (reLogged) await module.open();
    expect(page.url()).toContain('/admin/domains/Department');
    expect(await module.heading()).not.toBeNull();
  });

  test('DASH-001 the dashboard loads', async ({ page, ensureSignedIn, network }, testInfo) => {
    // wrong: asserting a specific tile or figure. Those are live values and this
    // suite must not read them — the claim is that the page loads clean, which the
    // fixture's guards turn into "no 5xx, no unexpected 4xx, no console errors".
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const reLogged = await ensureSignedIn(page);
    if (reLogged) await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(page.url()).toContain('/dashboard');
    testInfo.annotations.push({ type: 'network', description: summariseStatuses(network) });
  });

  test('DASH-006 the dashboard renders its own content region', async ({
    page,
    ensureSignedIn,
  }) => {
    // wrong: DASH-001 twice. This one asserts the page has a main region with
    // something in it, which tells a blank authenticated shell from a dashboard —
    // a URL check alone cannot, and a blank shell is what a half-failed load gives.
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const reLogged = await ensureSignedIn(page);
    if (reLogged) await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main').first();
    await expect(main).toBeVisible();
    expect((await main.innerText()).trim().length).toBeGreaterThan(0);
  });

  test('AUTH-010 signing out returns to the login route', async ({ browser, env }, testInfo) => {
    // wrong: logging out in the SHARED worker context, which would destroy the
    // session every later test in that worker depends on — and the failures would
    // land on whichever module happened to run next, looking like an application
    // problem. Its own context is not tidiness; it is the only way this test can
    // exist beside the others.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      const { signIn } = await import('./fixtures');
      await signIn(page, env);
      expect(page.url(), 'the sign-in did not leave the login route').not.toContain('/login');

      const module = new ModulePage(page, 'Department');
      await module.topBar.openUserMenu();
      const logout = module.topBar.logout().first();
      await expect(logout).toBeVisible();
      await logout.click();

      await page.waitForURL(/\/(login|signin|sign-in)\/?$/i, { timeout: 30_000 });
      expect(page.url()).toMatch(/\/(login|signin|sign-in)\/?$/i);
      testInfo.annotations.push({
        type: 'own-context',
        description: 'logout ran in its own context',
      });
    } finally {
      await context.close();
    }
  });
});
