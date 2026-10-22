import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { RunStatus, type Run } from '@aitp/shared';
import { resolveDatabaseUrl } from '../../apps/api/src/config/database';
// `PrismaService`, never `@prisma/client` directly: that package is a dependency
// of apps/api and pnpm does not hoist it, so it does not resolve from `tests/`.
// Measured: `TS2307: Cannot find module '@prisma/client'`.
import { PrismaRunRepository, PrismaService } from '../../apps/api/src/modules/persistence/prisma';

/**
 * RUN HISTORY SURVIVES A RESTART — the one claim the in-memory store cannot make.
 *
 * ADR-008 calls losing run history on restart "the first thing Phase 3 should
 * fix", and §1 of `docs/design/B1-auth-and-data.md` picks this as B1b's own
 * api-level proof. It is the only property of the Postgres repository that the
 * contract suite cannot cover: every contract assertion builds a store, uses it
 * and discards it, so all nine pass perfectly against a `Map`.
 *
 * ## Why these are `@db` tagged and excluded from `pnpm verify`
 *
 * They need a database. `pnpm verify` runs on every commit on a developer
 * machine and must not, which is the whole reason the in-memory implementations
 * stay — so `scripts/test-api.mjs` excludes `@db` the way it already excludes
 * `@smoke`. `pnpm test:db` runs them.
 *
 * ## "Restart" is modelled as a NEW CLIENT, and that is honest about its limit
 *
 * A fresh `PrismaClient` plus a fresh repository instance shares nothing with
 * the one that wrote: no connection, no pool, no cache, no object graph. That is
 * what makes it a real test of PERSISTENCE rather than of a cache — and it is
 * what an API restart does to the storage layer.
 *
 * What it does NOT re-exercise is Nest's boot: the module wiring, the binding of
 * `RunRepository` to the Prisma implementation, `onModuleDestroy`. Those are
 * `api-boot.spec.ts`'s subject, and saying so here is the point — a test that
 * implied it covered them would be the §L shape.
 */

const configured = resolveDatabaseUrl(process.env.DATABASE_URL);

/**
 * SKIPPED WITH A STATED REASON, never silently.
 *
 * The design is explicit: a contributor with no database sees why the Postgres
 * half did not run, and never sees it reported as passing. `test.skip` at
 * describe level carries the sentence into the report.
 */
test.describe('run history survives a restart @api @db', () => {
  /**
   * SERIAL, for the reason `persistence-postgres.spec.ts` is: one database, and
   * that file's `reset()` empties it. Measured — the first run had both tests
   * here come back FLAKY while three of its contract assertions failed, because
   * the two files were deleting each other's rows in parallel workers.
   *
   * Across files, `pnpm test:db` passes `--workers=1`.
   */
  test.describe.configure({ mode: 'serial' });
  test.skip(
    configured.state !== 'configured',
    'DATABASE_URL is not configured, so the Postgres half cannot run. This is SKIPPED, ' +
      'not passing — run `pnpm db:deploy` and `pnpm test:db`.',
  );
  test.setTimeout(120_000);

  /** One id per test, so a leftover row from another run cannot answer for this one. */
  const runId = (): string => `run_hist_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  /** A brand-new client and repository: the "after the restart" side. */
  const reopen = async <T>(use: (repo: PrismaRunRepository) => Promise<T>): Promise<T> => {
    const client = new PrismaService();
    try {
      return await use(new PrismaRunRepository(client));
    } finally {
      await client.$disconnect();
    }
  };

  const sampleRun = (id: string): Run => ({
    id,
    status: RunStatus.Passed,
    request: {
      command: 'test the login flow',
      grep: '@smoke',
      environment: 'local',
      browsers: ['chromium', 'firefox'],
      headed: false,
      workers: 4,
      retries: 1,
      metadata: { source: 'run-history-spec' },
    },
    createdAt: new Date(Date.UTC(2026, 9, 22, 9, 0, 0)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 9, 22, 9, 0, 5)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 9, 22, 9, 1, 0)).toISOString(),
    summary: {
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      durationMs: 55_000,
      passRate: 50,
    },
    target: { environment: 'local', baseUrl: 'http://127.0.0.1:4173', isDemoApp: true },
    artifacts: { runJson: 'artifacts/reports/run.json' },
    results: [
      {
        id: 'test-a',
        title: 'Authentication › valid credentials sign the user in',
        file: 'tests/demo/login.spec.ts',
        project: 'demo',
        tags: ['@smoke'],
        outcome: 'passed',
        durationMs: 1800,
        retry: 0,
        steps: [{ title: 'goto /login', durationMs: 400 }],
        attachments: [],
      },
      {
        id: 'test-b',
        title: 'Authentication › invalid credentials are rejected',
        file: 'tests/demo/login.spec.ts',
        project: 'demo',
        tags: [],
        outcome: 'failed',
        durationMs: 2200,
        retry: 1,
        error: { message: 'expected a message', stack: 'Error: expected a message\n  at x' },
        steps: [],
        attachments: [{ name: 'screenshot', path: 'a.png', contentType: 'image/png' }],
      },
    ],
  });

  test('H1: a run written by one repository is readable by a FRESH one', async () => {
    // wrong: with the in-memory store this is the test that cannot pass — the
    // second repository holds a different Map and `findById` returns undefined.
    // Every one of the nine contract assertions passes against that Map, because
    // each builds a store, uses it and throws it away; this is the only
    // assertion in the suite that distinguishes storage from memory.
    const id = runId();
    await reopen((repo) => repo.save(sampleRun(id)));

    const after = await reopen((repo) => repo.findById(id));
    expect(after, 'the run did not survive a new client').toBeDefined();
    expect(after!.id).toBe(id);
    expect(after!.status).toBe(RunStatus.Passed);
  });

  test('H2: every field of the canonical Run survives the round trip', async () => {
    // wrong: a column the schema forgot, or a mapping that drops a nested field,
    // and H1 still passes — it only reads back the id and the status. The old
    // Prisma model had NO target at all, so a run that resolved somewhere it
    // should not have was unauditable (SEC-2); `null` and absent say different
    // things, and `headed`, `workers`, `retries` and `healingProposals` were
    // likewise missing.
    const id = runId();
    const original = sampleRun(id);
    await reopen((repo) => repo.save(original));

    const after = await reopen((repo) => repo.findById(id));
    expect(after).toBeDefined();

    expect(after!.request.command).toBe('test the login flow');
    expect(after!.request.grep).toBe('@smoke');
    expect(after!.request.browsers).toEqual(['chromium', 'firefox']);
    expect(after!.request.workers).toBe(4);
    expect(after!.request.retries).toBe(1);
    expect(after!.request.metadata).toEqual({ source: 'run-history-spec' });
    expect(after!.summary).toEqual(original.summary);
    // THE TARGET, which is the field whose absence SEC-2 was about.
    expect(after!.target).toEqual(original.target);
    expect(after!.artifacts).toEqual(original.artifacts);
    expect(after!.startedAt).toBe(original.startedAt);
    expect(after!.finishedAt).toBe(original.finishedAt);

    // Results, with their nested error and attachments.
    expect(after!.results).toHaveLength(2);
    const failed = after!.results.find((result) => result.outcome === 'failed');
    expect(failed, 'the failing result was lost').toBeDefined();
    expect(failed!.error?.message).toBe('expected a message');
    expect(failed!.error?.stack).toContain('Error: expected a message');
    expect(failed!.retry).toBe(1);
    expect(failed!.attachments).toEqual([
      { name: 'screenshot', path: 'a.png', contentType: 'image/png' },
    ]);
    const passed = after!.results.find((result) => result.outcome === 'passed');
    expect(passed!.tags).toEqual(['@smoke']);
    expect(passed!.steps).toEqual([{ title: 'goto /login', durationMs: 400 }]);
  });

  test('H3: target NULL is preserved as null, not turned into absent', async () => {
    // wrong: `?? undefined` anywhere on the read path, and the two states
    // collapse. §1 of the design keeps them apart on purpose: `null` means the
    // producer knew about targets and was given none — which is a fixable
    // configuration fault — while a missing field would mean nothing at all. A
    // reader who cannot tell them apart cannot act on either.
    const id = runId();
    const run = sampleRun(id);
    await reopen((repo) => repo.save({ ...run, target: null }));

    const after = await reopen((repo) => repo.findById(id));
    expect(after).toBeDefined();
    expect(after!.target, 'null became undefined').toBeNull();
    expect('target' in after!, 'the field itself disappeared').toBe(true);

    // Discriminating: a real target still comes back as one, or "always null"
    // would satisfy the assertion above.
    const withTarget = runId();
    await reopen((repo) => repo.save(sampleRun(withTarget)));
    expect((await reopen((repo) => repo.findById(withTarget)))!.target).toEqual(run.target);
  });

  test('H4: a re-saved run REPLACES its results rather than accumulating them', async () => {
    // wrong: the reporter writes a run, then `pnpm rca` enriches it and writes
    // again — so a save that merged would leave two rows per test, and
    // `summary.total` would disagree with how many results exist. Nothing
    // downstream could tell that from a run that genuinely had more attempts.
    const id = runId();
    const first = sampleRun(id);
    await reopen((repo) => repo.save(first));
    expect((await reopen((repo) => repo.findById(id)))!.results).toHaveLength(2);

    // The same run, enriched: one result, now carrying an RCA.
    await reopen((repo) =>
      repo.save({
        ...first,
        results: [
          {
            ...first.results[0]!,
            error: {
              message: 'expected a message',
              rca: {
                rootCause: 'the login form moved',
                category: 'selector',
                confidence: 0.8,
                evidence: ['locator timeout'],
                analyzedBy: 'test',
                analyzedAt: new Date(Date.UTC(2026, 9, 22, 9, 2, 0)).toISOString(),
              },
            },
          },
        ],
      }),
    );

    const after = await reopen((repo) => repo.findById(id));
    expect(after!.results, 'results accumulated across saves').toHaveLength(1);
    expect(after!.results[0]!.error?.rca?.category).toBe('selector');
    expect(after!.results[0]!.error?.rca?.confidence).toBe(0.8);

    // And it is still the same run, listed once.
    const listed = (await reopen((repo) => repo.list(200))).filter((run) => run.id === id);
    expect(listed, 'the run was duplicated in the listing').toHaveLength(1);
  });
});
