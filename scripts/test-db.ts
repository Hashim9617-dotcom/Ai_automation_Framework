#!/usr/bin/env node
/* eslint-disable no-console -- the entire output of this script is a report a
   human reads, or a refusal they act on. Not a log line. */
/**
 * The database half of B1b, proven against the real server.
 *
 *   pnpm test:db
 *
 * `pnpm verify` does NOT run this, deliberately. Verify runs on every commit on
 * a developer machine and must not need a database — which is why the in-memory
 * implementations stay and why the unit suite binds them
 * (docs/design/B1-auth-and-data.md §1).
 *
 * ## What this script does, and what it does NOT
 *
 * It checks the four preconditions and then hands over to Playwright. The
 * assertions themselves are TESTS, in `tests/api/persistence-postgres.spec.ts`
 * and `tests/api/run-history.spec.ts`, both tagged `@db`.
 *
 * That split is deliberate rather than tidy. A first draft asserted everything
 * here, in the script, and `eslint` refused it: `scripts/` is production code
 * and may not import from `tests/`, which is where the shared repository
 * contract lives. The rule was right — assertions belong in tests, where they
 * get a runner, a reporter and a failure that names itself, and where the same
 * contract module serves both halves without a boundary violation.
 *
 * ## Four preconditions, four exit codes
 *
 * They fail in ways that look alike from a stack trace and call for completely
 * different actions, so each is named separately in the order a reader would fix
 * them. A single "could not connect to the database" would be the empty-result
 * failure in a costume.
 *
 *   14  .env assigns a key twice with different values
 *   10  DATABASE_URL is missing or malformed
 *   11  nothing is listening
 *   12  the schema is not applied
 *   16  the @db tests failed
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { resolveDatabaseUrl } from '../apps/api/src/config/database';
import { conflictingEnvKeys, readEnvFile } from './read-env-file';

const ROOT = findRepoRoot();
const API_DIR = path.join(ROOT, 'apps', 'api');

const EXIT = {
  notConfigured: 10,
  unreachable: 11,
  notMigrated: 12,
  conflictingEnv: 14,
  testsFailed: 16,
} as const;

function refuse(code: number, lines: string[]): never {
  console.error(`\nREFUSING: ${lines.join('\n  ')}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const ENV_FILE = path.join(ROOT, '.env');

  // ── 0. Does `.env` say one thing, or two? ──────────────────────────────────
  //
  // Checked FIRST, because every answer below is read from it. Found on
  // 2026-10-21: `AITP_DB_OWNER_URL` was present twice with different passwords,
  // and reading is LAST-WINS — measured — so the broken one silently decided. A
  // report whose inputs are ambiguous is worse than no report.
  const conflicts = conflictingEnvKeys(ENV_FILE);
  if (conflicts.length > 0) {
    refuse(EXIT.conflictingEnv, [
      '.env assigns the same key more than once, with DIFFERENT values:',
      '',
      ...conflicts.map((entry) => `  ${entry.key} on lines ${entry.lines.join(' and ')}`),
      '',
      'Reading is LAST-WINS, so the last one silently decides. Delete the line you',
      'did not mean. No tie-break is applied here on purpose.',
    ]);
  }

  const envFile = readEnvFile(ENV_FILE);

  // ── 1. Is there a connection string, and is it usable? ─────────────────────
  //
  // Three answers, not two. NOT CONFIGURED and MALFORMED call for different
  // actions, and neither message may echo the value — it holds a password.
  const resolved = resolveDatabaseUrl(process.env.DATABASE_URL ?? envFile.DATABASE_URL);
  if (resolved.state !== 'configured') refuse(EXIT.notConfigured, [resolved.why]);
  console.log(`\nDatabase:   ${resolved.describe}`);

  // ── 2. Is the server actually there? ───────────────────────────────────────
  //
  // Separated from step 3 because "nothing is listening" and "the schema is not
  // applied" are a stopped service and an unrun migration — one is
  // `Start-Service` and the other is `pnpm db:deploy`.
  const { hostname, port } = new URL(resolved.url);
  const reachable = await new Promise<string>((done) => {
    const socket = net.connect({ host: hostname, port: Number(port || 5432) });
    socket.setTimeout(5000);
    socket.on('connect', () => {
      socket.destroy();
      done('ok');
    });
    socket.on('timeout', () => {
      socket.destroy();
      done('timed out');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
  });
  if (reachable !== 'ok') {
    refuse(EXIT.unreachable, [
      `nothing answered at ${hostname}:${port || 5432} (${reachable}).`,
      'The server is not running, or is not listening on that address.',
      'On Windows: Get-Service postgresql-x64-17 ; Start-Service postgresql-x64-17',
    ]);
  }
  console.log(`Reachable:  ${hostname}:${port || 5432}`);

  // ── 3. Has the schema been applied? ────────────────────────────────────────
  //
  // Asked of Prisma, which owns the migration ledger, rather than by counting
  // tables ourselves — counting asks a question the output cannot always
  // express (§Z). Run from apps/api, where prisma is a dependency: from the root
  // it tries to install itself there, which is where it must not be.
  const status = spawnSync(
    process.execPath,
    [
      path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js'),
      'migrate',
      'status',
      '--schema',
      path.join(API_DIR, 'prisma', 'schema.prisma'),
    ],
    { cwd: API_DIR, encoding: 'utf8', env: { ...process.env, DATABASE_URL: resolved.url } },
  );
  if (status.status !== 0) {
    refuse(EXIT.notMigrated, [
      'the schema is not applied, or the ledger could not be read. Prisma said:',
      '',
      ...`${status.stdout ?? ''}\n${status.stderr ?? ''}`
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 12),
      '',
      'To apply it:  pnpm db:deploy   (reads AITP_DB_OWNER_URL from .env)',
    ]);
  }
  console.log('Migrations: up to date');

  // ── 4. The @db tests ───────────────────────────────────────────────────────
  //
  // `DATABASE_URL` is passed EXPLICITLY rather than left to be inherited. The
  // child resolves which tests exist from its environment, and this repo has
  // corrected the same inheritance three times — a child must be told what its
  // caller asked for, not absorb it from whatever started the parent.
  //
  // `AITP_FIXTURE_ONLY` is deliberately NOT set: the api project needs `.env`
  // merged to see DATABASE_URL at all, and it is not on the fixture-safe
  // allowlist.
  console.log('\nRunning the @db tests:\n');
  const child = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--project=api',
      '--grep',
      '@db',
      '--reporter=list',
      // ONE WORKER. There is one database and the contract suite empties it
      // between assertions, so parallel workers delete each other's rows.
      //
      // Measured rather than anticipated: the first run of these two files under
      // the api project's `fullyParallel` gave three failures and two flakes, all
      // of them one suite's `reset()` landing in the middle of the other's. A
      // shared mutable resource cannot be partitioned by worker, and `C6: an
      // empty store lists nothing` cannot be made parallel-safe by scoping ids —
      // an empty table is its subject.
      '--workers=1',
    ],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL: resolved.url } },
  );

  if (child.error) {
    refuse(EXIT.testsFailed, [`could not start Playwright — ${child.error.message}`]);
  }
  if (child.status !== 0) {
    refuse(EXIT.testsFailed, [
      `the @db tests failed (playwright exited with ${child.status}).`,
      '',
      'The grants and the repository contract are both in',
      'tests/api/persistence-postgres.spec.ts; run history is in',
      'tests/api/run-history.spec.ts. The output above names which assertion.',
    ]);
  }

  console.log('\nAll database checks passed.\n');
}

void main().catch((error: Error) => {
  console.error(`\nREFUSING: test:db crashed — ${error.message}\n`);
  process.exit(1);
});
