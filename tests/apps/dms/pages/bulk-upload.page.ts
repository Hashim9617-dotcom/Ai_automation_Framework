import { expect, type Locator } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AppPage } from './app.page';

export type BulkUploadStep = 'Workspace' | 'Folder' | 'Doc type' | 'Metadata';

/**
 * Bulk upload wizard: Workspace → Folder → Doc type → Metadata.
 *
 * Unlike the single-file wizard, the folder step here is a real tree with named
 * chevrons ("Expand bulk1"), which makes nested folders directly addressable.
 */
export class BulkUploadPage extends AppPage {
  protected readonly path = '/bulk-upload';

  private readonly steps = locator('bulk.steps', 'Bulk upload steps tablist', [
    { strategy: 'role', value: 'tablist', options: { name: 'Bulk upload steps' }, confidence: 1 },
  ]);

  private readonly workspacePicker = locator('bulk.workspacePicker', 'Select workspace dropdown', [
    { strategy: 'role', value: 'button', options: { name: 'Select workspace' }, confidence: 1 },
  ]);

  private readonly folderPicker = locator('bulk.folderPicker', 'Select folder dropdown', [
    { strategy: 'role', value: 'button', options: { name: 'Select folder' }, confidence: 1 },
  ]);

  private readonly docTypePicker = locator('bulk.docTypePicker', 'Select document type dropdown', [
    { strategy: 'role', value: 'button', options: { name: 'Select document type' }, confidence: 1 },
  ]);

  private readonly workspaceFilter = locator('bulk.workspaceFilter', 'Workspace filter', [
    { strategy: 'role', value: 'textbox', options: { name: 'Filter workspaces' }, confidence: 1 },
    { strategy: 'placeholder', value: 'Search workspaces' },
  ]);

  private readonly downloadTemplate = locator('bulk.downloadTemplate', 'Download template button', [
    { strategy: 'role', value: 'button', options: { name: 'Download template' }, confidence: 1 },
  ]);

  private readonly chooseFiles = locator('bulk.chooseFiles', 'Choose files button', [
    {
      strategy: 'role',
      value: 'button',
      options: { name: 'Choose files', exact: true },
      confidence: 1,
    },
  ]);

  private readonly uploadSubmit = locator('bulk.upload', 'Upload button', [
    { strategy: 'role', value: 'button', options: { name: 'Upload', exact: true }, confidence: 1 },
  ]);

  private readonly next = locator('bulk.next', 'Next button', [
    { strategy: 'role', value: 'button', options: { name: 'Next', exact: true }, confidence: 1 },
  ]);

  private readonly back = locator('bulk.back', 'Back button', [
    { strategy: 'role', value: 'button', options: { name: 'Back', exact: true }, confidence: 1 },
  ]);

  async expectLoaded(): Promise<void> {
    await this.expectShellVisible();
    await this.expectVisible(this.steps);
  }

  step(name: BulkUploadStep): Locator {
    return this.page.getByRole('tab', { name });
  }

  async openWorkspacePicker(): Promise<void> {
    await this.click(this.workspacePicker);
  }
  async openFolderPicker(): Promise<void> {
    await this.click(this.folderPicker);
  }
  async openDocTypePicker(): Promise<void> {
    await this.click(this.docTypePicker);
  }

  async filterWorkspaces(text: string): Promise<void> {
    await this.type(this.workspaceFilter, text);
  }

  /** Option buttons are named "Display Name\nCODE"; match the display name. */
  option(name: string): Locator {
    return this.page.getByRole('button', { name }).first();
  }

  async chooseWorkspace(name: string): Promise<void> {
    await this.option(name).click();
  }

  async chooseDocumentType(name: string): Promise<void> {
    await this.option(name).click();
  }

  /** This wizard's folder chevrons are named per folder — "Expand bulk1". */
  async expandFolder(name: string): Promise<void> {
    await this.page.getByRole('button', { name: `Expand ${name}`, exact: true }).click();
  }

  async chooseFolder(name: string): Promise<void> {
    await this.page.getByRole('button', { name, exact: true }).first().click();
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

  async expectNextDisabled(): Promise<void> {
    await expect(await this.nextButton()).toBeDisabled();
  }

  async downloadMetadataTemplate(): Promise<void> {
    await this.click(this.downloadTemplate);
  }

  /** Exposed so specs can assert on its enabled state without reaching for `page`. */
  templateButton(): Locator {
    return this.page.getByRole('button', { name: 'Download template' });
  }

  async attachFiles(paths: string | string[]): Promise<void> {
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      this.click(this.chooseFiles),
    ]);
    await chooser.setFiles(paths);
  }

  async submitUpload(): Promise<void> {
    await this.click(this.uploadSubmit);
  }
}
