import { test, expect } from '@playwright/test';
import {
  planCommand,
  describeTarget,
  demoAppOrigin,
  type InventoryEntry,
  type SheetRowRef,
} from '@aitp/shared';

/**
 * P — the precedence, and what a nothing-answer says it looked in.
 * T — what a run states about its target.
 *
 * Expectations derive from `docs/phase-2-command-box.md` §1, §2 and §5, written
 * and committed before this code (rule 4).
 */

const entry = (title: string, tags: string[] = []): InventoryEntry => ({
  title,
  leafTitle: title,
  file: 'tests/demo/employee-registration.spec.ts',
  tags,
});

const INVENTORY: InventoryEntry[] = [
  entry('registers a new employee end to end', ['@smoke']),
  entry('rejects a duplicate employee id', ['@regression']),
  entry('exports the audit report', ['@regression']),
];

const SHEET: SheetRowRef[] = [
  { rowId: 'SI_001 / TC_001', text: 'Login user signs in with valid credentials' },
  { rowId: 'SI_007 / TC_003', text: 'Dashboard workspace filter updates widgets' },
];

const CAPTURE = ['dashboard', 'files'];

test.describe('the precedence, and why each door did not answer (P) @unit', () => {
  test('P1: an existing test wins, and generation is not paid for', () => {
    // wrong: with the order reversed the platform pays a model to recreate a
    // test it already has — the exact cost the gate exists to avoid, and it
    // would be invisible because the generated case would look fine.
    const plan = planCommand({ command: 'test the employee registration', inventory: INVENTORY });

    expect(plan.door).toBe('existing');
    expect(plan.matched.length).toBeGreaterThan(0);
    expect(plan.reason).toContain('existing test');
  });

  test('P2: a SHEET row beats generation — rule 4, and this is the load-bearing case', () => {
    // wrong: generating here prefers the model's reading of the application over
    // a human's written statement of intent, with theirs sitting unread. That is
    // rule 4 violated by preference ORDER, which no single bad test would show.
    const plan = planCommand({
      command: 'test the workspace filter widgets',
      inventory: INVENTORY,
      sheetRows: SHEET,
      captureStates: CAPTURE,
    });

    expect(plan.door).toBe('sheet');
    expect(plan.sheetMatches.map((row) => row.rowId)).toEqual(['SI_007 / TC_003']);
    // Discriminating: a capture WAS available, so generation was possible and
    // was declined. Without a capture this test could not tell the two apart.
    expect(plan.searched.captureStates).toEqual(CAPTURE);
  });

  test('P3: generation answers only when nobody has written it down', () => {
    // wrong: a generation door that never fires makes the whole AI path dead
    // code, and the refusal would look like caution rather than a bug.
    const plan = planCommand({
      command: 'test the notification preferences drawer',
      inventory: INVENTORY,
      sheetRows: SHEET,
      captureStates: CAPTURE,
    });

    expect(plan.door).toBe('generate');
    expect(plan.skipped.map((s) => s.door)).toEqual(['existing', 'sheet']);
  });

  test('P4: every skipped door says WHY, in precedence order', () => {
    // wrong: "nothing matched" with no account leaves the person typing with no
    // next step — they cannot tell a missing capture from a missing workbook
    // from a badly-phrased command.
    const plan = planCommand({
      command: 'test the notification preferences drawer',
      inventory: INVENTORY,
      sheetRows: null,
      captureStates: null,
    });

    expect(plan.door).toBe('none');
    expect(plan.skipped.map((s) => s.door)).toEqual(['existing', 'sheet', 'generate']);
    expect(plan.skipped[1]!.why).toContain('no QA workbook is configured');
    expect(plan.skipped[2]!.why).toContain('pnpm inspect');
  });

  test('P5: a command of only stop words is its own answer, not "nothing matched"', () => {
    // wrong: reported as "no tests matched", the person rephrases the same empty
    // query forever — nothing was searched FOR, which is a different problem
    // with a different fix.
    const plan = planCommand({ command: 'the and of', inventory: INVENTORY });

    expect(plan.searched.keywords).toEqual([]);
    expect(plan.door).toBe('none');
    expect(plan.reason).toContain('stop word');
    // Discriminating: it must NOT claim the corpora were searched and empty.
    expect(plan.reason).not.toContain('no existing test matched');
  });

  test('P6: NOT CONFIGURED and EMPTY are different answers', () => {
    // wrong: reporting `0` for an absent workbook tells a reader the sheet was
    // searched and had nothing, sending them to fix the sheet instead of
    // configuring one. `null` and `0` are different next steps.
    const absent = planCommand({ command: 'test the drawer', inventory: INVENTORY });
    const empty = planCommand({ command: 'test the drawer', inventory: INVENTORY, sheetRows: [] });

    expect(absent.searched.sheetRows).toBeNull();
    expect(empty.searched.sheetRows).toBe(0);
    expect(absent.skipped.find((s) => s.door === 'sheet')!.why).toContain('no QA workbook');
    expect(empty.skipped.find((s) => s.door === 'sheet')!.why).toContain('0 row(s)');
  });

  test('P7: a suppressed generation names its suppressor with a score', () => {
    // wrong: without `suppressedBy`, keyword matching that wrongly suppressed a
    // genuinely new flow is indistinguishable from "there was no gap to fill" —
    // the gate's own header warns about exactly this, and nothing surfaced it.
    const plan = planCommand({ command: 'test the audit report export', inventory: INVENTORY });

    expect(plan.gate.generate).toBe(false);
    expect(plan.gate.suppressedBy[0]!.title).toContain('audit report');
    expect(plan.gate.suppressedBy[0]!.score).toBeGreaterThan(0);
  });

  test('P8: pinning a door skips the earlier ones deliberately', () => {
    // wrong: if `source` were ignored, a QA asking specifically for their sheet
    // rows would get an existing test instead and never know their rows were
    // passed over.
    const plan = planCommand({
      command: 'test the employee registration',
      source: 'sheet',
      inventory: INVENTORY,
      sheetRows: SHEET,
    });

    // The SAME command with `auto` answers `existing` (P1) — that is what makes
    // this fixture discriminating rather than merely green.
    expect(plan.door).toBe('none');
    expect(plan.skipped.map((s) => s.door)).toEqual(['sheet']);
    expect(plan.reason).toContain('pinned');
  });
});

test.describe('a run states its target (T) @unit', () => {
  test('T1: the demo app is recognised from its resolved URL', () => {
    // wrong: a demo run that does not announce itself reads exactly like a run
    // against a customer system three weeks later.
    const target = describeTarget('local', demoAppOrigin());

    expect(target.isDemoApp).toBe(true);
    expect(target.baseUrl).toContain('4173');
  });

  test('T2: isDemoApp is computed from the URL, never from the environment NAME', () => {
    // wrong: trusting the name reports `isDemoApp: true` for an environment
    // called "local" that resolves to a customer system — which is precisely
    // what every key on this machine did until 2026-09-11.
    const target = describeTarget('local', 'https://dmsuiv3.aitalkx.com');

    expect(target.isDemoApp).toBe(false);
    expect(target.environment).toBe('local');
    expect(target.baseUrl).toBe('https://dmsuiv3.aitalkx.com');
  });

  test('T3: localhost and 127.0.0.1 are the same server', () => {
    // wrong: comparing origins as strings calls the demo app a customer system
    // whenever someone writes `localhost`, and the warning that matters gets
    // attached to the wrong runs.
    expect(describeTarget('local', 'http://localhost:4173').isDemoApp).toBe(true);
  });

  test('T4: another loopback port is NOT the demo app', () => {
    // wrong: treating any loopback URL as the demo marks a locally-hosted copy
    // of a real system as a demo, which is the dangerous direction.
    expect(describeTarget('local', 'http://127.0.0.1:9999').isDemoApp).toBe(false);
  });
});
