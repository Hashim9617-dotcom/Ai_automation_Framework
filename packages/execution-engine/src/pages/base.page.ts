import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { LocatorResolutionError, rootLogger, type LocatorSpec } from '@aitp/shared';
import type { EnvironmentConfig } from '../config/schema';
import { SmartLocator, type SmartLocatorOptions } from '../locators/smart-locator';

/**
 * Every page object extends this. It owns the plumbing (navigation, locator
 * resolution, waits, screenshots) so concrete pages contain only business
 * vocabulary — which is also what makes them readable to the AI layer later.
 */
export abstract class BasePage {
  protected readonly log = rootLogger.child(this.constructor.name);
  protected readonly smart: SmartLocator;

  /** Path appended to env.baseUrl by `open()`. Override in the concrete page. */
  protected abstract readonly path: string;

  constructor(
    protected readonly page: Page,
    protected readonly env: EnvironmentConfig,
    locatorOptions: SmartLocatorOptions = {},
  ) {
    this.smart = new SmartLocator(page, locatorOptions);
  }

  async open(query: Record<string, string> = {}): Promise<Response | null> {
    const url = new URL(this.path, this.env.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    this.log.info('Opening page', { url: url.toString() });
    return this.page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: this.env.timeouts.navigation,
    });
  }

  /** Resolve a LocatorSpec through the fallback chain — one attempt, no retry. */
  protected find(spec: LocatorSpec): Promise<Locator> {
    return this.smart.resolve(spec);
  }

  /**
   * `find()` (`SmartLocator.resolve`) throws hard after one `candidateTimeout`
   * window (2s by default) per candidate — a budget sized for steady-state
   * resolution, not a page's very first render. Under real concurrency (e.g.
   * four workers all opening a page the instant a shared auth session becomes
   * available), that single window can come up short even though the element
   * would attach fine a moment later — confirmed live, through two different
   * call paths: `expectShellVisible` hit it on `nav.fileExplorer`, and
   * `expandNavSection`'s `click()` hit it on `nav.upload`, both only at the
   * very start of a run, both always recovering on the framework's own
   * test-level retry, with telemetry showing sub-100ms resolution once
   * contention eases. That is a "not yet rendered" case, not "never going to
   * be there," so every action helper below resolves through this retrying
   * wrapper instead of a single `candidateTimeout` window being final for
   * whichever one happens to run first.
   *
   * Retries by calling `this.find(spec)` — not `this.smart.resolve()`
   * directly — so `AppPage.find`'s override re-runs its sign-in check on
   * every attempt, not just the first. That matters: without it, a session
   * that expires mid-retry would keep silently retrying a doomed resolution
   * for the full budget before failing as a generic `LocatorResolutionError`,
   * instead of failing fast as the distinct `SessionExpiredError` Finding 3
   * exists to produce. Only `LocatorResolutionError` is retried here for
   * exactly that reason — `SessionExpiredError` must propagate immediately.
   */
  private async resolveWithGrace(spec: LocatorSpec): Promise<Locator> {
    const deadline = Date.now() + this.env.timeouts.expect;
    for (;;) {
      try {
        return await this.find(spec);
      } catch (err) {
        if (!(err instanceof LocatorResolutionError) || Date.now() >= deadline) throw err;
        await this.page.waitForTimeout(200);
      }
    }
  }

  protected async click(spec: LocatorSpec): Promise<void> {
    const locator = await this.resolveWithGrace(spec);
    await locator.click({ timeout: this.env.timeouts.action });
  }

  protected async type(spec: LocatorSpec, value: string): Promise<void> {
    const locator = await this.resolveWithGrace(spec);
    await locator.fill(value, { timeout: this.env.timeouts.action });
  }

  protected async selectOption(spec: LocatorSpec, value: string): Promise<void> {
    const locator = await this.resolveWithGrace(spec);
    await locator.selectOption(value, { timeout: this.env.timeouts.action });
  }

  protected async textOf(spec: LocatorSpec): Promise<string> {
    const locator = await this.resolveWithGrace(spec);
    return (await locator.innerText()).trim();
  }

  protected async isVisible(spec: LocatorSpec): Promise<boolean> {
    try {
      const locator = await this.resolveWithGrace(spec);
      return await locator.isVisible();
    } catch {
      return false;
    }
  }

  async expectVisible(spec: LocatorSpec): Promise<void> {
    // Two independent `env.timeouts.expect` budgets, not one split between
    // them — resolution and visibility are different waits (attached vs.
    // actually visible), and splitting one budget across both risks the
    // visibility check starving to near-zero if resolution needed retries.
    const locator = await this.resolveWithGrace(spec);
    await expect(locator).toBeVisible({ timeout: this.env.timeouts.expect });
  }

  /** Network-quiet wait that tolerates long-polling apps better than networkidle alone. */
  async waitForStable(timeout = this.env.timeouts.navigation): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout });
    await this.page
      .waitForLoadState('networkidle', { timeout: Math.min(timeout, 10_000) })
      .catch(() => this.log.debug('networkidle not reached; continuing'));
  }

  async screenshot(name: string): Promise<Buffer> {
    return this.page.screenshot({ fullPage: true, path: undefined, caret: 'hide' }).then((buf) => {
      this.log.debug('Captured screenshot', { name });
      return buf;
    });
  }
}
