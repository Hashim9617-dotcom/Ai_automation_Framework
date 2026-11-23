import { existsSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { NETWORK_ATTACHMENT } from '@aitp/reporting-engine';

/**
 * A DELIBERATELY FLAKY TEST, for proving the evidence archive — never a real check.
 *
 * ## Why it lives in `tests/synthetic/`
 *
 * No Playwright project collects this directory. `demo` matches under `tests/demo`,
 * `unit` matches any path containing a `unit` segment, `api` likewise, and the live
 * projects match under `tests/apps/<application>`. So this spec runs only when
 * something points a config at it on purpose — which
 * `tests/demo/flaky-evidence-e2e.spec.ts` does — and a `pnpm verify`, a smoke run
 * and a nightly all ignore it.
 *
 * (The glob forms are deliberately spelled out in prose here: a `*` followed by a
 * `/` inside a block comment CLOSES the comment, which is how the first version of
 * this file failed to parse at all.)
 *
 * It is inside the repository rather than in a temp directory so that
 * `@aitp/reporting-engine` resolves: `NETWORK_ATTACHMENT` has to come from the
 * reporter that reads it, or the writer and the reader could disagree about the name
 * and the proof would be about a file nobody looks for (§AE).
 *
 * ## How it is flaky on purpose
 *
 * A marker file, named by the environment. The first attempt finds no marker,
 * creates it and fails; the retry finds it and passes. That makes ONE test produce
 * outcome `flaky` — a failed attempt and a passing one — which is the case that
 * loses its evidence silently, because `trace: 'retain-on-failure'` keeps the trace
 * of the attempt that failed and the passing result is the one the run reports.
 *
 * Deterministic rather than random: a test that flaked by chance would make the
 * proof flaky too, and a proof that sometimes proves nothing is worse than none.
 */

const marker = process.env.AITP_FLAKY_MARKER;

test('SYNTH fails on the first attempt and passes on the retry', async ({ page }, testInfo) => {
  // wrong: a test that always fails, which produces outcome `failed` rather than
  // `flaky` — and `failed` is the easy case nobody loses. The whole point is the run
  // that ENDS GREEN while carrying a failed attempt, because that is the one where
  // "archive on failure" quietly keeps nothing.
  if (!marker) throw new Error('AITP_FLAKY_MARKER is not set — this spec needs it to be flaky');

  // A page, so the trace and the screenshot have something to record. `setContent`
  // rather than a URL: this spec must not touch any application, real or demo.
  await page.setContent('<h1>synthetic</h1><p>evidence proof</p>');

  // A network record in the shape the reporter aggregates, so all three evidence
  // kinds are present for the attempt that fails.
  const file = testInfo.outputPath(NETWORK_ATTACHMENT);
  writeFileSync(file, JSON.stringify({ requests: [] }), 'utf8');
  await testInfo.attach(NETWORK_ATTACHMENT, { path: file, contentType: 'application/json' });

  const firstAttempt = !existsSync(marker);
  if (firstAttempt) {
    writeFileSync(marker, 'attempted', 'utf8');
    // Fails through an EXPECT so Playwright captures a screenshot and a trace, which
    // a thrown Error would also do — but an expect failure is what a real one looks
    // like, and the archive is being proved against the real shape.
    await expect(page.locator('h1'), 'deliberate first-attempt failure').toHaveText('nope');
  }

  await expect(page.locator('h1')).toHaveText('synthetic');
});
