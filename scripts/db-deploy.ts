#!/usr/bin/env node
/* eslint-disable no-console -- the whole output is one refusal or one line of
   confirmation a human reads before a schema changes. Not a log line. */
/**
 * APPLY THE MIGRATIONS, as the role that is allowed to.
 *
 *   pnpm db:deploy          # reads AITP_DB_OWNER_URL from .env
 *
 * ## Why this is a script and not `prisma migrate deploy`
 *
 * The role in `DATABASE_URL` cannot change the schema, and that is the design
 * rather than an oversight. Measured 2026-10-21 against this installation:
 *
 *   database owner       aitp_owner
 *   public schema owner  pg_database_owner
 *   CREATE on public     f            (for aitp_app, the role in DATABASE_URL)
 *   CREATE TABLE probe   REFUSED: permission denied for schema public
 *
 * §6 needs the audit table granted INSERT and SELECT only, and a role that can
 * CREATE TABLE could drop and recreate it — so the application role must not own
 * the schema. Migrations therefore run as a different role, and this script is
 * where that is said out loud: it requires `AITP_DB_OWNER_URL` and passes it AS
 * `DATABASE_URL` to the one command that needs it.
 *
 * `directUrl` in the schema was tried first and is the idiomatic way to express
 * this. It does not work here: Prisma resolves every datasource `env()` before
 * it will load the schema at all, so a missing owner URL broke `validate`,
 * `generate` and `migrate status` — read-only commands with no business needing
 * a privileged credential.
 *
 * **The grants are in the migration**, applied by it as the owner. They are not
 * printed for a human to run: a grant somebody has to remember is a grant that
 * eventually is not issued, and §6's control is the permission, not the
 * interface.
 *
 * No URL is printed, ever. Output is masked to user@host:port/database.
 * `deploy` is used rather than `dev` on purpose: `dev` wants a shadow database.
 * Migrations are authored offline by `pnpm db:migration`, which needs no
 * connection at all.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { maskDatabaseUrl, resolveDatabaseUrl } from '../apps/api/src/config/database';
import { conflictingEnvKeys, readEnvFile } from './read-env-file';

// `findRepoRoot`, not `import.meta.url`: tsx transpiles these scripts to
// CommonJS, where `import.meta` is a compile error — and every other .ts script
// here resolves the root the same way, so there is one answer to "where is the
// repo" rather than two.
const ROOT = findRepoRoot(__dirname);
const API_DIR = path.join(ROOT, 'apps', 'api');
const ENV_FILE = path.join(ROOT, '.env');
const OWNER_KEY = 'AITP_DB_OWNER_URL';

function refuse(code: number, lines: string[]): never {
  console.error(`\nREFUSING: ${lines.join('\n  ')}\n`);
  process.exit(code);
}

// ── TWO ASSIGNMENTS OF ONE KEY IS A REFUSAL, NOT A TIE-BREAK ────────────────
//
// Found the hard way on 2026-10-21: `AITP_DB_OWNER_URL` was in `.env` twice,
// lines 56 and 58, with different passwords. dotenv and this repo's reader are
// both LAST-WINS — measured, not assumed — and the line that won was the one
// that FAILED authentication, with the working credential sitting two lines
// above it. The symptom is "password authentication failed", which reads as one
// wrong password rather than as two of them.
//
// Picking the one that works would be credential-guessing, and
// `requireApplicationArg` already settles the general case: two sources
// disagreeing have no safe tie-break, so both are named and the run refuses.
const conflicts = conflictingEnvKeys(ENV_FILE);
if (conflicts.length > 0) {
  refuse(13, [
    `${path.basename(ENV_FILE)} assigns the same key more than once, with DIFFERENT values:`,
    '',
    ...conflicts.map((c) => `  ${c.key} on lines ${c.lines.join(' and ')}`),
    '',
    'Both dotenv and this repo read LAST-WINS, so the last one silently decides —',
    'and nothing says the earlier one existed. Delete the line you did not mean.',
    '',
    'No tie-break is applied here on purpose: two sources disagreeing about a',
    'credential is not something a script should resolve by trying them.',
  ]);
}

const envFile = readEnvFile(ENV_FILE);
const ownerRaw = (process.env[OWNER_KEY] ?? envFile[OWNER_KEY])?.trim();
if (!ownerRaw) {
  refuse(10, [
    `${OWNER_KEY} is not set, and DATABASE_URL cannot be used instead.`,
    '',
    'The role in DATABASE_URL owns no schema and cannot create tables — measured',
    'on this installation: `CREATE TABLE` is refused with "permission denied for',
    'schema public". That is deliberate: the migration grants the audit table',
    'INSERT and SELECT only, and a role able to CREATE TABLE could drop and',
    'recreate it.',
    '',
    `Set ${OWNER_KEY} to the OWNER role in .env (which is gitignored):`,
    '',
    `  ${OWNER_KEY}=postgresql://aitp_owner:<password>@127.0.0.1:5432/aitp`,
    '',
    'Then: pnpm db:deploy',
  ]);
}

// Validated through the same three-state resolver the runtime URL uses, so a
// malformed owner URL is a named refusal rather than a Prisma stack trace — and
// the message cannot echo the value, because that resolver never does.
const owner = resolveDatabaseUrl(ownerRaw);
if (owner.state !== 'configured') {
  refuse(11, [`${OWNER_KEY} is set and unusable: ${owner.why.replace('DATABASE_URL', OWNER_KEY)}`]);
}

console.log(`\nApplying as: ${owner.describe}`);

// PASSED, NOT MERGED. The child gets the owner URL as DATABASE_URL for this one
// command; nothing else in this process or any later one sees it, and the owner
// key itself is removed so the child cannot re-read it.
const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: owner.url };
delete env[OWNER_KEY];

const result = spawnSync(
  process.execPath,
  [
    path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js'),
    'migrate',
    'deploy',
    '--schema',
    path.join(API_DIR, 'prisma', 'schema.prisma'),
  ],
  // `cwd: API_DIR`, not the repo root. Prisma resolves its own CLI and the
  // generated client starting from the CWD and the schema's directory, and from
  // the ROOT it finds neither — measured: `prisma generate` answered with
  // `Command failed: pnpm add prisma@6.19.3 -D`, i.e. it tried to install itself
  // at the root, which is exactly where the dependency must not be.
  { cwd: API_DIR, stdio: 'inherit', env },
);

if (result.error) {
  refuse(2, [`could not start Prisma — ${result.error.message}`]);
}

if (result.status === 0) {
  const runtime = resolveDatabaseUrl(process.env.DATABASE_URL ?? envFile.DATABASE_URL);
  console.log(
    [
      '',
      'Applied, grants included — the migration issued them as the owner, so there is',
      'nothing left to run by hand.',
      '',
      `  runtime role: ${runtime.state === 'configured' ? runtime.describe : '(DATABASE_URL not configured)'}`,
      '',
      'Prove it:  pnpm test:db',
      '',
    ].join('\n'),
  );
} else {
  console.error(
    `\nPrisma exited with ${result.status}. The owner URL was ${maskDatabaseUrl(owner.url)}.\n`,
  );
}
process.exit(result.status ?? 1);
