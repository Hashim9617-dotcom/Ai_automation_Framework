import { test, expect } from '@aitp/execution-engine';
import { UploadFilesPage } from './pages/upload-files.page';
import { BulkUploadPage } from './pages/bulk-upload.page';

/**
 * Upload wizards — single file and bulk.
 *
 * No file is ever uploaded here. What these tests protect is the wizard's own
 * guard rails: you cannot skip a step, and you cannot submit nothing. Those
 * break quietly and cost hours of manual triage when they do.
 */
const SAMPLE_WORKSPACE = process.env.DMS_SAMPLE_WORKSPACE ?? 'ABCD';

test.describe('Upload Files wizard', { tag: ['@regression', '@upload'] }, () => {
  test('opens on the workspace step', { tag: '@smoke' }, async ({ makePage }) => {
    const upload = makePage(UploadFilesPage);
    await upload.open();
    await upload.expectLoaded();

    await expect(upload.step('Workspace')).toBeVisible();
    await expect(upload.step('Folder')).toBeVisible();
    await expect(upload.step('Upload')).toBeVisible();
  });

  test(
    'will not advance until a workspace is chosen, and auto-advances once one is',
    { tag: '@safety' },
    async ({ makePage }) => {
      const upload = makePage(UploadFilesPage);
      await upload.open();
      await upload.expectLoaded();

      await upload.expectNextDisabled();

      // Not "choose a workspace, then Next becomes enabled for a manual
      // click" — confirmed live (CDP + the wizard's own tab `aria-selected`
      // state) that choosing a workspace immediately advances the wizard to
      // the Folder step; there is no separate manual advance on this step.
      // The original version of this test asserted `expectNextEnabled()`
      // right after `chooseWorkspace()`, which was actually re-querying the
      // *Folder* step's Next button — correctly disabled, since no folder
      // had been chosen yet — and reading that as "the app never enables
      // Next." See docs/dms-findings.md, Finding 8 (retracted).
      await upload.chooseWorkspace(SAMPLE_WORKSPACE);
      await expect(upload.step('Folder')).toHaveAttribute('aria-selected', 'true');
    },
  );

  test('filters the workspace list', async ({ makePage }) => {
    const upload = makePage(UploadFilesPage);
    await upload.open();
    await upload.filterWorkspaces(SAMPLE_WORKSPACE);

    await expect(upload.option(SAMPLE_WORKSPACE)).toBeVisible();
  });

  test('reaches the upload step and refuses to submit an empty upload', async ({ makePage }) => {
    // Not yet understood, so not forced to pass or quietly left red — see
    // Finding 14 (docs/dms-findings.md). chooseWorkspace() correctly lands
    // on the Folder step (fixed above), but selecting a folder from there is
    // inconsistent: sometimes it stays on the Folder step with Next still
    // disabled after 8+ seconds, and one observed run reset the wizard all
    // the way back to the Workspace step instead. That needs the same
    // trace/CDP-level rigor Finding 8's retraction got before this test's
    // assertions (or the app) get blamed for it either way.
    test.fixme(true, 'Folder-step selection behavior not yet root-caused — see Finding 14');

    const upload = makePage(UploadFilesPage);
    await upload.open();

    await upload.chooseWorkspace(SAMPLE_WORKSPACE);

    // Folder step: root is preselected on some workspaces, so only advance when
    // the wizard says we may.
    const next = await upload.nextButton();
    if (await next.isDisabled()) {
      await upload.chooseFolder(process.env.DMS_SAMPLE_FOLDER ?? 'root');
    }
    await upload.goNext();

    await expect(upload.step('Upload')).toBeVisible();
    await expect(await upload.uploadButton(), 'no files staged yet').toBeDisabled();
  });

  test('Back returns to the previous step', async ({ makePage }) => {
    const upload = makePage(UploadFilesPage);
    await upload.open();

    // chooseWorkspace() already lands us on the Folder step; Back from there
    // returns to Workspace, which still shows Next enabled (the workspace
    // stays selected) — confirmed live before writing this assertion.
    await upload.chooseWorkspace(SAMPLE_WORKSPACE);
    await upload.goBack();

    await upload.expectNextEnabled();
  });
});

test.describe('Bulk Upload wizard', { tag: ['@regression', '@upload'] }, () => {
  test('opens with all four steps', { tag: '@smoke' }, async ({ makePage }) => {
    const bulk = makePage(BulkUploadPage);
    await bulk.open();
    await bulk.expectLoaded();

    for (const step of ['Workspace', 'Folder', 'Doc type', 'Metadata'] as const) {
      await expect(bulk.step(step), `${step} step should be present`).toBeVisible();
    }
  });

  test('will not advance without a workspace', { tag: '@safety' }, async ({ makePage }) => {
    const bulk = makePage(BulkUploadPage);
    await bulk.open();
    await bulk.expectLoaded();

    await bulk.expectNextDisabled();
  });

  test('the workspace picker lists workspaces', async ({ makePage }) => {
    const bulk = makePage(BulkUploadPage);
    await bulk.open();
    await bulk.openWorkspacePicker();

    await expect(bulk.option(SAMPLE_WORKSPACE)).toBeVisible();
  });

  test('the metadata template download is gated on a document type', async ({ makePage }) => {
    const bulk = makePage(BulkUploadPage);
    await bulk.open();

    // Downloading a template before choosing a type would produce a meaningless
    // file, so the app disables it — assert that it stays disabled.
    const template = bulk.templateButton();
    if ((await template.count()) > 0) {
      await expect(template.first()).toBeDisabled();
    }
  });
});
