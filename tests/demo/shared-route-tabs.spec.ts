import type { Page } from '@playwright/test';
import { test, expect, createEntryVerifier, type EntryPage } from '@aitp/execution-engine';
import { validateModuleMap, type BoundedCapture, type ModuleMap } from '@aitp/shared';

/**
 * TWO MODULES AT ONE ROUTE, AND THE WRONG TAB OPEN (P0, 2026-10-03).
 *
 * ## The hole this closes
 *
 * A provenBy proves which SCREEN a run reached — that is the route rule from batch 1.
 * It cannot prove which of several modules AT that screen it reached, and the real
 * map has two such groups. Measured 2026-10-03 on the DMS map:
 *
 *     /files              File Explorer | Document    both  tree "Workspaces"
 *     /admin/user-roles   User Role | user role | Permissions
 *                                                 all  heading "User role"
 *
 * `Permissions` is a TAB inside User Role. With an identical proof its rows would
 * have run against the User Role view and reported passes and failures about a
 * screen they were never written for — worse than a refusal, because a refusal is
 * visible and a wrong pass is not.
 *
 * ## Why `setContent`, and what that costs
 *
 * The bundled demo app has no tab strip: measured, it has a login form and an
 * employees screen. The page is written here, which stubs the PAGE and not the
 * BROWSER — a real `getByRole('tab', { selected: true })`, a real `count()`, real
 * `aria-selected` resolution by Playwright's own engine. That last part is the point:
 * the capture-side filter and the live-page lookup must agree about what `selected`
 * means, and only the real locator can say what Playwright does with it.
 *
 * What it cannot show is the ORDER (§R) — a navigation that undoes a sign-in. That is
 * `authored-entry.spec.ts`'s job against the real app, and this file does not claim it.
 *
 * ## §W — both halves, and the refusal is the load-bearing one
 *
 * Right tab open must VERIFY. Wrong tab open must be `state-assert` and name the
 * property, because "the screen is wrong" and "the screen is right and the wrong tab
 * is open" send a QA to two different places.
 */

const TABBED_PAGE = (openTab: 'Roles' | 'Permissions'): string => `<!doctype html>
<html><body>
  <h1>User role</h1>
  <div role="tablist">
    <button role="tab" aria-selected="${openTab === 'Roles'}">Roles</button>
    <button role="tab" aria-selected="${openTab === 'Permissions'}">Permissions</button>
  </div>
</body></html>`;

/**
 * TWO states at ONE route — the same screen walked with each tab open.
 *
 * That is what a `pnpm inspect` session of a tabbed screen produces, and it is the
 * fixture the rule needs: with only one state captured, the closed tab's module
 * could never be proven at all, and the test would be measuring a missing capture
 * rather than an indistinguishable proof.
 *
 * Discriminating on purpose: both tabs exist in BOTH states — only `selected` moves.
 * A capture where each state held one tab would let an identical-proof map through,
 * because there would be no sibling to be confused with.
 */
const tabState = (id: string, open: 'Roles' | 'Permissions') => ({
  id,
  label: id,
  url: 'http://127.0.0.1:4173/admin/user-roles',
  truncated: false,
  nodes: [
    { role: 'heading', name: 'User role', enabled: true },
    { role: 'tab', name: 'Roles', enabled: true, selected: open === 'Roles' },
    { role: 'tab', name: 'Permissions', enabled: true, selected: open === 'Permissions' },
  ],
});

const CAPTURE: BoundedCapture = {
  sessionId: 'tabs',
  states: [tabState('roles-tab', 'Roles'), tabState('permissions-tab', 'Permissions')],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/**
 * A page object that keeps its methods BOUND.
 *
 * `{ ...page, goto }` looked right and threw `options.page.getByRole is not a
 * function`: Playwright's `Page` carries its methods on the prototype, and a spread
 * copies own properties only. The route is already open here, so `goto` is the one
 * method that must not run — there is no server behind `/admin/user-roles`.
 */
const pageAt = (page: Page): EntryPage => ({
  goto: async () => null,
  getByRole: page.getByRole.bind(page),
  getByText: page.getByText.bind(page),
});

/** Two modules at one route, each proved by the tab that is OPEN for it. */
const DISTINGUISHED: ModuleMap = {
  'User Role': {
    route: '/admin/user-roles',
    provenBy: { role: 'tab', name: 'Roles', selected: true },
  },
  Permissions: {
    route: '/admin/user-roles',
    provenBy: { role: 'tab', name: 'Permissions', selected: true },
  },
};

test.describe('a shared route needs a state-distinguishing proof @demo', () => {
  test('T1: the wrong tab open is `state-assert`, and the message names the property', async ({
    page,
  }) => {
    // wrong: the entry verifies, and every Permissions row then runs against the
    // Roles tab — reporting passes and failures about a screen it never reached.
    // That is the DMS map's state today for three modules at /admin/user-roles.
    await page.setContent(TABBED_PAGE('Roles'));

    const { verify, validation } = createEntryVerifier({
      map: DISTINGUISHED,
      capture: CAPTURE,
      mapFile: 'm.json',
      page: pageAt(page),
      signIn: async () => {},
    });

    // §T: the map must have been PROVABLE, or this measures the validator refusing
    // rather than the page failing the proof. Two different reds.
    expect(validation.unprovable).toEqual([]);

    expect(await verify('Permissions')).toEqual({
      verified: false,
      reason: 'state-assert',
      // The PROPERTY in the message, because "the screen is wrong" and "the screen
      // is right and the wrong tab is open" send a QA to two different places.
      detail: expect.stringContaining('selected=true'),
    });
    const verdict = await verify('Permissions');
    expect(verdict.verified === false && verdict.detail).toContain('wrong tab open');
  });

  test('T1: the RIGHT tab open verifies — the same verifier, the same run', async ({ page }) => {
    // wrong: the proof refuses whatever is on screen, so T1 above passes while
    // nothing can ever be verified. A rule that refuses everything is satisfied
    // without knowing anything about the page.
    await page.setContent(TABBED_PAGE('Permissions'));

    const { verify } = createEntryVerifier({
      map: DISTINGUISHED,
      capture: CAPTURE,
      mapFile: 'm.json',
      page: pageAt(page),
      signIn: async () => {},
    });

    expect(await verify('Permissions')).toEqual({ verified: true });
    // DISCRIMINATING against the line above: the sibling module, same page, same
    // route, and its tab is NOT the open one.
    expect(await verify('User Role')).toEqual({
      verified: false,
      reason: 'state-assert',
      detail: expect.stringContaining('Roles'),
    });
  });

  test('T2: identical proofs at one route refuse BOTH, by name', async () => {
    // wrong: both are accepted, because each one on its own matches exactly one
    // element in exactly one state at exactly its declared route — every check batch
    // 1 added passes, and the two modules are still indistinguishable.
    const identical: ModuleMap = {
      'User Role': { route: '/admin/user-roles', provenBy: { role: 'heading', name: 'User role' } },
      Permissions: { route: '/admin/user-roles', provenBy: { role: 'heading', name: 'User role' } },
    };

    const { provable, unprovable } = validateModuleMap(identical, CAPTURE, 'm.json');

    expect(provable).toEqual({});
    expect(unprovable.map((entry) => entry.module).sort()).toEqual(['Permissions', 'User Role']);
    expect(unprovable[0]!.why).toMatch(/shared route "\/admin\/user-roles"/);
    expect(unprovable[0]!.why).toMatch(/cannot tell/);
  });

  test('T2: and a DISTINGUISHED pair at the same route is accepted', async () => {
    // wrong: the shared-route rule refuses any two modules at one route, so a
    // genuinely tabbed screen can never be automated and the only way to pass the
    // test above is to make the feature useless. This is the half that keeps the
    // rule from being a blanket ban.
    const { provable, unprovable } = validateModuleMap(DISTINGUISHED, CAPTURE, 'm.json');

    expect(unprovable).toEqual([]);
    expect(Object.keys(provable).sort()).toEqual(['Permissions', 'User Role']);
  });
});
