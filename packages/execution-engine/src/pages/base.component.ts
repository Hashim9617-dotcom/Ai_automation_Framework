import type { Locator, Page } from '@playwright/test';
import { rootLogger, type LocatorSpec } from '@aitp/shared';
import { SmartLocator, type SmartLocatorOptions } from '../locators/smart-locator';

/**
 * For repeated widgets (grids, modals, nav bars) that appear on many pages.
 * All lookups are scoped to `root`, so the same component class works wherever
 * the widget renders and two instances on one page never collide.
 */
export abstract class BaseComponent {
  protected readonly log = rootLogger.child(this.constructor.name);
  protected readonly smart: SmartLocator;

  constructor(
    protected readonly page: Page,
    protected readonly root: Locator,
    locatorOptions: SmartLocatorOptions = {},
  ) {
    this.smart = new SmartLocator(page, locatorOptions, root);
  }

  protected find(spec: LocatorSpec): Promise<Locator> {
    return this.smart.resolve(spec);
  }

  async isPresent(): Promise<boolean> {
    return this.root.isVisible().catch(() => false);
  }

  async waitUntilVisible(timeout = 15_000): Promise<void> {
    await this.root.waitFor({ state: 'visible', timeout });
  }
}
