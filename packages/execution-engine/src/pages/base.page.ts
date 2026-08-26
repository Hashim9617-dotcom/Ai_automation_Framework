import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { rootLogger, type LocatorSpec } from '@aitp/shared';
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

  /** Resolve a LocatorSpec through the fallback chain. */
  protected find(spec: LocatorSpec): Promise<Locator> {
    return this.smart.resolve(spec);
  }

  protected async click(spec: LocatorSpec): Promise<void> {
    const locator = await this.find(spec);
    await locator.click({ timeout: this.env.timeouts.action });
  }

  protected async type(spec: LocatorSpec, value: string): Promise<void> {
    const locator = await this.find(spec);
    await locator.fill(value, { timeout: this.env.timeouts.action });
  }

  protected async selectOption(spec: LocatorSpec, value: string): Promise<void> {
    const locator = await this.find(spec);
    await locator.selectOption(value, { timeout: this.env.timeouts.action });
  }

  protected async textOf(spec: LocatorSpec): Promise<string> {
    const locator = await this.find(spec);
    return (await locator.innerText()).trim();
  }

  protected async isVisible(spec: LocatorSpec): Promise<boolean> {
    try {
      const locator = await this.find(spec);
      return await locator.isVisible();
    } catch {
      return false;
    }
  }

  async expectVisible(spec: LocatorSpec): Promise<void> {
    const locator = await this.find(spec);
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
