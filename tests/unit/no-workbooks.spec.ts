import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * No spreadsheet workbook is ever committed.
 *
 * The QA sheet's Test Data column carries live credentials — measured: 12 cells
 * from row 3 onward. `.gitignore` covers the extensions, but an ignore rule is
 * not a control: `git add -f` bypasses it, and a rule nobody checks is a rule
 * that quietly stops applying.
 *
 * So it is a test, for the same reason the app-agnostic split and the
 * invisible-character scan are tests: a claim with no falsifier is decoration.
 */
test.describe('no workbook is committed @unit', () => {
  test('no tracked file is a spreadsheet', () => {
    const tracked = execSync('git ls-files', {
      cwd: findRepoRoot(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
      .split(/\r?\n/)
      .filter(Boolean);

    // Asserts its own effect: a listing that read nothing reports clean forever.
    expect(tracked.length).toBeGreaterThan(50);

    const workbooks = tracked.filter((file) => /\.(xlsx|xlsm|xls|ods)$/i.test(file));
    expect(workbooks).toEqual([]);
  });

  test('the ignore rule that backs it is still in place', () => {
    // If someone removes the rule, this fails BEFORE a workbook lands rather
    // than after — the check above can only see one that already arrived.
    const ignored = execSync('git check-ignore -v "sample.xlsx" || true', {
      cwd: findRepoRoot(),
      encoding: 'utf8',
    });
    expect(ignored).toContain('.gitignore');
  });
});
