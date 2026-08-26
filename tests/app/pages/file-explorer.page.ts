import { expect, type Locator } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AppPage } from './app.page';

export type ExplorerScope = 'Current' | 'Archive' | 'Bin';
export type ExplorerView = 'Grid view' | 'Details view';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * File Explorer — the heart of the product.
 *
 * Three regions, and they are located differently on purpose:
 *
 *  - **Workspace tree** (left): real ARIA `tree` / `treeitem` roles. Workspaces
 *    and their nested folders are all `treeitem`s, so one accessor covers both.
 *  - **Contents grid** (right): folders and documents render as buttons named
 *    after themselves.
 *  - **Context menus**: real `menu` / `menuitem` roles, so menu actions are
 *    matched by role and never by position.
 *
 * Nothing here hardcodes a workspace or folder name — those are *data*. One
 * `openWorkspace(name)` covers all 25 workspaces on this instance.
 */
export class FileExplorerPage extends AppPage {
  protected readonly path = '/files';

  // ── Search ────────────────────────────────────────────────────────────────
  private readonly workspaceFilter = locator('files.workspaceFilter', 'Workspace filter box', [
    { strategy: 'role', value: 'textbox', options: { name: 'Filter workspaces' }, confidence: 1 },
    { strategy: 'placeholder', value: 'Search workspaces' },
  ]);

  /**
   * The right-hand search box renames itself: "Search folders…" at workspace
   * level, "Search files…" once you are inside a folder. Both candidates are
   * listed, so the same accessor works at either level — and the telemetry tells
   * us which one matched.
   */
  private readonly contentSearch = locator('files.contentSearch', 'Folder/file search box', [
    { strategy: 'role', value: 'textbox', options: { name: 'Search folders' }, confidence: 1 },
    { strategy: 'role', value: 'textbox', options: { name: 'Search files' }, confidence: 1 },
    { strategy: 'placeholder', value: 'Search folders' },
    { strategy: 'placeholder', value: 'Search files' },
  ]);

  // ── Primary actions ───────────────────────────────────────────────────────
  private readonly newWorkspaceButton = locator('files.newWorkspace', 'New workspace button', [
    {
      strategy: 'role',
      value: 'button',
      options: { name: 'New workspace', exact: true },
      confidence: 1,
    },
  ]);

  private readonly newFolderButton = locator('files.newFolder', 'New folder button (toolbar)', [
    {
      strategy: 'role',
      value: 'button',
      options: { name: 'New folder', exact: true },
      confidence: 1,
    },
  ]);

  private readonly createDocumentButton = locator('files.createDocument', 'Create Document button', [
    { strategy: 'role', value: 'button', options: { name: 'Create Document' }, confidence: 1 },
  ]);

  private readonly workspaceTree = locator('files.tree', 'Workspaces tree', [
    { strategy: 'role', value: 'tree', options: { name: 'Workspaces' }, confidence: 1 },
  ]);

  private readonly fileActions = locator('files.toolbar', 'File actions toolbar', [
    { strategy: 'role', value: 'toolbar', options: { name: 'File actions' }, confidence: 1 },
  ]);

  private readonly selectAllFolders = locator('files.selectAllFolders', 'Select all folders', [
    { strategy: 'role', value: 'checkbox', options: { name: 'Select all folders' }, confidence: 1 },
  ]);

  private readonly selectAllDocuments = locator('files.selectAllDocs', 'Select all documents', [
    {
      strategy: 'role',
      value: 'checkbox',
      options: { name: 'Select all documents' },
      confidence: 1,
    },
  ]);

  // ── Create-workspace dialog ───────────────────────────────────────────────
  private readonly workspaceName = locator('files.dialog.name', 'Workspace name field', [
    { strategy: 'placeholder', value: 'e.g. Finance Documents', confidence: 1 },
  ]);

  private readonly workspaceCode = locator('files.dialog.code', 'Workspace code field', [
    { strategy: 'placeholder', value: 'workspace_code', confidence: 1 },
  ]);

  private readonly documentTypesPicker = locator('files.dialog.docTypes', 'Document types picker', [
    { strategy: 'role', value: 'button', options: { name: 'Select document types' }, confidence: 1 },
  ]);

  private readonly dialogCreate = locator('files.dialog.create', 'Create button in the dialog', [
    // Same PUA icon-glyph issue as the admin create-form submit buttons —
    // real accessible name is " Create" (confirmed via the CDP accessibility
    // tree: a Private Use Area icon-font glyph precedes the label). Exact
    // match against "Create" is not stale, it is impossible, so it has been
    // removed rather than kept as a demoted (permanently dead) candidate —
    // a candidate that can never match only costs a full
    // LOCATOR_CANDIDATE_TIMEOUT on every resolution for no benefit. See
    // UsersPage.submit for the full story.
    { strategy: 'role', value: 'button', options: { name: 'Create' }, confidence: 0.8 },
    // \b, not ^...$: \s does not match the PUA glyph, so an anchor expecting
    // `^\s*` to absorb it never does. \bCreate\b matches this button but not
    // "Create Document" (a different, unrelated toolbar control) — confirmed
    // live, no collision today.
    { strategy: 'role', value: 'button', options: { name: /\bCreate\b/i }, confidence: 0.6 },
  ]);

  private readonly dialogCancel = locator('files.dialog.cancel', 'Cancel button in the dialog', [
    { strategy: 'role', value: 'button', options: { name: 'Cancel', exact: true }, confidence: 1 },
  ]);

  // ── Loading ───────────────────────────────────────────────────────────────
  async expectLoaded(): Promise<void> {
    await this.expectShellVisible();
    await this.expectVisible(this.workspaceTree);
  }

  // ── Search ────────────────────────────────────────────────────────────────
  async filterWorkspaces(text: string): Promise<void> {
    await this.type(this.workspaceFilter, text);
  }

  async searchContents(text: string): Promise<void> {
    await this.type(this.contentSearch, text);
  }

  // ── Workspace tree ────────────────────────────────────────────────────────
  /**
   * A workspace or a nested folder — both are `treeitem`s in this app.
   *
   * Not `{ name, exact: true }` — confirmed live via CDP that a treeitem's
   * computed accessible name is not its visible label alone. ARIA computes
   * name-from-content by concatenating every descendant's own accessible
   * name, and each row nests an "Expand"/"Collapse" chevron and a "More
   * options" button, so "ABCD" is really named "Collapse ABCD More options"
   * (expanded) or "Expand ABCD More options" (collapsed) — exact match
   * against the plain label can never match, for any row, regardless of
   * timing. The chevron prefix is optional in the pattern below because a
   * leaf row with nothing to expand may omit it. Anchored on both ends so
   * "test" cannot match "Expand test 123 More options" — a plain substring
   * or `\b`-bounded match would, since "test" is itself a whole word inside
   * that longer name.
   */
  treeNode(name: string): Locator {
    const pattern = new RegExp(
      `^(?:(?:Expand|Collapse)\\s+)?${escapeRegExp(name)}\\s+More options\\s*$`,
    );
    return this.page.getByRole('treeitem', { name: pattern });
  }

  async openWorkspace(name: string): Promise<void> {
    this.log.info('Opening workspace', { workspace: name });
    await this.treeNode(name).click();
  }

  /**
   * Expand/collapse chevrons carry no per-item name — they are all just
   * "Expand"/"Collapse" — so they must be scoped inside their own tree node.
   * Matching them globally would click a random workspace's chevron.
   */
  async expandTreeNode(name: string): Promise<void> {
    const node = this.treeNode(name);
    const chevron = node.getByRole('button', { name: 'Expand' });
    if ((await chevron.count()) > 0) await chevron.first().click();
  }

  async collapseTreeNode(name: string): Promise<void> {
    const node = this.treeNode(name);
    const chevron = node.getByRole('button', { name: 'Collapse' });
    if ((await chevron.count()) > 0) await chevron.first().click();
  }

  async workspaceCount(): Promise<number> {
    return this.page.getByRole('treeitem').count();
  }

  // ── Contents grid ─────────────────────────────────────────────────────────
  /** A folder or document tile in the right-hand pane. */
  contentTile(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  async openFolder(name: string): Promise<void> {
    this.log.info('Opening folder', { folder: name });
    await this.contentTile(name).click();
  }

  /** The "+ New folder" tile inside the grid, distinct from the toolbar button. */
  newFolderTile(): Locator {
    return this.page.getByRole('button', { name: /new folder/i }).last();
  }

  // ── Context menus ─────────────────────────────────────────────────────────
  /**
   * Opens the ⋯ menu belonging to one item. The trigger is scoped to the item's
   * own row — every row has a "More options" button with the same name, so an
   * unscoped match would open the wrong menu.
   */
  async openTreeNodeMenu(name: string): Promise<void> {
    const node = this.treeNode(name);
    await node.hover();
    await node.getByRole('button', { name: 'More options' }).first().click();
  }

  async openTileMenu(name: string): Promise<void> {
    const tile = this.contentTile(name);
    await tile.hover();
    const trigger = tile.getByRole('button', { name: 'More options' });
    // Some layouts render the trigger as a sibling of the tile rather than a child.
    if ((await trigger.count()) > 0) {
      await trigger.first().click();
      return;
    }
    await this.page.getByRole('button', { name: 'More options' }).last().click();
  }

  menu(): Locator {
    return this.page.getByRole('menu');
  }

  menuItem(name: string): Locator {
    return this.page.getByRole('menuitem', { name, exact: true });
  }

  async chooseMenuItem(name: string): Promise<void> {
    await this.menuItem(name).click();
  }

  /** Closes an open menu without triggering any of its actions. */
  async dismissMenu(): Promise<void> {
    await this.page.keyboard.press('Escape');
  }

  async menuItemNames(): Promise<string[]> {
    const items = await this.page.getByRole('menuitem').all();
    const names = await Promise.all(items.map((item) => item.innerText()));
    return names.map((name) => name.trim()).filter(Boolean);
  }

  // ── View and scope switches ───────────────────────────────────────────────
  async switchView(view: ExplorerView): Promise<void> {
    await this.page.getByRole('button', { name: view, exact: true }).click();
  }

  async switchScope(scope: ExplorerScope): Promise<void> {
    // "Archive" is both a scope tab and a toolbar action; the scope tabs sit
    // together, so take the first match in document order.
    await this.page.getByRole('button', { name: scope, exact: true }).first().click();
  }

  // ── Selection and bulk actions ────────────────────────────────────────────
  async selectAllFolderRows(): Promise<void> {
    await this.click(this.selectAllFolders);
  }

  async selectAllDocumentRows(): Promise<void> {
    await this.click(this.selectAllDocuments);
  }

  /** A button inside the File actions toolbar: Archive, Cut, Copy, Paste, Delete. */
  toolbarAction(name: 'Archive' | 'Cut' | 'Copy' | 'Paste' | 'Delete'): Locator {
    return this.page
      .getByRole('toolbar', { name: 'File actions' })
      .getByRole('button', { name, exact: true });
  }

  /**
   * With nothing selected, every destructive action must be disabled. This is a
   * genuine safety property of the UI and worth asserting on every run.
   */
  async expectBulkActionsDisabled(): Promise<void> {
    for (const action of ['Archive', 'Cut', 'Copy', 'Paste', 'Delete'] as const) {
      await expect(this.toolbarAction(action), `${action} should be disabled`).toBeDisabled();
    }
  }

  async expectFileActionsVisible(): Promise<void> {
    await this.expectVisible(this.fileActions);
  }

  // ── Create workspace ──────────────────────────────────────────────────────
  async openCreateWorkspace(): Promise<void> {
    await this.click(this.newWorkspaceButton);
  }

  async fillWorkspaceName(name: string): Promise<void> {
    await this.type(this.workspaceName, name);
  }

  /** The code field derives from the name — it is disabled by design. */
  workspaceCodeField(): Promise<Locator> {
    return this.find(this.workspaceCode);
  }

  async openDocumentTypes(): Promise<void> {
    await this.click(this.documentTypesPicker);
  }

  async submitCreateWorkspace(): Promise<void> {
    await this.click(this.dialogCreate);
  }

  async cancelDialog(): Promise<void> {
    await this.click(this.dialogCancel);
  }

  async expectCreateDialogOpen(): Promise<void> {
    await this.expectVisible(this.workspaceName);
    await this.expectVisible(this.dialogCreate);
  }

  // ── Folder / document creation entry points ───────────────────────────────
  async openNewFolder(): Promise<void> {
    await this.click(this.newFolderButton);
  }

  async openCreateDocument(): Promise<void> {
    await this.click(this.createDocumentButton);
  }
}
