import type { Locator } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AppPage } from './app.page';

export type SearchFileType = 'All' | 'PDF' | 'Word' | 'Excel' | 'PPT' | 'Image';

/**
 * Global Search — search across every document, with type filters, a date range
 * and per-result actions.
 *
 * Result rows have no stable id, but each carries a checkbox named
 * "Select <document name>", which is the most reliable handle the app offers.
 */
export class GlobalSearchPage extends AppPage {
  protected readonly path = '/search';

  private readonly query = locator('search.query', 'Search query box', [
    { strategy: 'placeholder', value: 'Search across all documents', confidence: 1 },
    // Confirmed live: this is an `<input type="search">`, whose implicit ARIA
    // role is `searchbox`, not `textbox` — `role: 'textbox'` matched zero
    // elements on this page and could never have worked.
    { strategy: 'role', value: 'searchbox', options: {} },
  ]);

  private readonly matchType = locator('search.matchType', 'Match type dropdown', [
    { strategy: 'role', value: 'combobox', options: { name: 'Match type' }, confidence: 1 },
  ]);

  private readonly operator = locator('search.operator', 'Operator dropdown', [
    { strategy: 'role', value: 'combobox', options: { name: 'Operator' }, confidence: 1 },
  ]);

  private readonly searchButton = locator('search.submit', 'Search button', [
    { strategy: 'role', value: 'button', options: { name: 'Search', exact: true }, confidence: 1 },
  ]);

  private readonly clearButton = locator('search.clear', 'Clear button', [
    { strategy: 'role', value: 'button', options: { name: 'Clear', exact: true }, confidence: 1 },
  ]);

  private readonly selectAllResults = locator('search.selectAll', 'Select all results', [
    { strategy: 'role', value: 'checkbox', options: { name: 'Select all results' }, confidence: 1 },
  ]);

  private readonly downloadSelected = locator('search.downloadSelected', 'Download Selected', [
    { strategy: 'role', value: 'button', options: { name: 'Download Selected' }, confidence: 1 },
  ]);

  async expectLoaded(): Promise<void> {
    await this.expectShellVisible();
    await this.expectVisible(this.query);
    await this.expectVisible(this.searchButton);
  }

  async search(text: string): Promise<void> {
    this.log.info('Searching documents', { query: text });
    await this.type(this.query, text);
    await this.click(this.searchButton);
  }

  async clear(): Promise<void> {
    await this.click(this.clearButton);
  }

  async setMatchType(value: string): Promise<void> {
    await this.selectOption(this.matchType, value);
  }

  async setOperator(value: string): Promise<void> {
    await this.selectOption(this.operator, value);
  }

  async filterByType(type: SearchFileType): Promise<void> {
    await this.page.getByRole('button', { name: type, exact: true }).click();
  }

  async sortBy(field: 'Created' | 'Updated'): Promise<void> {
    await this.page.getByRole('button', { name: field, exact: true }).click();
  }

  // ── Results ───────────────────────────────────────────────────────────────
  /** One result row, addressed through its "Select <name>" checkbox. */
  resultCheckbox(documentName: string): Locator {
    return this.page.getByRole('checkbox', { name: `Select ${documentName}` }).first();
  }

  resultCheckboxes(): Locator {
    // Every result has one; "Select all results" is excluded by the name filter.
    return this.page.getByRole('checkbox', { name: /^Select (?!all results).+/ });
  }

  async resultCount(): Promise<number> {
    return this.resultCheckboxes().count();
  }

  async selectResult(documentName: string): Promise<void> {
    await this.resultCheckbox(documentName).check();
  }

  async selectAll(): Promise<void> {
    await this.click(this.selectAllResults);
  }

  async downloadSelectedResults(): Promise<void> {
    await this.click(this.downloadSelected);
  }

  downloadSelectedButton(): Promise<Locator> {
    return this.find(this.downloadSelected);
  }

  /**
   * The result-count chips ("28 total", "14 PDF") are the app's own summary —
   * asserting against them is far more meaningful than counting DOM rows.
   */
  totalChip(): Locator {
    return this.page.getByRole('button', { name: /\d+\s+total/i });
  }

  typeChip(type: string): Locator {
    return this.page.getByRole('button', { name: new RegExp(`\\d+\\s+${type}`, 'i') });
  }

  async reportedTotal(): Promise<number> {
    const text = await this.totalChip().innerText();
    return Number(text.match(/\d+/)?.[0] ?? 0);
  }

  /** Per-result actions. Index-based because the rows expose no unique names. */
  rowAction(
    action: 'Go to Location' | 'View Metadata' | 'Advanced PDF View' | 'Download File',
    index = 0,
  ): Locator {
    return this.page.getByRole('button', { name: action, exact: true }).nth(index);
  }
}
