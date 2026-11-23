import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase as PwTestCase,
  TestResult as PwTestResult,
} from '@playwright/test/reporter';
import { AitpReporter, NETWORK_ATTACHMENT } from '@aitp/reporting-engine';
import { describeTarget, type Run } from '@aitp/shared';

/**
 * THE REPORTER RECORDS ANNOTATIONS AND AGGREGATES THE NETWORK RECORDS.
 *
 * ## What it used to drop
 *
 * Both. The Ecom smoke suite records `sheet-drift`, `re-login`, `third-party-4xx`
 * and `stepper` as annotations, and the reporter kept none of them — so `run.json`
 * said nothing, and a report built from it would have printed "sheet drift: 0"
 * while the truth was "nobody looked". The per-test network records were attached
 * with `body:`, so Playwright stored them inline, `run.json` recorded
 * `path: "inline"`, and sixty-two tests each "attached" an answer that could not be
 * read back.
 *
 * Both were measured on 2026-11-18 by trying to read them out of `run.json` after a
 * real 64-test run and finding nothing there.
 *
 * ## The harness drives the reporter directly
 *
 * No browser and no application: `onTestEnd` takes a Playwright test and result, so
 * synthetic ones exercise exactly the mapping under test. What this cannot show is
 * that a real run produces these shapes — `tests/apps/ecom/` does that — so the two
 * are deliberately separate and this one owns the mapping.
 */

/** A Playwright test, as much of one as `onTestEnd` reads. Typed, not cast (§AD). */
function pwTest(over: Partial<{ id: string; title: string; annotations: unknown[] }> = {}) {
  return {
    id: over.id ?? 't1',
    titlePath: () => ['', 'suite', over.title ?? 'a test'],
    location: { file: path.join(process.cwd(), 'tests', 'x.spec.ts'), line: 1, column: 1 },
    parent: { project: () => ({ name: 'chromium' }) },
    tags: ['@ecom'],
    annotations: over.annotations ?? [],
    outcome: () => 'expected',
  } as unknown as PwTestCase;
}

function pwResult(
  over: Partial<{ annotations: unknown[]; attachments: unknown[]; status: string }> = {},
) {
  return {
    status: over.status ?? 'passed',
    duration: 1234,
    retry: 0,
    steps: [],
    annotations: over.annotations ?? [],
    attachments: over.attachments ?? [],
  } as unknown as PwTestResult;
}

async function runJsonFrom(
  entries: Array<{ test: PwTestCase; result: PwTestResult }>,
): Promise<Run> {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitp-reporter-ann-'));
  try {
    const reporter = new AitpReporter({
      outputDir: dir,
      target: describeTarget('ecom', 'https://app.example.test', 'ecom'),
    });
    reporter.onBegin({} as FullConfig, { allTests: () => [] } as unknown as Suite);
    for (const entry of entries) reporter.onTestEnd(entry.test, entry.result);
    await reporter.onEnd({ status: 'passed' } as FullResult);
    return JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as Run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a network record where the reporter will look for it. */
function networkAttachment(
  requests: Array<{ method: string; path: string; status: number; sameOrigin: boolean }>,
): { dir: string; attachment: unknown } {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitp-net-'));
  const file = path.join(dir, NETWORK_ATTACHMENT);
  writeFileSync(file, JSON.stringify({ requests }), 'utf8');
  return {
    dir,
    attachment: { name: NETWORK_ATTACHMENT, path: file, contentType: 'application/json' },
  };
}

test.describe('the reporter records annotations @unit', () => {
  test('A1: a spec’s annotations reach run.json', () => {
    // wrong: they are dropped, which is what happened. `sheet-drift: 0` then cannot
    // be told from "nobody looked", and a report prints the first while meaning the
    // second — the confident wrong number this repo keeps finding.
    return runJsonFrom([
      {
        test: pwTest(),
        result: pwResult({
          annotations: [
            { type: 'sheet-drift', description: 'Tax: expects Rate, page has Tax Rate' },
            { type: 're-login', description: 'the session had expired' },
          ],
        }),
      },
    ]).then((run) => {
      expect(run.results[0]!.annotations).toEqual([
        { type: 'sheet-drift', description: 'Tax: expects Rate, page has Tax Rate' },
        { type: 're-login', description: 'the session had expired' },
      ]);
    });
  });

  test('A2: a test with NO annotations has the field ABSENT, not empty', () => {
    // wrong: writing `annotations: []` always. Then an old run.json without the
    // field and a new one from a test that had none become indistinguishable, and
    // the three states — not recorded, none, some — collapse to two. Absent must
    // keep meaning "this producer did not record them".
    return runJsonFrom([{ test: pwTest(), result: pwResult() }]).then((run) => {
      expect('annotations' in run.results[0]!).toBe(false);
    });
  });

  test('A3: static and runtime annotations are merged and de-duplicated', () => {
    // wrong: taking only one source. Playwright puts `test.describe` annotations on
    // the TEST and a spec's own `annotations.push` on the RESULT, so reading either
    // alone loses half — and reading both without de-duplicating doubles every
    // annotation Playwright copies onto both, which it does for static ones.
    return runJsonFrom([
      {
        test: pwTest({ annotations: [{ type: 'slow', description: 'known slow' }] }),
        result: pwResult({
          annotations: [
            { type: 'slow', description: 'known slow' },
            { type: 'stepper', description: 'Next: Line Items' },
          ],
        }),
      },
    ]).then((run) => {
      expect(run.results[0]!.annotations).toEqual([
        { type: 'slow', description: 'known slow' },
        { type: 'stepper', description: 'Next: Line Items' },
      ]);
    });
  });

  test('A4: an annotation with no description keeps the field off rather than empty', () => {
    // wrong: `description: undefined`, which JSON.stringify drops anyway — so the
    // written shape would differ from the in-memory one and a reader comparing them
    // would see a phantom difference. Or `description: ''`, which claims the spec
    // supplied an empty one.
    return runJsonFrom([
      { test: pwTest(), result: pwResult({ annotations: [{ type: 'fixme' }] }) },
    ]).then((run) => {
      expect(run.results[0]!.annotations).toEqual([{ type: 'fixme' }]);
    });
  });
});

test.describe('the reporter aggregates the network records @unit', () => {
  test('N1: it reads the attachment FILES and writes a run-level summary', () => {
    // wrong: no summary at all, which is what there was — the records were inline
    // and unreachable. This is the end-to-end half of
    // tests/unit/run-network-summary.spec.ts: that one proves the arithmetic, this
    // one proves the reporter finds the files and asks it.
    const first = networkAttachment([
      { method: 'GET', path: '/api/a', status: 200, sameOrigin: true },
      { method: 'GET', path: '/api/b', status: 500, sameOrigin: true },
    ]);
    const second = networkAttachment([
      { method: 'GET', path: '/web/cart', status: 403, sameOrigin: false },
    ]);
    try {
      return runJsonFrom([
        { test: pwTest({ id: 't1' }), result: pwResult({ attachments: [first.attachment] }) },
        { test: pwTest({ id: 't2' }), result: pwResult({ attachments: [second.attachment] }) },
      ]).then((run) => {
        expect(run.network).toBeDefined();
        expect(run.network!.totalRequests).toBe(3);
        expect(run.network!.testsReporting).toBe(2);
        expect(run.network!.appByStatus).toEqual({ '200': 1, '500': 1 });
        expect(run.network!.thirdPartyByStatus).toEqual({ '403': 1 });
        expect(run.network!.appWriteAttempts).toBe(0);
        expect(run.network!.topFailingEndpoints.map((e) => `${e.path} ${e.status}`)).toEqual([
          '/api/b 500',
          '/web/cart 403',
        ]);
      });
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  test('N2: with no network attachment the field is ABSENT, not a summary of zeroes', () => {
    // wrong: an empty summary. "No test was instrumented" and "the run made no
    // requests" are different answers, and a summary of zeroes states the second
    // while meaning the first — so a reader would conclude a clean run from a run
    // that measured nothing. Absent is the honest value.
    return runJsonFrom([{ test: pwTest(), result: pwResult() }]).then((run) => {
      expect(run.network).toBeUndefined();
    });
  });

  test('N3: an INLINE attachment is not counted as a quiet test', () => {
    // wrong: treating `path: "inline"` as a readable record and pushing an empty
    // list for it. `testsReporting` would then say the test reported while its
    // requests were invisible — which is precisely the bug being fixed, reappearing
    // one level up as a number that looks right. There is nothing on disk, so it is
    // counted as unreadable and the summary says nothing rather than something
    // false.
    return runJsonFrom([
      {
        test: pwTest(),
        result: pwResult({
          attachments: [{ name: NETWORK_ATTACHMENT, contentType: 'application/json' }],
        }),
      },
    ]).then((run) => {
      expect(run.network).toBeUndefined();
    });
  });

  test('N4: an unreadable file does not silently become a quiet test', () => {
    // wrong: a catch that pushes `[]`. The test would count toward
    // `testsReporting` while contributing nothing, so the denominator would
    // explain a total it no longer accounts for — a catch converting a failure
    // into a confident negative answer, which is the shape the three-states rule
    // exists for.
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-net-bad-'));
    const file = path.join(dir, NETWORK_ATTACHMENT);
    writeFileSync(file, '{ not json', 'utf8');
    const good = networkAttachment([
      { method: 'GET', path: '/api/a', status: 200, sameOrigin: true },
    ]);
    try {
      return runJsonFrom([
        {
          test: pwTest({ id: 't1' }),
          result: pwResult({
            attachments: [
              { name: NETWORK_ATTACHMENT, path: file, contentType: 'application/json' },
            ],
          }),
        },
        { test: pwTest({ id: 't2' }), result: pwResult({ attachments: [good.attachment] }) },
      ]).then((run) => {
        // The good one is still summarised, and the bad one is NOT counted.
        expect(run.network!.testsReporting).toBe(1);
        expect(run.network!.totalRequests).toBe(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(good.dir, { recursive: true, force: true });
    }
  });
});

test.describe('backward compatibility @unit', () => {
  test('B1: a run.json written before either field still parses as a Run', () => {
    // wrong: making either field required. Every archived run under
    // artifacts/runs/ predates both, and the API hydrates from those — so a
    // required field would turn every historical record into a parse failure, which
    // is a migration nobody asked for in exchange for a field nothing needs.
    const legacy = {
      id: 'run_old',
      status: 'passed',
      request: { environment: 'qa', browsers: ['chromium'], headed: false, metadata: {} },
      createdAt: '2026-01-01T00:00:00.000Z',
      artifacts: {},
      results: [
        {
          id: 't1',
          title: 'an old test',
          file: 'tests/x.spec.ts',
          project: 'chromium',
          tags: [],
          outcome: 'passed',
          durationMs: 10,
          retry: 0,
          steps: [],
          attachments: [],
        },
      ],
    };
    // Assigning it to `Run` is the compile-time half; the runtime half is that
    // every field a reader touches is present and the two new ones read as absent.
    const run = legacy as unknown as Run;
    expect(run.network).toBeUndefined();
    expect(run.results[0]!.annotations).toBeUndefined();
    // And a reader can tell "not recorded" from "none" without a special case.
    expect('annotations' in run.results[0]!).toBe(false);
  });
});
