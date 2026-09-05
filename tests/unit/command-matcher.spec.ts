import { test, expect } from '@playwright/test';
import {
  flattenSuites,
  rank,
  tokenize,
  escapeRegex,
} from '@aitp/shared';

/**
 * Locks in two behaviours that are easy to get wrong and expensive to debug:
 *  - tags live on the SPEC node of Playwright's JSON report, without a leading '@'
 *  - --grep matches the LEAF test title, not the describe-joined path
 */
const REPORT = {
  suites: [
    {
      title: 'e2e/employee-registration.spec.ts',
      file: 'e2e/employee-registration.spec.ts',
      specs: [],
      suites: [
        {
          title: 'Employee registration',
          file: 'e2e/employee-registration.spec.ts',
          specs: [
            {
              title: 'registers a new employee and shows it in the directory',
              tags: ['regression', 'pim'],
              tests: [{ projectName: 'chromium' }, { projectName: 'firefox' }],
            },
            {
              title: 'requires the mandatory fields',
              tags: ['regression', 'pim', 'smoke'],
              tests: [{ projectName: 'chromium' }],
            },
          ],
        },
      ],
    },
  ],
};

test.describe('AI Command Box matcher', { tag: '@unit' }, () => {
  test('extracts tags from the spec node and normalises the @ prefix', () => {
    const inventory = flattenSuites(REPORT.suites);
    expect(inventory).toHaveLength(2);
    expect(inventory[0]!.tags).toEqual(['@regression', '@pim']);
    expect(inventory[1]!.tags).toContain('@smoke');
  });

  test('keeps the leaf title separate from the display path', () => {
    const [first] = flattenSuites(REPORT.suites);
    expect(first!.title).toBe(
      'Employee registration › registers a new employee and shows it in the directory',
    );
    expect(first!.leafTitle).toBe('registers a new employee and shows it in the directory');
  });

  test('drops stop words and keeps meaningful keywords', () => {
    expect(tokenize('test complete employee registration flow')).toEqual([
      'employee',
      'registration',
    ]);
    expect(tokenize('run the @smoke tests')).toEqual(['@smoke']);
  });

  test('ranks an on-topic instruction to the right tests', () => {
    const inventory = flattenSuites(REPORT.suites);
    const matches = rank(inventory, tokenize('test complete employee registration flow'));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.entry.leafTitle).toContain('registers a new employee');
  });

  test('scores a tag match higher than an incidental word match', () => {
    const inventory = flattenSuites(REPORT.suites);
    const matches = rank(inventory, ['@smoke']);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.entry.leafTitle).toBe('requires the mandatory fields');
  });

  test('returns nothing for an instruction with no coverage (the Phase 2 branch)', () => {
    const inventory = flattenSuites(REPORT.suites);
    expect(rank(inventory, tokenize('validate the payment gateway refund flow'))).toEqual([]);
  });

  test('escapes regex metacharacters so titles are safe in --grep', () => {
    expect(escapeRegex('price (USD) + tax [VAT]')).toBe('price \\(USD\\) \\+ tax \\[VAT\\]');
  });
});
