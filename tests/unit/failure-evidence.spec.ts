import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  AitpReporter,
  EVIDENCE_KINDS,
  EVIDENCE_MANIFEST,
  NETWORK_ATTACHMENT,
  evidenceKindOf,
} from '@aitp/reporting-engine';
import { describeTarget } from '@aitp/shared';

/**
 * A FAILED OR FLAKY TEST KEEPS ITS EVIDENCE — even when a later retry passes.
 *
 * ## The case that is easy to lose
 *
 * `trace: 'retain-on-failure'` deletes the trace of an attempt that PASSED. For a
 * flaky test that is the right behaviour and it puts the one trace worth having —
 * the failed attempt's — in a directory that the PASSING attempt's result does not
 * reference. A run that reported `flaky: 1` and archived nothing would look
 * identical to one that archived everything: the archive directory exists either
 * way, and the log says "archived" either way.
 *
 * This repo has already paid for that once. Run A's flaky evidence for SQ-002 and
 * TAX-001 was destroyed before anybody read it, and the triage those failures were
 * supposed to get never happened.
 *
 * ## Why the reporter is driven directly
 *
 * The subject is the ARCHIVE, not Playwright's retention. So the attachments here
 * are real files in a temp directory, deliberately arranged in the shapes that
 * matter — present on disk, recorded as `inline`, and recorded with a path that no
 * longer exists — and the reporter is handed results that say `failed` and `flaky`.
 * A real child run would add Playwright's own retention to the experiment and could
 * not distinguish "we did not archive it" from "Playwright had already deleted it".
 *
 * `tests/demo/flaky-evidence-e2e.spec.ts` covers the other half, against a
 * deliberately failing synthetic spec in a real process.
 */

const RUN_DIRS = 'runs';

function pwTest(over: { id: string; title: string; outcome: string }) {
  return {
    id: over.id,
    titlePath: () => ['', 'suite', over.title],
    location: { file: path.join(process.cwd(), 'tests', 'synthetic.spec.ts'), line: 1, column: 1 },
    parent: { project: () => ({ name: 'chromium' }) },
    tags: [],
    annotations: [],
    outcome: () => over.outcome,
  } as unknown as PwTestCase;
}

function pwResult(over: { status: string; retry?: number; attachments: unknown[] }) {
  return {
    status: over.status,
    duration: 10,
    retry: over.retry ?? 0,
    steps: [],
    annotations: [],
    attachments: over.attachments,
  } as unknown as PwTestResult;
}

/** A real file on disk, so "present" means present rather than mentioned. */
function evidenceFiles(dir: string): Array<{ name: string; path: string; contentType: string }> {
  mkdirSync(dir, { recursive: true });
  const trace = path.join(dir, 'trace.zip');
  const shot = path.join(dir, 'test-failed-1.png');
  const network = path.join(dir, NETWORK_ATTACHMENT);
  writeFileSync(trace, 'PK-not-really-a-zip', 'utf8');
  writeFileSync(shot, 'png-bytes', 'utf8');
  writeFileSync(network, JSON.stringify({ requests: [] }), 'utf8');
  return [
    { name: 'trace', path: trace, contentType: 'application/zip' },
    { name: 'screenshot', path: shot, contentType: 'image/png' },
    { name: NETWORK_ATTACHMENT, path: network, contentType: 'application/json' },
  ];
}

interface Manifest {
  runId: string;
  kinds: string[];
  tests: Array<{
    title: string;
    outcome: string;
    attempts: number;
    present: string[];
    missing: string[];
  }>;
}

/** Runs the reporter over one set of results and returns the archive it produced. */
async function archiveOf(
  entries: Array<{ test: PwTestCase; result: PwTestResult }>,
): Promise<{ dir: string; manifest: Manifest | null; cleanUp: () => void }> {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-evidence-'));
  const reportsDir = path.join(root, 'artifacts', 'reports');
  // The reporter derives `artifacts/` from its own outputDir, and `test-results`
  // from that — the same layout a real run has.
  mkdirSync(path.join(root, 'artifacts', 'test-results'), { recursive: true });

  const reporter = new AitpReporter({
    outputDir: reportsDir,
    target: describeTarget('ecom', 'https://app.example.test', 'ecom'),
  });
  reporter.onBegin({} as FullConfig, { allTests: () => [] } as unknown as Suite);
  for (const entry of entries) reporter.onTestEnd(entry.test, entry.result);
  await reporter.onEnd({ status: 'failed' } as FullResult);

  const run = JSON.parse(readFileSync(path.join(reportsDir, 'run.json'), 'utf8')) as {
    id: string;
  };
  const dir = path.join(root, 'artifacts', RUN_DIRS, run.id);
  const manifestPath = path.join(dir, EVIDENCE_MANIFEST);
  return {
    dir,
    manifest: existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest)
      : null,
    cleanUp: () => rmSync(root, { recursive: true, force: true }),
  };
}

test.describe('failed and flaky tests keep their evidence @unit', () => {
  test('E1: a FLAKY test — failed then passed — is archived with all three kinds', async () => {
    // wrong: archiving only on `failed`, so a run that ended green after a retry
    // keeps nothing. That is the case this repo has already lost once: Run A's
    // flaky evidence for SQ-002 and TAX-001 was gone before anybody read it, and
    // the triage never happened. A flaky test is a test that failed.
    const files = mkdtempSync(path.join(tmpdir(), 'aitp-ev-files-'));
    const attachments = evidenceFiles(path.join(files, 'flaky-attempt-0'));
    const archive = await archiveOf([
      {
        test: pwTest({ id: 't1', title: 'a flaky module list', outcome: 'flaky' }),
        result: pwResult({ status: 'passed', retry: 1, attachments }),
      },
    ]);
    try {
      expect(archive.manifest, 'no evidence manifest was written').not.toBeNull();
      const entry = archive.manifest!.tests[0]!;
      expect(entry.outcome).toBe('flaky');
      expect(entry.present).toEqual([...EVIDENCE_KINDS]);
      expect(entry.missing).toEqual([]);
    } finally {
      archive.cleanUp();
      rmSync(files, { recursive: true, force: true });
    }
  });

  test('E2: a test whose trace is GONE is reported as missing, not as archived', async () => {
    // wrong: `cpSync` returning without error read as proof the evidence is there.
    // Copying a directory that no longer holds the trace succeeds silently, and the
    // archive then looks complete — a directory exists, the log says "archived",
    // and the trace is gone. This is the discriminating half of E1: without it, a
    // manifest that always said "all three present" would pass E1 forever.
    const files = mkdtempSync(path.join(tmpdir(), 'aitp-ev-files-'));
    const attachments = evidenceFiles(path.join(files, 'failed-attempt-0'));
    // The trace is listed and NOT on disk — exactly what retain-on-failure leaves
    // when the retained attempt was the one that passed.
    rmSync(attachments[0]!.path);
    const archive = await archiveOf([
      {
        test: pwTest({ id: 't2', title: 'a failing module list', outcome: 'unexpected' }),
        result: pwResult({ status: 'failed', attachments }),
      },
    ]);
    try {
      const entry = archive.manifest!.tests[0]!;
      expect(entry.missing).toEqual(['trace']);
      expect(entry.present).toEqual(['screenshot', 'network']);
    } finally {
      archive.cleanUp();
      rmSync(files, { recursive: true, force: true });
    }
  });

  test('E3: an INLINE attachment is not counted as evidence on disk', async () => {
    // wrong: treating a listed attachment as present. An `inline` attachment lives
    // inside Playwright's own report and there is no file in the archive — which is
    // the same bug the network records had, reappearing where it would make the
    // evidence manifest lie in the reassuring direction.
    const archive = await archiveOf([
      {
        test: pwTest({ id: 't3', title: 'an inline-only failure', outcome: 'unexpected' }),
        result: pwResult({
          status: 'failed',
          attachments: [
            { name: 'trace', path: 'inline', contentType: 'application/zip' },
            { name: NETWORK_ATTACHMENT, contentType: 'application/json' },
          ],
        }),
      },
    ]);
    try {
      expect(archive.manifest!.tests[0]!.present).toEqual([]);
      expect(archive.manifest!.tests[0]!.missing).toEqual([...EVIDENCE_KINDS]);
    } finally {
      archive.cleanUp();
    }
  });

  test('E4: a PASSING run archives nothing at all', async () => {
    // wrong: archiving every run, which would copy the whole report and
    // test-results directory on each green run and fill the disk — the thing the
    // pruning policy in global-setup exists to stop. And a manifest listing no
    // tests would read as "evidence was checked and found complete".
    const archive = await archiveOf([
      {
        test: pwTest({ id: 't4', title: 'a passing list', outcome: 'expected' }),
        result: pwResult({ status: 'passed', attachments: [] }),
      },
    ]);
    try {
      expect(existsSync(archive.dir), 'a clean run was archived').toBe(false);
      expect(archive.manifest).toBeNull();
    } finally {
      archive.cleanUp();
    }
  });

  test('E6: evidence is unioned ACROSS ATTEMPTS, not demanded of each one', async () => {
    // wrong: reporting per attempt, which the first version did. A flaky test appears
    // in `run.results` TWICE — the attempt that failed, carrying the trace and the
    // screenshot, and the attempt that passed, carrying neither because
    // retain-on-failure deleted them. Per attempt, the passing one reads
    // `missing: ["trace","screenshot"]` and warns, on a run whose evidence is
    // complete and correct. Measured on a real flaky run, not reasoned about.
    const files = mkdtempSync(path.join(tmpdir(), 'aitp-ev-files-'));
    const failedAttempt = evidenceFiles(path.join(files, 'attempt-0'));
    // The retry keeps only the network record, which is what a real one looks like.
    const retry = failedAttempt.filter((file) => file.name === NETWORK_ATTACHMENT);
    const archive = await archiveOf([
      {
        test: pwTest({ id: 'same-id', title: 'a flaky list', outcome: 'flaky' }),
        result: pwResult({ status: 'failed', retry: 0, attachments: failedAttempt }),
      },
      {
        test: pwTest({ id: 'same-id', title: 'a flaky list', outcome: 'flaky' }),
        result: pwResult({ status: 'passed', retry: 1, attachments: retry }),
      },
    ]);
    try {
      expect(archive.manifest!.tests, 'one entry per TEST, not per attempt').toHaveLength(1);
      const entry = archive.manifest!.tests[0]!;
      expect(entry.attempts).toBe(2);
      expect(entry.present).toEqual([...EVIDENCE_KINDS]);
      expect(entry.missing).toEqual([]);
    } finally {
      archive.cleanUp();
      rmSync(files, { recursive: true, force: true });
    }
  });

  test('E5: the kind of an attachment is decided by name, then by content type', async () => {
    // wrong: keying on filename, which Playwright varies — the screenshot is
    // `test-failed-1.png` on a failure and `screenshot` when attached by hand, so a
    // name-only rule would miss one of them and report the evidence incomplete for
    // a test that had it. And the silent half: something that is neither must map
    // to null rather than to a bucket, or every attachment would satisfy some kind.
    expect(evidenceKindOf({ name: 'trace', contentType: 'application/zip' })).toBe('trace');
    expect(evidenceKindOf({ name: NETWORK_ATTACHMENT })).toBe('network');
    expect(evidenceKindOf({ name: 'screenshot' })).toBe('screenshot');
    expect(evidenceKindOf({ name: 'test-failed-1.png', contentType: 'image/png' })).toBe(
      'screenshot',
    );
    expect(
      evidenceKindOf({ name: 'diagnostics.json', contentType: 'application/json' }),
    ).toBeNull();
    expect(evidenceKindOf({ name: 'locator-telemetry.json' })).toBeNull();
  });
});
