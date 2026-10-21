#!/usr/bin/env node
/* eslint-disable no-console -- the whole output is one refusal or one line of
   confirmation a human reads before a schema changes. Not a log line. */
/**
 * APPLY THE MIGRATIONS, as the role that is allowed to.
 *
 *   MIGRATE_DATABASE_URL=<owner role>  pnpm db:deploy
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
 * where that is said out loud: it requires `MIGRATE_DATABASE_URL` and passes it
 * AS `DATABASE_URL` to the one command that needs it.
 *
 * `directUrl` in the schema was tried first and is the idiomatic way to express
 * this. It does not work here: Prisma resolves every datasource `env()` before
 * it will load the schema at all, so a missing MIGRATE_DATABASE_URL broke
 * `validate`, `generate` and `migrate status` — read-only commands with no
 * business needing a privileged credential.
 *
 * Neither URL is printed. `deploy` is used rather than `dev` on purpose: `dev`
 * wants a shadow database, and the owner role may not have CREATEDB either
 * (aitp_app does not). Migrations are authored offline by `pnpm db:migration`,
 * which needs no connection at all.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { readEnvFile } from './read-env-file';

// `findRepoRoot`, not `import.meta.url`: tsx transpiles these scripts to
// CommonJS, where `import.meta` is a compile error — and every other .ts script
// here resolves the root the same way, so there is one answer to "where is the
// repo" rather than two.
const ROOT = findRepoRoot(__dirname);
const envFile = readEnvFile(path.join(ROOT, '.env'));

const migrateUrl = (process.env.MIGRATE_DATABASE_URL ?? envFile.MIGRATE_DATABASE_URL)?.trim();
if (!migrateUrl) {
  console.error(
    [
      '',
      'REFUSING: MIGRATE_DATABASE_URL is not set, and DATABASE_URL cannot be used instead.',
      '',
      '  The role in DATABASE_URL owns no schema and cannot create tables — measured',
      '  on this installation: `CREATE TABLE` is refused with "permission denied for',
      '  schema public". That is deliberate: §6 grants the audit table INSERT and',
      '  SELECT only, and a role able to CREATE TABLE could drop and recreate it.',
      '',
      '  Set MIGRATE_DATABASE_URL to the OWNER role for one command, in .env (which',
      '  is gitignored) or in the shell:',
      '',
      '    MIGRATE_DATABASE_URL=postgresql://aitp_owner:<password>@127.0.0.1:5432/aitp',
      '',
      '  Then: pnpm db:deploy',
      '',
    ].join('\n'),
  );
  process.exit(10);
}

// PASSED, NOT MERGED. The child gets the owner URL as DATABASE_URL for this one
// command; nothing else in the process or in any later command sees it.
const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: migrateUrl };
delete env.MIGRATE_DATABASE_URL;

const result = spawnSync(
  process.execPath,
  [
    path.join(ROOT, 'apps', 'api', 'node_modules', 'prisma', 'build', 'index.js'),
    'migrate',
    'deploy',
    '--schema',
    path.join(ROOT, 'infra', 'prisma', 'schema.prisma'),
  ],
  { cwd: ROOT, stdio: 'inherit', env },
);

if (result.error) {
  console.error(`\nREFUSING: could not start Prisma — ${result.error.message}\n`);
  process.exit(2);
}

if (result.status === 0) {
  console.log(
    [
      '',
      'Applied. Two grants still have to be issued BY THE OWNER, and nothing in this',
      'repository can issue them — they are what make §6 true:',
      '',
      '  GRANT USAGE ON SCHEMA public TO aitp_app;',
      '  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aitp_app;',
      '  REVOKE UPDATE, DELETE ON "AuditEvent" FROM aitp_app;',
      '',
      'The REVOKE is the control, not the AuditRepository interface. An interface',
      'with no update method is a convention; this is a permission.',
      '',
    ].join('\n'),
  );
}
process.exit(result.status ?? 1);
