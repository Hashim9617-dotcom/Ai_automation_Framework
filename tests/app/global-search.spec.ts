import { test, expect } from '@aitp/execution-engine';
import { GlobalSearchPage } from './pages/global-search.page';

/**
 * Global Search. Entirely read-only, so it is safe to run on any environment at
 * any time — a good candidate for the every-commit smoke set.
 */
const SAMPLE_QUERY = process.env.DMS_SEARCH_TERM ?? 'pension';

test.describe('Global Search', { tag: ['@regression', '@search'] }, () => {
  test('loads with its controls', { tag: '@smoke' }, async ({ makePage }) => {
    const search = makePage(GlobalSearchPage);
    await search.open();
    await search.expectLoaded();
  });

  test('returns results for a known term', async ({ makePage, log }) => {
    const search = makePage(GlobalSearchPage);
    await search.open();
    await search.search(SAMPLE_QUERY);

    await expect(search.totalChip()).toBeVisible({ timeout: 20_000 });
    const total = await search.reportedTotal();
    log.info('Search results', { query: SAMPLE_QUERY, total });

    expect(total, `"${SAMPLE_QUERY}" should match at least one document`).toBeGreaterThan(0);
  });

  test(
    'the summary count agrees with the rows actually rendered',
    { tag: '@consistency' },
    async ({ makePage, log }) => {
      const search = makePage(GlobalSearchPage);
      await search.open();
      await search.search(SAMPLE_QUERY);
      await expect(search.totalChip()).toBeVisible({ timeout: 20_000 });

      const reported = await search.reportedTotal();
      const rendered = await search.resultCount();
      log.info('Count comparison', { reported, rendered });

      // A mismatch here is the classic pagination-versus-total bug: the chip
      // counts everything, the page shows a slice. Rendered must never exceed
      // reported — that would mean the summary is simply wrong.
      expect(rendered, 'more rows rendered than the app claims exist').toBeLessThanOrEqual(reported);
    },
  );

  test('filters results by file type', async ({ makePage }) => {
    const search = makePage(GlobalSearchPage);
    await search.open();
    await search.search(SAMPLE_QUERY);
    await expect(search.totalChip()).toBeVisible({ timeout: 20_000 });

    await search.filterByType('PDF');
    await expect(search.totalChip()).toBeVisible();

    await search.filterByType('All');
    await expect(search.totalChip()).toBeVisible();
  });

  test('clear resets the search', async ({ makePage }) => {
    const search = makePage(GlobalSearchPage);
    await search.open();
    await search.search(SAMPLE_QUERY);
    await expect(search.totalChip()).toBeVisible({ timeout: 20_000 });

    await search.clear();
    await expect
      .poll(() => search.resultCount(), { message: 'clear should empty the result list' })
      .toBe(0);
  });

  test('selecting all results enables the bulk download', async ({ makePage }) => {
    const search = makePage(GlobalSearchPage);
    await search.open();
    await search.search(SAMPLE_QUERY);
    await expect(search.totalChip()).toBeVisible({ timeout: 20_000 });

    await search.selectAll();
    // Deliberately no download: we assert the affordance appears, and stop there.
    //
    // This used to assert rowAction('Download File') — an index-based,
    // single-row accessor (`.nth(0)`, so its own count can only ever be 0 or
    // 1) — had a count equal to resultCount() (28). That comparison could
    // never pass regardless of what the app does. Checked live: selecting
    // all results shows a single consolidated "Download Selected (N)"
    // button, which is what the page object's `downloadSelected` locator and
    // `downloadSelectedResults()` action already existed for.
    await expect(await search.downloadSelectedButton()).toBeVisible();
  });
});
