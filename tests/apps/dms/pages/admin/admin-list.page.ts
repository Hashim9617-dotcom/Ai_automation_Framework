import type { Locator } from '@playwright/test';
import { locator, type LocatorSpec } from '@aitp/shared';
import { AppPage } from '../app.page';

/**
 * Every Admin screen — Users, User Roles, User Groups — is the same list:
 * Refresh / New … / Export above a searchable, filterable, paginated table.
 *
 * Modelled once here. Each concrete page supplies only what differs: its route,
 * its search placeholder, its "New …" label and its create form.
 */
export abstract class AdminListPage extends AppPage {
  /** e.g. "Search users..." — the placeholder is the only handle these boxes have. */
  protected abstract readonly searchPlaceholder: string;
  /** e.g. "New User". */
  protected abstract readonly newButtonLabel: string;

  private readonly refresh = locator('admin.refresh', 'Refresh button', [
    { strategy: 'role', value: 'button', options: { name: 'Refresh', exact: true }, confidence: 1 },
  ]);

  private readonly exportButton = locator('admin.export', 'Export button', [
    { strategy: 'role', value: 'button', options: { name: 'Export', exact: true }, confidence: 1 },
  ]);

  private readonly statusFilter = locator('admin.statusFilter', 'Filter by status dropdown', [
    { strategy: 'role', value: 'combobox', options: { name: 'Filter by status' }, confidence: 1 },
  ]);

  protected get searchBox(): LocatorSpec {
    return locator('admin.search', `Search box (${this.searchPlaceholder})`, [
      { strategy: 'placeholder', value: this.searchPlaceholder, confidence: 1 },
    ]);
  }

  protected get newButton(): LocatorSpec {
    return locator('admin.new', `${this.newButtonLabel} button`, [
      {
        strategy: 'role',
        value: 'button',
        options: { name: this.newButtonLabel, exact: true },
        confidence: 1,
      },
    ]);
  }

  async expectLoaded(): Promise<void> {
    await this.expectShellVisible();
    await this.expectVisible(this.newButton);
    await this.expectVisible(this.searchBox);
  }

  async search(text: string): Promise<void> {
    await this.type(this.searchBox, text);
  }

  async refreshList(): Promise<void> {
    await this.click(this.refresh);
  }

  async exportList(): Promise<void> {
    await this.click(this.exportButton);
  }

  async filterByStatus(status: string): Promise<void> {
    await this.selectOption(this.statusFilter, status);
  }

  async openCreateForm(): Promise<void> {
    await this.click(this.newButton);
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  pageButton(pageNumber: number): Locator {
    return this.page.getByRole('button', { name: String(pageNumber), exact: true });
  }

  async goToPage(pageNumber: number): Promise<void> {
    await this.pageButton(pageNumber).click();
  }

  /** How many numbered pages the list currently offers. */
  async pageCount(): Promise<number> {
    const numbered = this.page.getByRole('button', { name: /^\d+$/ });
    return numbered.count();
  }

  // ── Shared create-form controls ───────────────────────────────────────────
  protected readonly activeToggle = locator('admin.form.active', 'Active toggle', [
    { strategy: 'role', value: 'button', options: { name: 'Active', exact: true }, confidence: 1 },
  ]);

  protected readonly clearForm = locator('admin.form.clear', 'Clear button', [
    { strategy: 'role', value: 'button', options: { name: 'Clear', exact: true }, confidence: 1 },
  ]);

  protected readonly portalPicker = locator('admin.form.portal', 'Select portal dropdown', [
    { strategy: 'role', value: 'button', options: { name: 'Select portal' }, confidence: 1 },
  ]);

  async toggleActive(): Promise<void> {
    await this.click(this.activeToggle);
  }

  async clearFormFields(): Promise<void> {
    await this.click(this.clearForm);
  }

  async selectPortal(): Promise<void> {
    await this.click(this.portalPicker);
  }
}
