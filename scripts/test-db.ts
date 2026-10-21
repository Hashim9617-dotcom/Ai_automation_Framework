#!/usr/bin/env node
/* eslint-disable no-console -- the entire output of this script is a precondition
   report a human reads, or a refusal they act on. Not a log line. */
/**
 * The database half of the repository contract: its preconditions, then itself.
 *
 *   pnpm test:db
 *
 * `pnpm verify` does NOT run this, deliberately. Verify runs on every commit on
 * a developer machine and must not need a database — which is why the in-memory
 * implementations stay and why the unit suite binds them
 * (docs/design/B1-auth-and-data.md §1).
 *
 * ## It reports which precondition is missing, one at a time
 *
 * Four things have to be true before the Postgres half can say anything, and
 * they fail in ways that look alike from a stack trace and call for completely
 * different actions. So each is checked and named separately, in the order a
 * reader would fix them. A single "could not connect to the database" would be
 * the empty-result failure in a costume.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { readEnvFile } from './read-env-file';
import { findRepoRoot } from '@aitp/shared';
import { resolveDatabaseUrl } from '../apps/api/src/config/database';

const ROOT = findRepoRoot();
const SCHEMA = path.join(ROOT, 'infra', 'prisma', 'schema.prisma');
const PRISMA_CLI = path.join(ROOT, 'apps', 'api', 'node_modules', 'prisma', 'build', 'index.js');

/** Exit codes, so a caller can tell the four refusals apart without parsing text. */
const EXIT = {
  notConfigured: 10,
  unreachable: 11,
  notMigrated: 12,
  notImplemented: 13,
} as const;

function refuse(code: number, lines: string[]): never {
  console.error(`\nREFUSING: ${lines.join('\n  ')}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const envFile = readEnvFile(path.join(ROOT, '.env'));

  // ── 1. Is there a connection string, and is it usable? ───────────────────────
  //
  // Three answers, not two. NOT CONFIGURED and MALFORMED call for different
  // actions, and neither message may echo the value — it holds a password.
  const resolved = resolveDatabaseUrl(process.env.DATABASE_URL ?? envFile.DATABASE_URL);
  if (resolved.state !== 'configured') {
    refuse(EXIT.notConfigured, [resolved.why]);
  }
  console.log(`\nDatabase:  ${resolved.describe}`);

  // ── 2. Is the server actually there? ─────────────────────────────────────────
  //
  // Separated from step 3 because "nothing is listening" and "the schema is not
  // applied" are a stopped service and an unrun migration — one is `Start-Service`
  // and the other is `pnpm db:deploy`.
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
  console.log(`Reachable: ${hostname}:${port || 5432}`);

  // ── 3. Has the schema been applied? ──────────────────────────────────────────
  //
  // Asked of Prisma rather than by querying information_schema ourselves: Prisma
  // owns the migration ledger, so Prisma is the only thing that can say whether it
  // is up to date. Counting tables would answer a question the output cannot
  // always express (§Z).
  const status = spawnSync(
    process.execPath,
    [PRISMA_CLI, 'migrate', 'status', '--schema', SCHEMA],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: resolved.url },
    },
  );
  const statusText = `${status.stdout ?? ''}\n${status.stderr ?? ''}`;
  if (status.status !== 0) {
    refuse(EXIT.notMigrated, [
      'the schema is not applied, or the ledger could not be read. Prisma said:',
      '',
      ...statusText
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 12),
      '',
      'To apply it:  pnpm db:deploy   (needs MIGRATE_DATABASE_URL — see below)',
    ]);
  }
  console.log('Migrations: up to date');

  // ── 4. Is there anything to run against it? ──────────────────────────────────
  //
  // There is not, yet, and saying so is the point. The Prisma implementations of
  // the six repositories are the remaining half of B1b, and they were deliberately
  // not written while the schema could not be applied: an implementation that has
  // never executed is a stub that cannot falsify itself, and six of them would be
  // six unverified claims.
  //
  // A `test:db` that printed "0 tests passed" here would be the worse outcome —
  // a failed search reported as an empty result.
  refuse(EXIT.notImplemented, [
    'the database is ready and there is nothing to run against it yet.',
    '',
    'The Prisma implementations of the six repositories are the remaining half of',
    'B1b. They were not written while the schema could not be applied, because an',
    'implementation that has never executed is a stub that cannot falsify itself.',
    '',
    'The CONTRACT they must satisfy already exists and passes against the in-memory',
    'implementations: tests/unit/persistence.spec.ts, 9 tests. When the Prisma side',
    'lands, this script runs that same suite against Postgres — one suite, two',
    'implementations, which is the only thing that catches a divergence.',
  ]);
}

void main();
