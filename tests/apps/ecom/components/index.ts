import { expect, type Locator, type Page } from '@playwright/test';
import { APP_ERROR_RELOAD, appErrorBoundaryMessage, classifyRender } from './app-render';
import { readableName } from './names';
import { mayClickInDialog, mayClickOutsideDialog } from './write-safety';

export * from './app-render';
export * from './names';
export * from './write-safety';

/**
 * THE ECOM COMPONENT LIBRARY — keyed by ROLE and STRUCTURE, never by visible label.
 *
 * ## Why role and structure
 *
 * Measured across 88 captured states: 55–68 label-vs-accessible-name divergences
 * per page, median 63. A locator written against what a human sees on the page is
 * wrong about two thirds of a page's controls here. The accessible name is what
 * `getByRole` matches, so that is what these components use — and because those
 * names carry icon-font glyphs, every comparison goes through `readableName`.
 *
 * ## One ModulePage for every module
 *
 * All 29 modules are `/admin/domains/<Entity>` with the same furniture: a grid, a
 * create control that opens a drawer on the SAME url, a search box, pagination.
 * They differ in their fields, not their shape, so there is one page object taking
 * the entity rather than 29 near-identical ones.
 *
 * ## Navigation is by URL
 *
 * Not by the sidebar, although the sidebar IS addressable — 55–61 readable-named
 * links per state, 54 of them on every state. The URL is uniform and the nav is
 * not: 9 of 30 entities have no sidebar link whose name matches them, so a
 * name-driven nav would need a per-module mapping that the URL makes unnecessary.
 */

/** Everything a component needs. Passed in, so nothing reads ambient state. */
export interface ComponentContext {
  page: Page;
}

abstract class Component {
  constructor(protected readonly page: Page) {}

  /** The accessible name of a locator, normalised. */
  protected async nameOf(locator: Locator): Promise<string> {
    return readableName(
      (await locator.getAttribute('aria-label')) ?? (await locator.innerText().catch(() => '')),
    );
  }
}

/**
 * THE GRID: rows, headers, pagination, search.
 *
 * Addressed by `row`/`columnheader`/`cell` roles rather than by a `table` role,
 * because two captured list pages render no `table` role at all. A component that
 * required one would fail on those for a reason that is about markup rather than
 * about the application working.
 */
export class Grid extends Component {
  /** Every header cell's readable text, left to right. */
  async headers(): Promise<string[]> {
    const cells = await this.page.getByRole('columnheader').all();
    const out: string[] = [];
    for (const cell of cells) out.push(readableName(await cell.innerText().catch(() => '')));
    return out;
  }

  /** Data rows, excluding the header row when the markup supplies one. */
  rows(): Locator {
    return this.page.getByRole('row');
  }

  async rowCount(): Promise<number> {
    return this.rows().count();
  }

  /**
   * Is a grid present at all?
   *
   * TRUE when there is at least one `columnheader` OR one `row`. Either alone is
   * enough: an empty list renders its headers with no rows, and a list whose
   * markup omits `columnheader` still renders rows. Requiring both would call a
   * correctly-empty list a failure.
   */
  async isPresent(timeout = 20_000): Promise<boolean> {
    /**
     * WAITS. The grid renders AFTER the heading on these pages.
     *
     * This read `count()` twice and returned immediately, which is a one-shot
     * check — only `expect(locator)` and actions auto-wait in Playwright. So a
     * page that had rendered its heading but not yet its grid answered "no grid",
     * and the failure said `rendered no grid` about a page that renders one. The
     * heading fix one level up made this the next thing to surface.
     *
     * It returns a BOOLEAN rather than throwing, because one caller — PutAway —
     * legitimately expects no grid, and a throw would make "absent" and "not yet"
     * indistinguishable to it.
     */
    try {
      await expect(
        this.page.getByRole('columnheader').or(this.page.getByRole('row')).first(),
      ).toBeVisible({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** The list's own search box, if it has one. */
  search(): Locator {
    return this.page.getByRole('searchbox').or(this.page.getByRole('textbox', { name: /search/i }));
  }

  /** Pagination controls are numbered buttons — "1", "2", "3" — in every capture. */
  pageButtons(): Locator {
    return this.page.getByRole('button').filter({ hasText: /^\s*\d+\s*$/ });
  }
}

/**
 * THE DRAWER / MODAL, and the component that REFUSES to write.
 *
 * Every create form in this application opens as a dialog on the list page's own
 * URL — all 28 captured create forms, without exception. So "the form opened" is
 * `role=dialog` becoming visible, not a navigation.
 *
 * `click()` asks `mayClickInDialog` and THROWS. There is no parameter to override
 * it, because the thing being prevented is a real write into a shared development
 * environment and an override is the hole somebody uses at five o'clock.
 */
export class Drawer extends Component {
  root(): Locator {
    return this.page.getByRole('dialog');
  }

  async isOpen(): Promise<boolean> {
    return (await this.root().count()) > 0 && (await this.root().first().isVisible());
  }

  async waitForOpen(timeout = 15_000): Promise<void> {
    await expect(this.root().first()).toBeVisible({ timeout });
  }

  async waitForClosed(timeout = 15_000): Promise<void> {
    await expect(this.root()).toHaveCount(0, { timeout });
  }

  /** The dialog's own heading, normalised. `null` when it has none. */
  async title(): Promise<string | null> {
    const heading = this.root().getByRole('heading').first();
    if ((await heading.count()) === 0) return null;
    return readableName(await heading.innerText());
  }

  /**
   * Clicks a control INSIDE the dialog, or throws.
   *
   * The refusal is the point of this method existing — a spec that wanted to click
   * freely would use `page` directly, and `tests/unit/ecom-write-safety.spec.ts`
   * asserts no ecom spec does.
   */
  async click(accessibleName: string): Promise<void> {
    const verdict = mayClickInDialog(accessibleName);
    if (!verdict.allowed) throw new Error(verdict.why);
    await this.root().first().getByRole('button', { name: accessibleName }).first().click();
  }

  /** Closes by Cancel when there is one, else Close, else Escape. */
  async dismiss(): Promise<'cancel' | 'close' | 'escape'> {
    const dialog = this.root().first();
    for (const [name, how] of [
      ['Cancel', 'cancel'],
      ['Close', 'close'],
    ] as const) {
      const button = dialog.getByRole('button', { name, exact: false });
      if ((await button.count()) > 0 && (await button.first().isVisible())) {
        await this.click(name);
        await this.waitForClosed();
        return how;
      }
    }
    // Escape writes nothing and needs no name, which is why it is the fallback
    // rather than "click the first button in the header".
    await this.page.keyboard.press('Escape');
    await this.waitForClosed();
    return 'escape';
  }
}

/**
 * THE FORM inside a drawer: fields by accessible name, with a label fallback.
 *
 * The fallback is needed BECAUSE of the divergences: a field whose visible label
 * is one string and whose accessible name is another is the normal case here, so a
 * lookup that tried only one of the two would miss roughly two thirds of fields.
 */
export class Form extends Component {
  constructor(
    page: Page,
    private readonly scope: Locator,
  ) {
    super(page);
  }

  /** Every field control in the form, whatever its role. */
  fields(): Locator {
    return this.scope
      .getByRole('textbox')
      .or(this.scope.getByRole('combobox'))
      .or(this.scope.getByRole('spinbutton'))
      .or(this.scope.getByRole('checkbox'));
  }

  async fieldCount(): Promise<number> {
    return this.fields().count();
  }

  /** By accessible name first, then by visible label. */
  field(name: string): Locator {
    return this.scope
      .getByRole('textbox', { name })
      .or(this.scope.getByRole('combobox', { name }))
      .or(this.scope.getByRole('spinbutton', { name }))
      .or(this.scope.getByLabel(name));
  }

  /**
   * Fields marked required, by `aria-required` or a `*` in the label.
   *
   * Both, because the application uses the visual marker and the attribute
   * inconsistently across the captured forms, and a check that trusted one would
   * report "no required fields" for a form full of them.
   */
  async requiredFieldCount(): Promise<number> {
    const byAttribute = await this.scope.locator('[aria-required="true"], [required]').count();
    const byMarker = await this.scope.locator('label:has-text("*")').count();
    return Math.max(byAttribute, byMarker);
  }
}

/**
 * THE STEPPER. Five modules use one, with labels like `Next: Line Items`.
 *
 * Stepping forward reveals the next group of fields and submits nothing, which is
 * why `Next: …` is on the dialog allowlist. The labels appear both with and
 * without a trailing space in the captures, so every comparison is normalised.
 */
export class Stepper extends Component {
  constructor(
    page: Page,
    private readonly scope: Locator,
  ) {
    super(page);
  }

  /** Every forward step control currently on screen. */
  steps(): Locator {
    return this.scope.getByRole('button', { name: /next\s*:/i });
  }

  async stepLabels(): Promise<string[]> {
    const out: string[] = [];
    for (const step of await this.steps().all()) {
      out.push(readableName(await step.innerText().catch(() => '')));
    }
    return out;
  }

  async hasSteps(): Promise<boolean> {
    return (await this.steps().count()) > 0;
  }
}

/** Tabs, by role. Reading a tab's state is free; switching one writes nothing. */
export class Tabs extends Component {
  all(): Locator {
    return this.page.getByRole('tab');
  }

  async labels(): Promise<string[]> {
    const out: string[] = [];
    for (const tab of await this.all().all()) out.push(readableName(await tab.innerText()));
    return out;
  }

  async selected(): Promise<string | null> {
    const current = this.all().and(this.page.locator('[aria-selected="true"]'));
    if ((await current.count()) === 0) return null;
    return readableName(await current.first().innerText());
  }
}

/** Toast / status messages, by role, so a success or error can be read. */
export class Toast extends Component {
  all(): Locator {
    return this.page.getByRole('status').or(this.page.getByRole('alert'));
  }

  async messages(): Promise<string[]> {
    const out: string[] = [];
    for (const toast of await this.all().all()) out.push(readableName(await toast.innerText()));
    return out;
  }
}

/** The top bar: the user menu and logout. Present on every captured state. */
export class TopBar extends Component {
  userMenu(): Locator {
    return this.page.getByRole('button', { name: /open user menu/i });
  }

  async openUserMenu(): Promise<void> {
    const verdict = mayClickOutsideDialog('Open user menu');
    if (!verdict.allowed) throw new Error(verdict.why);
    await this.userMenu().click();
  }

  logout(): Locator {
    return this.page
      .getByRole('menuitem', { name: /log\s*out|sign\s*out/i })
      .or(this.page.getByRole('button', { name: /log\s*out|sign\s*out/i }));
  }
}

/**
 * ONE PAGE OBJECT FOR EVERY MODULE, reached by URL.
 *
 * `entity` is the `/admin/domains/<Entity>` segment — schema, not data, and the
 * same string the smoke manifest is keyed on.
 */
export class ModulePage {
  readonly grid: Grid;
  readonly drawer: Drawer;
  readonly tabs: Tabs;
  readonly toast: Toast;
  readonly topBar: TopBar;

  constructor(
    private readonly page: Page,
    readonly entity: string,
  ) {
    this.grid = new Grid(page);
    this.drawer = new Drawer(page);
    this.tabs = new Tabs(page);
    this.toast = new Toast(page);
    this.topBar = new TopBar(page);
  }

  get path(): string {
    return `/admin/domains/${this.entity}`;
  }

  async open(): Promise<void> {
    await this.page.goto(this.path, { waitUntil: 'domcontentloaded' });
    await this.waitForRendered();
  }

  /**
   * WAITS FOR THE APPLICATION TO RENDER. This is a single-page application.
   *
   * `domcontentloaded` fires when the document is parsed, which for this app is
   * before anything is on screen — the shell arrives first and the view renders
   * afterwards. Every read below uses `count()`, which is a ONE-SHOT check with no
   * auto-waiting: only `expect(locator)` and actions retry. So a component that
   * asked immediately got zero of everything.
   *
   * Measured, not reasoned about: the first full run failed all 28 module pages
   * with "rendered no heading", and a probe that did the same navigation and then
   * waited found 1 heading, 9 rows and 6 headers on the same URL with the same
   * account. The credentials and the routes were never the problem.
   *
   * It waits for ANY of four things, because all four are real outcomes and
   * waiting for only the first would turn the other three into a 30-second timeout
   * with a misleading message:
   *   - a heading   — the page rendered
   *   - a column header — the grid rendered, for a page whose heading is absent
   *   - a password input — the session expired and this is the login screen, which
   *     `ensureSignedIn` handles and which must be reached QUICKLY, not after a
   *     timeout
   *   - the application's own ERROR BOUNDARY — the application has already given
   *     up on this page. Added 2026-11-24 after `TAX-001 Tax create form opens`
   *     spent thirty seconds twice waiting for elements that a crashed page can
   *     never produce, and then reported `element(s) not found`. The verdict and
   *     the reasoning for its precedence are in `app-render.ts`.
   *
   * The boundary is a FAILURE, not a skip: the application breaking on a route is
   * the single most worthwhile thing this suite can find. What changes is that it
   * is named in a second rather than guessed at after thirty.
   */
  async waitForRendered(timeout = 30_000): Promise<void> {
    const heading = this.page.getByRole('heading');
    const columnheader = this.page.getByRole('columnheader');
    const password = this.page.locator('input[type="password"]');
    const boundary = this.page.getByRole('button', { name: APP_ERROR_RELOAD });

    const anything = heading.or(columnheader).or(password).or(boundary);
    await expect(anything.first()).toBeVisible({ timeout });

    const verdict = classifyRender({
      heading: await heading.first().isVisible(),
      columnheader: await columnheader.first().isVisible(),
      password: await password.first().isVisible(),
      errorBoundary: await boundary.first().isVisible(),
    });
    if (verdict.kind === 'app-error') throw new Error(appErrorBoundaryMessage(this.path));
  }

  /**
   * The page's own heading, normalised. `null` when it has none.
   *
   * Callers reach this after `open()`, which has already waited — so a `null` here
   * means the page genuinely has no heading rather than that nobody waited.
   */
  async heading(): Promise<string | null> {
    const heading = this.page.getByRole('heading').first();
    if ((await heading.count()) === 0) return null;
    return readableName(await heading.innerText());
  }

  /**
   * The create TRIGGER on the list page — outside any dialog, by construction.
   *
   * Scoped with `:not(dialog)` reasoning rather than a blunt page-wide lookup: a
   * dialog that is already open contains its own `Create <Entity>` submit button,
   * and a page-wide `getByRole('button', { name: /create/i })` would find THAT.
   * Matching the submit button and clicking it is the single worst thing this
   * suite could do, so the trigger is only ever looked for while no dialog is open.
   */
  createTrigger(): Locator {
    return this.page.getByRole('button', { name: /\b(create|new|add)\b/i });
  }

  /**
   * Opens the create drawer, refusing if a dialog is already open.
   *
   * The refusal is what keeps `createTrigger` honest: with a dialog open, the
   * trigger lookup could resolve to the submit control inside it.
   */
  async openCreate(): Promise<void> {
    if (await this.drawer.isOpen()) {
      throw new Error(
        `refusing to look for a create trigger on ${this.path} while a dialog is already open: ` +
          'the dialog contains its own submit control, and a page-wide lookup would find that ' +
          'instead. Close the dialog first.',
      );
    }
    const trigger = this.createTrigger().first();
    /**
     * WAITS FOR THE TRIGGER, and does NOT swallow the wait failing.
     *
     * This was `innerText().catch(() => '')`, so a trigger that had not rendered
     * yet produced an empty name, which `mayClickOutsideDialog` then refused as
     * "an icon glyph" — a message about accessibility for what is actually a
     * timing problem. A catch that turns a failure into a plausible-looking value
     * is the shape this repo keeps finding: the confident wrong answer.
     */
    await expect(trigger, `no create trigger rendered on ${this.path}`).toBeVisible({
      timeout: 20_000,
    });
    const name = readableName(await trigger.innerText());
    const verdict = mayClickOutsideDialog(name || 'create');
    if (!verdict.allowed) throw new Error(verdict.why);
    await trigger.click();
    await this.drawer.waitForOpen();
  }

  /** The form inside the open drawer. */
  form(): Form {
    return new Form(this.page, this.drawer.root().first());
  }

  /** The stepper inside the open drawer. */
  stepper(): Stepper {
    return new Stepper(this.page, this.drawer.root().first());
  }
}
