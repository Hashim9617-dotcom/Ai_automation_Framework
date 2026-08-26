import { test, expect } from '@playwright/test';
import { normalizeAccessibleName } from '@aitp/execution-engine';

/**
 * Regression coverage for Finding 10 (docs/dms-findings.md): the Create User
 * button's real computed accessible name carries a leading Private Use Area
 * icon-font glyph (U+EB62, Tabler Icons) that `exact: true` can never match,
 * confirmed live via the CDP accessibility tree.
 *
 * Built with String.fromCodePoint rather than a \u escape literal in this
 * file's source text — \u escapes typed directly into a file have previously
 * been silently converted to the literal invisible character by the editing
 * pipeline here, which would make this test assert against corrupted source
 * instead of the intended codepoint.
 */
const PUA_GLYPH = String.fromCodePoint(0xeb62);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);

test.describe('normalizeAccessibleName', () => {
  test('strips the real Create User icon glyph', () => {
    expect(normalizeAccessibleName(`${PUA_GLYPH} Create User`)).toBe('Create User');
  });

  test('strips zero-width space and BOM characters', () => {
    expect(normalizeAccessibleName(`Create${ZERO_WIDTH_SPACE} User${BOM}`)).toBe('Create User');
  });

  test('collapses internal whitespace and trims', () => {
    expect(normalizeAccessibleName('  Create   User  ')).toBe('Create User');
  });

  test('leaves an already-clean name untouched', () => {
    expect(normalizeAccessibleName('Create User')).toBe('Create User');
  });
});
