import { test, expect } from '@playwright/test';
import {
  RunStatus,
  TestOutcome,
  describeTarget,
  emptySummary,
  type Run,
  type RunTarget,
} from '@aitp/shared';
import { describeRunScope, renderRunSummaryHtml } from '@aitp/reporting-engine';

/**
 * THE REPORT SAYS WHICH APPLICATION AND WHICH ENVIRONMENT (B7).
 *
 * The `<title>` was `Run <id> — <status>`: a 16-hex-digit identifier and a word.
 * Two reports open in two browser tabs were indistinguishable, and a run id is the
 * one thing in the document that tells a reader nothing about where it ran. The
 * heading printed `Environment <key>` and nothing else — and a key is not an
 * application: `app`, `qa` and `staging` are three environments of ONE system.
 *
 * ## The slug had to travel in `RunTarget`
 *
 * It was not available to the renderer at all. Putting it in `RunTarget` rather than
 * beside it is the pairing rule SEC-2 earned: the label and the target come from one
 * resolution or they can disagree. And it is REQUIRED, not optional — an optional
 * field here is a silent fallback, and a fallback naming the wrong application is
 * exactly the confident-wrong-label failure the struct exists to prevent. Making it
 * required is what made the compiler name all seven call sites.
 */

/** A minimal run. Typed, not cast (§AD), so a field the renderer reads cannot be forgotten. */
function runWith(target: RunTarget | null | undefined): Run {
  return {
    id: 'run_abc123def456',
    status: RunStatus.Passed,
    request: { environment: 'qa', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt: '2026-11-10T09:00:00.000Z',
    startedAt: '2026-11-10T09:00:01.000Z',
    finishedAt: '2026-11-10T09:00:42.000Z',
    summary: { ...emptySummary(), total: 1, passed: 1, passRate: 100, durationMs: 41_000 },
    ...(target === undefined ? {} : { target }),
    artifacts: {},
    results: [
      {
        id: 't1',
        title: 'DEPT-001 the department list loads',
        file: 'tests/apps/ecom/departments.spec.ts',
        project: 'chromium',
        tags: [],
        outcome: TestOutcome.Passed,
        durationMs: 1200,
        retry: 0,
        steps: [],
        attachments: [],
      },
    ],
  };
}

test.describe('the report names its application and environment @unit', () => {
  test('B7a: the title leads with application and environment, not the run id', () => {
    // wrong: `<title>Run run_abc123def456 — passed</title>`, which is what it was —
    // so two tabs showed the same thing and a reader had to open the body to learn
    // which system the report was about. The id is still there, LAST, because it is
    // what an archive is keyed on; it is just no longer the whole title.
    const html = renderRunSummaryHtml(
      runWith(describeTarget('qa', 'https://qa.example.test', 'ecom')),
    );
    expect(html).toContain('<title>ecom · qa — passed — run_abc123def456</title>');
    // And the title must LEAD with the scope: a title truncated by a browser tab
    // has to still answer "which system", which is the whole point.
    expect(html.indexOf('ecom · qa')).toBeLessThan(html.indexOf('run_abc123def456'));
  });

  test('B7b: the heading carries application, environment AND the resolved URL', () => {
    // wrong: `Environment qa` alone — a label with nothing to contradict it, which
    // is SEC-2's shape. The URL is what makes the label falsifiable: on 2026-09-11
    // every key on this machine, `local` included, resolved to a customer system,
    // and a report printing only the key said nothing was wrong.
    const html = renderRunSummaryHtml(
      runWith(describeTarget('qa', 'https://qa.example.test', 'ecom')),
    );
    expect(html).toContain('application <strong>ecom</strong>');
    expect(html).toContain('environment <strong>qa</strong>');
    expect(html).toContain('https://qa.example.test');
  });

  test('B7c: a demo run SAYS it is the demo app, so it cannot read as a customer run', () => {
    // wrong: a green demo run and a green customer run render identically, which is
    // the explicit requirement in docs/phase-2-command-box.md §5 — "a green run
    // against the demo app must never read like one against a customer system". This
    // is the discriminating half of B7b: same renderer, same shape, one bit apart.
    const html = renderRunSummaryHtml(
      runWith(describeTarget('local', 'http://127.0.0.1:4173', 'bundled-demo')),
    );
    expect(html).toContain('(bundled demo app)');

    const live = renderRunSummaryHtml(
      runWith(describeTarget('qa', 'https://qa.example.test', 'ecom')),
    );
    expect(live).not.toContain('(bundled demo app)');
  });

  test('B7d: with NO target the report says the application is unknown, never guesses', () => {
    // wrong: falling back to `request.environment` and presenting it as the
    // application — a confident wrong label, which is worse than an absent one. The
    // three states stay three: a target, `null` (the producer knew and was given
    // none), and absent (written before the field existed). Both of the latter two
    // must read as "unknown" rather than borrowing the environment key's name.
    for (const target of [null, undefined] as const) {
      const html = renderRunSummaryHtml(runWith(target));
      expect(html).toContain('application unknown');
      expect(html).toContain('<title>qa (application unknown)');
      // The key is still shown — it is the only thing known — but never AS the
      // application.
      expect(html).toContain('environment <strong>qa</strong>');
      expect(html).not.toContain('application <strong>qa</strong>');
    }
  });

  test('B7e: describeRunScope is the one expression both the title and the heading use', () => {
    // wrong: the title and the heading computing the scope separately — two copies
    // of "which application is this", which drift, and a drifted copy reads exactly
    // like a correct one (§AE). Here the drift would show as a tab naming one
    // application and the page naming another.
    const run = runWith(describeTarget('qa', 'https://qa.example.test', 'ecom'));
    const scope = describeRunScope(run);
    expect(scope).toBe('ecom · qa');
    const html = renderRunSummaryHtml(run);
    // Present twice: once in the title, once in the h1.
    expect(html.split(scope).length - 1).toBeGreaterThanOrEqual(2);
  });
});
