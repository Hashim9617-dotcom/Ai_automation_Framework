import { expect, type Locator } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AppPage } from './app.page';

export type UploadStep = 'Workspace' | 'Folder' | 'Upload';

/**
 * Single-file upload wizard: Workspace → Folder → Upload.
 *
 * The wizard's own guard rails are the most valuable thing to test here: `Next`
 * stays disabled until a selection is made, and `Upload files` stays disabled
 * until a file is attached. Those assertions catch a whole class of regressions
 * without uploading anything.
 */
export class UploadFilesPage extends AppPage {
  protected readonly path = '/upload-files';

  private readonly steps = locator('upload.steps', 'Upload steps tablist', [
    { strategy: 'role', value: 'tablist', options: { name: 'Upload steps' }, confidence: 1 },
  ]);

  private readonly workspaceFilter = locator('upload.workspaceFilter', 'Workspace filter', [
    { strategy: 'role', value: 'textbox', options: { name: 'Filter workspaces' }, confidence: 1 },
    { strategy: 'placeholder', value: 'Search workspaces' },
  ]);

  private readonly folderFilter = locator('upload.folderFilter', 'Folder filter', [
    { strategy: 'role', value: 'textbox', options: { name: 'Filter folders' }, confidence: 1 },
    { strategy: 'placeholder', value: 'Search folders' },
  ]);

  private readonly next = locator('upload.next', 'Next button', [
    { strategy: 'role', value: 'button', options: { name: 'Next', exact: true }, confidence: 1 },
  ]);

  private readonly back = locator('upload.back', 'Back button', [
    { strategy: 'role', value: 'button', options: { name: 'Back', exact: true }, confidence: 1 },
  ]);

  private readonly uploadSubmit = locator('upload.submit', 'Upload files button', [
    { strategy: 'role', value: 'button', options: { name: 'Upload files' }, confidence: 1 },
  ]);

  async expectLoaded(): Promise<void> {
    await this.expectShellVisible();
    await this.expectVisible(this.steps);
  }

  step(name: UploadStep): Locator {
    return this.page.getByRole('tab', { name });
  }

  /**
   * Workspace and folder options are buttons whose accessible name is
   * "Display Name\nCODE" — matched on the display name only, so a code change
   * does not break the test.
   *
   * Unscoped — there is no ARIA container role here at all (no listbox,
   * radiogroup or grid; confirmed live), so this can only rely on the
   * accessible name being unique on the page. That held for the folder step
   * in testing, which is why chooseFolder() still uses this directly.
   */
  option(name: string): Locator {
    return this.page.getByRole('button', { name }).first();
  }

  /**
   * Workspace tiles live inside a `.ws-scroll` container (confirmed live, on
   * both this wizard and Bulk Upload's — the two wizards share this
   * component). Scoping to it is what the plain `option()` above cannot do:
   * without an ARIA container role to lean on, `getByRole('button', { name })`
   * is one page-wide query, so if the workspace name is ever also present as
   * a *different* control's accessible name elsewhere on the page — a
   * breadcrumb, a recent-workspace chip — `.first()` can silently resolve to
   * that instead of the tile, "succeed" the click, and leave nothing
   * selected. Scoping to the tile grid is the fix regardless of whether that
   * collision is currently happening for any specific workspace name.
   */
  workspaceOption(name: string): Locator {
    return this.page.locator('.ws-scroll').getByRole('button', { name }).first();
  }

  async filterWorkspaces(text: string): Promise<void> {
    await this.type(this.workspaceFilter, text);
  }

  async filterFolders(text: string): Promise<void> {
    await this.type(this.folderFilter, text);
  }

  async chooseWorkspace(name: string): Promise<void> {
    this.log.info('Choosing workspace', { workspace: name });
    await this.workspaceOption(name).click();
  }

  async chooseFolder(name: string): Promise<void> {
    this.log.info('Choosing folder', { folder: name });
    await this.option(name).click();
  }

  async goNext(): Promise<void> {
    await this.click(this.next);
  }

  async goBack(): Promise<void> {
    await this.click(this.back);
  }

  nextButton(): Promise<Locator> {
    return this.find(this.next);
  }

  uploadButton(): Promise<Locator> {
    return this.find(this.uploadSubmit);
  }

  /** Nothing selected yet means the wizard must not let you continue. */
  async expectNextDisabled(): Promise<void> {
    await expect(await this.nextButton()).toBeDisabled();
  }

  async expectNextEnabled(): Promise<void> {
    await expect(await this.nextButton()).toBeEnabled();
  }

  /**
   * Attaches a file through the OS picker the app opens. Playwright intercepts
   * the chooser, so no real dialog appears.
   */
  async attachFile(filePath: string, triggerName = 'Add more files'): Promise<void> {
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      this.page.getByRole('button', { name: triggerName }).first().click(),
    ]);
    await chooser.setFiles(filePath);
  }

  async submitUpload(): Promise<void> {
    await this.click(this.uploadSubmit);
  }

  // Actions that appear once files are staged.
  stagedFileAction(action: 'Delete' | 'Download' | 'Preview'): Locator {
    return this.page.getByRole('button', { name: action, exact: true });
  }
}
