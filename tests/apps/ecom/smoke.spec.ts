import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyColumns, countBuckets, describeCounts, findRepoRoot } from '@aitp/shared';
import { SHEET_DRIFT_CSV } from '@aitp/reporting-engine';
import { test, expect, signedInPage } from './fixtures';
import { ModulePage } from './components';
import { summariseStatuses } from './network';
import { attachDriftRows } from './sheet-drift';

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

      /**
       * ---- the SOFT half: what the sheet expects, CLASSIFIED and recorded ----
       *
       * The previous version lower-cased both sides and reported everything that
       * did not match exactly, which put drift on 16 of 29 modules as one flat
       * list. That list is unactionable because it mixes two jobs with two owners:
       * `"Code"` against a page saying `"CATEGORY CODE"` needs nobody, and `"GST"`
       * against `"VAT %"` needs a decision. `classifyColumns` separates them, and
       * the rules are in `packages/shared/src/authored/sheet-drift.ts` with the
       * cases that must NOT be absorbed asserted by name in
       * `tests/unit/sheet-drift.spec.ts`.
       *
       * The ANNOTATION carries counts only. The column names go into
       * `sheet-drift.csv`, which a QA opens deliberately — a run.json with every
       * column name of every module in it is how a report grows unreadable, and
       * how a sheet's contents end up in an email nobody meant to send.
       */
      const expected = entry.expectedColumns ?? [];
      if (expected.length > 0) {
        const actual = await module.grid.headers();
        const rows = classifyColumns(expected, actual, {
          module: entry.module,
          caseId: entry.caseId,
        });
        const counts = countBuckets(rows);
        testInfo.annotations.push({
          type: 'sheet-drift',
          description:
            `${entry.caseId} ${entry.module}: ${describeCounts(counts)} ` +
            `(of ${expected.length} expected column(s)). The sheet is AI-generated and has ` +
            'never been through a human run, so "real" is a note for the QA rather than an ' +
            `application defect. Column names are in ${SHEET_DRIFT_CSV}.`,
        });
        await attachDriftRows(rows, testInfo);
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

      /**
       * HOW LONG THE DRAWER TOOK, recorded rather than reasoned about.
       *
       * `openCreate` waits up to 20 s for the trigger and then for the drawer, so
       * "the drawer is slow" and "the drawer never came" are the same red to a
       * reader of the report. The number separates them, and it is the only thing
       * that can say whether a future timeout change is warranted or a guess.
       */
      const requestedAt = Date.now();
      await module.openCreate();
      const drawerMs = Date.now() - requestedAt;
      testInfo.annotations.push({
        type: 'drawer-open-ms',
        description: `${entry.module}: ${drawerMs}`,
      });
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

/**
 * THE SESSION TESTS RUN UNSEEDED, and that is a correctness requirement.
 *
 * The fixture seeds the worker's sessionStorage into every document a test's context
 * opens, which is what makes one sign-in serve a whole worker. For a test whose
 * SUBJECT is the session, that seeding is the thing being claimed: "an authenticated
 * route is reachable without re-entering credentials" is trivially true of a context
 * that is handed a live access token before any application script runs.
 *
 * So AUTH-001 and AUTH-009 sign in for themselves in `unseededContext`. They cost one
 * extra sign-in each and they are the only two tests here that assert anything about
 * the session itself — the other sixty assert things about pages, and for those the
 * seeded context is exactly right.
 *
 * Logout moved out of this file entirely, to `logout-safety.spec.ts`, because the
 * dangerous case is not the click but the NAVIGATION AFTER it: that is the moment an
 * init script could re-seed a logged-out page, and it needs a test of its own that
 * fails if seeding ever leaks in.
 */
test.describe('Ecom auth and dashboard @ecom @smoke @readonly', () => {
  test('AUTH-001 a signed-in session reaches the application', async ({ unseededContext, env }) => {
    // wrong: taking the SEEDED `page` fixture, which is handed a live access token
    // before any application script runs — so this would assert that seeding works,
    // not that signing in produces a session that reaches the application. The
    // distinction is the whole reason `unseededContext` exists.
    const page = await signedInPage(unseededContext, env);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(page.url()).toContain('/dashboard');
  });

  test('AUTH-009 an authenticated route is reachable without re-entering credentials', async ({
    unseededContext,
    env,
  }) => {
    // wrong: navigating to a page that is public anyway, which proves nothing about
    // the session — or doing it in a seeded context, where the credentials were
    // never needed in the first place and "without re-entering" is vacuous. One
    // sign-in, then a SECOND navigation in the same tab, is the discriminating
    // observation: the session has to survive from one to the other on its own.
    const page = await signedInPage(unseededContext, env);
    const module = new ModulePage(page, 'Department');
    await module.open();
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
});
