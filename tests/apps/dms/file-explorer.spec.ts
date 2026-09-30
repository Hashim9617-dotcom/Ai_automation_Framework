import { test, expect } from '@aitp/execution-engine';
import { FileExplorerPage } from './pages/file-explorer.page';

/**
 * File Explorer.
 *
 * Everything here is read-only except the last block, which is gated behind
 * ALLOW_WRITES so a normal run never creates data in your QA environment:
 *
 *   $env:ALLOW_WRITES="true"; pnpm.cmd test --grep @write
 */
const ALLOW_WRITES = process.env.ALLOW_WRITES === 'true';

/** A workspace that exists on this instance and has nested folders. */
const SAMPLE_WORKSPACE = process.env.DMS_SAMPLE_WORKSPACE ?? 'ABCD';

test.describe('File Explorer', { tag: ['@regression', '@files'] }, () => {
  test('loads the workspace tree', { tag: '@smoke' }, async ({ makePage, log }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.expectLoaded();

    const count = await explorer.workspaceCount();
    log.info('Workspaces visible', { count });
    expect(count, 'the tree should list at least one workspace').toBeGreaterThan(0);
  });

  test('filters the workspace list', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.expectLoaded();

    const before = await explorer.workspaceCount();
    await explorer.filterWorkspaces(SAMPLE_WORKSPACE);

    await expect
      .poll(() => explorer.workspaceCount(), { message: 'filter should narrow the tree' })
      .toBeLessThanOrEqual(before);

    await expect(explorer.treeNode(SAMPLE_WORKSPACE)).toBeVisible();
  });

  test('opens a workspace and shows its contents', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.openWorkspace(SAMPLE_WORKSPACE);

    // The contents pane offers its own search and a way to add a folder.
    await expect(explorer.newFolderTile()).toBeVisible();
  });

  test(
    'destructive bulk actions stay disabled with nothing selected',
    { tag: '@safety' },
    async ({ makePage }) => {
      const explorer = makePage(FileExplorerPage);
      await explorer.open();
      await explorer.openWorkspace(SAMPLE_WORKSPACE);

      await explorer.expectFileActionsVisible();
      // Cut / Copy / Paste / Delete / Archive must all be unavailable until the
      // user has actually selected something. This is a real safety property.
      await explorer.expectBulkActionsDisabled();
    },
  );

  test('switches between grid and details views', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.openWorkspace(SAMPLE_WORKSPACE);

    await explorer.switchView('Details view');
    await explorer.expectFileActionsVisible();

    await explorer.switchView('Grid view');
    await explorer.expectFileActionsVisible();
  });

  test('switches between Current, Archive and Bin', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.openWorkspace(SAMPLE_WORKSPACE);

    for (const scope of ['Archive', 'Bin', 'Current'] as const) {
      await explorer.switchScope(scope);
      await explorer.expectLoaded();
    }
  });
});

test.describe('File Explorer context menus', { tag: ['@regression', '@files'] }, () => {
  test('a workspace menu offers its documented actions', async ({ makePage, log }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.expectLoaded();

    await explorer.openTreeNodeMenu(SAMPLE_WORKSPACE);
    await expect(explorer.menu()).toBeVisible();

    const items = await explorer.menuItemNames();
    log.info('Workspace menu', { items });

    // Losing any of these silently is a real regression — a user can no longer
    // share or edit a workspace, and nothing else in the UI would tell you.
    for (const action of ['Star', 'Edit', 'Download', 'Share', 'Delete']) {
      await expect(explorer.menuItem(action), `${action} should be offered`).toBeVisible();
    }

    // Permissions section.
    await expect(explorer.menuItem('View')).toBeVisible();
    await expect(explorer.menuItem('Manage')).toBeVisible();

    await explorer.dismissMenu();
    await expect(explorer.menu()).toBeHidden();
  });

  test('a folder menu offers folder-specific actions', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.expandTreeNode(SAMPLE_WORKSPACE);
    await explorer.openWorkspace(SAMPLE_WORKSPACE);

    const folder = process.env.DMS_SAMPLE_FOLDER ?? 'auto Test 123';
    await explorer.openTileMenu(folder);
    await expect(explorer.menu()).toBeVisible();

    // "Upload Zip File" is unique to folders — a good marker that we opened the
    // folder menu and not the workspace one.
    await expect(explorer.menuItem('Upload Zip File')).toBeVisible();
    await expect(explorer.menuItem('View details')).toBeVisible();

    await explorer.dismissMenu();
  });
});

test.describe('Create workspace', { tag: ['@regression', '@files'] }, () => {
  test('the dialog opens with a derived, read-only code', async ({ makePage }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.openCreateWorkspace();
    await explorer.expectCreateDialogOpen();

    // The code is generated from the name, so it must not be typeable.
    await expect(await explorer.workspaceCodeField()).toBeDisabled();

    await explorer.cancelDialog();
  });

  test('cancelling leaves the tree untouched', async ({ makePage, data }) => {
    const explorer = makePage(FileExplorerPage);
    await explorer.open();
    await explorer.expectLoaded();

    // Not an exact `workspaceCount()` comparison — confirmed live that this
    // is a shared environment: the tree's total count drifted (24 -> 25)
    // mid-test with ALLOW_WRITES off and no write test running, so someone
    // else's concurrent workspace change can move the total in either
    // direction independent of anything this test does. A count assertion
    // therefore chases a moving target that has nothing to do with whether
    // Cancel worked. What Cancel actually promises — the one thing this
    // test can assert without racing live data — is that the specific
    // workspace we were about to create does not exist.
    const name = data.unique('cancelled-ws');
    await explorer.openCreateWorkspace();
    await explorer.fillWorkspaceName(name);
    await explorer.cancelDialog();

    await expect(explorer.treeNode(name)).not.toBeVisible();
  });

  test('creates a workspace', { tag: '@write' }, async ({ makePage, data, log }) => {
    test.skip(!ALLOW_WRITES, 'Set ALLOW_WRITES=true to run tests that create data.');

    const explorer = makePage(FileExplorerPage);
    const name = data.unique('aitp-ws');

    await explorer.open();
    await explorer.openCreateWorkspace();
    await explorer.fillWorkspaceName(name);
    await explorer.submitCreateWorkspace();

    log.info('Created workspace', { name });
    await expect(explorer.treeNode(name)).toBeVisible({ timeout: 15_000 });
  });
});
