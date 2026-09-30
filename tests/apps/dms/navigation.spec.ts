import { test, expect } from '@aitp/execution-engine';
import { DashboardPage } from './pages/dashboard.page';
import { FileExplorerPage } from './pages/file-explorer.page';
import { GlobalSearchPage } from './pages/global-search.page';

/**
 * Every primary destination loads and keeps the shell intact.
 *
 * Cheap, fast, and it catches the failure that matters most in a document
 * system: a route that 404s or drops you back at the login page after a deploy.
 */
test.describe('Navigation', { tag: ['@smoke', '@navigation'] }, () => {
  test('the sidebar reaches every primary destination', async ({ makePage, page }) => {
    const dashboard = makePage(DashboardPage);
    await dashboard.open();
    await dashboard.expectLoaded();

    await dashboard.goToFileExplorer();
    await expect(page).toHaveURL(/\/files/);

    await dashboard.goToGlobalSearch();
    await expect(page).toHaveURL(/\/search/);

    await dashboard.goToDocuments();
    await expect(page).not.toHaveURL(/\/login/);

    await dashboard.goToAuditReport();
    await expect(page).not.toHaveURL(/\/login/);

    await dashboard.goToDashboard();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('the Upload section reveals both upload routes', async ({ makePage, page }) => {
    const dashboard = makePage(DashboardPage);
    await dashboard.open();

    await dashboard.expandNavSection('Upload');
    await expect(dashboard.navLink('Upload Files')).toBeVisible();
    await expect(dashboard.navLink('Bulk Upload')).toBeVisible();

    await dashboard.navLink('Upload Files').click();
    await expect(page).toHaveURL(/\/upload-files/);
  });

  test('the Admin section reveals the administration routes', async ({ makePage }) => {
    const dashboard = makePage(DashboardPage);
    await dashboard.open();

    await dashboard.expandNavSection('Admin');

    for (const link of ['User', 'User Role', 'User Group', 'Document Types']) {
      await expect(dashboard.navLink(link), `${link} should appear under Admin`).toBeVisible();
    }
  });

  test('the top bar controls are present on an inner page', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.expectLoaded();

    // Opening these must not navigate away or sign us out.
    await explorer.openNotifications();
    await explorer.dismissMenu();
    expect(await explorer.isSignedOut()).toBe(false);
  });

  test('theme toggle does not break the page', async ({ makePage }) => {
    const search = makePage(GlobalSearchPage);
    await search.open();
    await search.expectLoaded();

    await search.toggleTheme();
    await search.expectLoaded();

    await search.toggleTheme();
    await search.expectLoaded();
  });
});
