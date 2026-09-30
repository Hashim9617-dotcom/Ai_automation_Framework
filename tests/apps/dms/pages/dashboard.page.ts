import type { Locator } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AppPage } from './app.page';

/**
 * Landing page after sign-in. Recent documents are rendered as buttons whose
 * accessible name concatenates type, title, filename and timestamp — so they are
 * matched on a substring (the document title), never on the whole string.
 */
export class DashboardPage extends AppPage {
  protected readonly path = '/dashboard';

  private readonly refresh = locator('dashboard.refresh', 'Refresh button', [
    { strategy: 'role', value: 'button', options: { name: 'Refresh', exact: true }, confidence: 1 },
  ]);

  async refreshData(): Promise<void> {
    await this.click(this.refresh);
  }

  /** "View All →" / "View all →" — the app uses both spellings. */
  viewAllLinks(): Locator {
    return this.page.getByRole('button', { name: /view all/i });
  }

  /** A recent-document tile, matched by the document title inside its long name. */
  recentDocument(title: string): Locator {
    return this.page.getByRole('button', { name: title }).first();
  }

  /** Every recent document exposes its own "Go to location" button. */
  goToLocationButtons(): Locator {
    return this.page.getByRole('button', { name: 'Go to location' });
  }

  async openRecentDocumentLocation(title: string): Promise<void> {
    const tile = this.recentDocument(title);
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
  }

  async expectLoaded(): Promise<void> {
    await this.expectShellVisible();
    await this.expectVisible(this.refresh);
  }
}
