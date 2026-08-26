import { z } from 'zod';

export const TestPriority = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
} as const;
export type TestPriority = (typeof TestPriority)[keyof typeof TestPriority];

/**
 * The canonical, framework-agnostic description of a test case.
 *
 * Phase 1: authored by hand in tests/.
 * Phase 2: produced by the AI test-case generator from a plain-language command,
 *          then compiled into a Playwright spec by the script generator.
 * Keeping this contract stable is what lets both paths share one execution engine.
 */
export const testStepSchema = z.object({
  action: z.enum([
    'navigate',
    'click',
    'fill',
    'select',
    'check',
    'upload',
    'press',
    'wait',
    'expect',
    'api',
    'custom',
  ]),
  /** Human-readable target, e.g. "Employee ID input". Resolved by the locator strategy. */
  target: z.string().optional(),
  value: z.string().optional(),
  /** Assertion descriptor for `expect` steps, e.g. "toBeVisible" or "toHaveText:Saved". */
  assertion: z.string().optional(),
  description: z.string(),
});
export type TestStepSpec = z.infer<typeof testStepSchema>;

export const testCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  feature: z.string(),
  priority: z.nativeEnum(TestPriority).default(TestPriority.Medium),
  tags: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(testStepSchema).min(1),
  expectedResults: z.array(z.string()).default([]),
  testData: z.record(z.unknown()).default({}),
  /** Set when this case was produced by the AI generator rather than hand-authored. */
  generatedBy: z.string().optional(),
  sourceCommand: z.string().optional(),
});
export type TestCase = z.infer<typeof testCaseSchema>;
