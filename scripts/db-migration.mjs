#!/usr/bin/env node
/* eslint-disable no-console -- the output is one path a human then reviews. */
/**
 * AUTHOR A MIGRATION, with no database connection at all.
 *
 *   pnpm db:migration <name>
 *
 * `prisma migrate diff --from-empty` compares an empty datamodel to the schema
 * file, so it needs no server, no credential and no shadow database. That is why
 * it is used here instead of `migrate dev`:
 *
 *  - `migrate dev` wants a SHADOW DATABASE, and neither role on this
 *    installation has CREATEDB (measured: `rolcreatedb = f` for aitp_app);
 *  - the SQL is written to a file and reviewed BEFORE anything is granted, which
 *    matters when the thing being reviewed is the first schema a security layer
 *    will live in.
 *
 * ## It asserts its own effect
 *
 * A generator that reported a path and wrote nothing is this repo's oldest rule.
 * So this checks the file exists, is non-empty, and contains at least one
 * `CREATE TABLE` before it says anything succeeded — and refuses rather than
 * overwrite an existing migration, because a migration already applied
 * somewhere must never change underneath it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const SCHEMA = path.join(API_DIR, 'prisma', 'schema.prisma');

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error(
    '\nusage: pnpm db:migration <name>\n' +
      '  <name> is lower-case letters, digits and underscores — it becomes a directory name.\n',
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const dir = path.join(API_DIR, 'prisma', 'migrations', `${stamp}_${name}`);
const file = path.join(dir, 'migration.sql');

if (existsSync(file)) {
  console.error(`\nREFUSING: ${path.relative(ROOT, file)} already exists.\n`);
  process.exit(3);
}

// `--from-empty` and `--to-schema-datamodel` are both offline. No URL is read,
// so this works before any credential exists.
const result = spawnSync(
  process.execPath,
  [
    path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js'),
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    SCHEMA,
    '--script',
  ],
  // From apps/api, where prisma is a dependency. From the root it tries to
  // install itself there — measured.
  { cwd: API_DIR, encoding: 'utf8' },
);

if (result.status !== 0) {
  console.error(`\nREFUSING: prisma migrate diff failed.\n\n${result.stderr ?? ''}\n`);
  process.exit(4);
}

mkdirSync(dir, { recursive: true });
writeFileSync(file, result.stdout ?? '', 'utf8');

// ASSERTS ITS OWN EFFECT, before reporting success.
const landed = existsSync(file) ? readFileSync(file, 'utf8') : '';
const tables = (landed.match(/^CREATE TABLE/gm) ?? []).length;
if (tables === 0) {
  console.error(
    `\nREFUSING: wrote ${path.relative(ROOT, file)} and it contains no CREATE TABLE.\n` +
      '  An empty migration reported as written is worse than a failure.\n',
  );
  process.exit(5);
}

console.log(
  `\n${path.relative(ROOT, file).split(path.sep).join('/')}\n` +
    `  ${landed.split(/\r?\n/).length} line(s), ${tables} table(s). Review it, then: pnpm db:deploy\n`,
);
