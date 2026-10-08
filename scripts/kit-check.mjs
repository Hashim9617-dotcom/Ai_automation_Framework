#!/usr/bin/env node
/* eslint-disable no-console -- the entire output of this script is one line a human
   reads before a command runs, or a refusal they act on. Not a log line. */
/**
 * THE KIT INTEGRITY CHECK, STANDALONE. Node built-ins only.
 *
 *   node scripts/kit-check.mjs
 *
 * Every QA-facing `pnpm` script runs this FIRST, before `tsx`, before
 * `playwright`, before any workspace package is resolved.
 *
 * ## Why this file exists separately from `packages/execution-engine/src/kit/integrity.ts`
 *
 * **The check must not depend on what it protects.** Measured by hand on an
 * extracted `qa-kit-v0.4.zip`, and reproduced here before this file was written:
 * renaming `packages/execution-engine` to `packages/execution-engineer` made
 * `pnpm auth` die with
 *
 *     Error: Cannot find module '@aitp/execution-engine'
 *     code: 'MODULE_NOT_FOUND'
 *
 * — no `KIT MODIFIED`, no banner, no named path. The check lived inside that
 * package and every QA script imported it from there, so module resolution failed
 * before a single line of check code was evaluated.
 *
 * It failed CLOSED, which is the half that was right. But the message is cryptic,
 * and a cryptic message is the one that invites a QA's AI assistant to "fix" it —
 * `pnpm install`, rename the folder back, restore from somewhere. That is the exact
 * sequence the lock exists to prevent, triggered by the lock's own failure mode.
 *
 * So this file imports NOTHING but `node:crypto`, `node:fs`, `node:path` and
 * `node:url`. It needs no `node_modules`, no `tsx`, no build step, and no part of
 * the kit other than itself and `kit-manifest.json`. A test proves that by running
 * it with `node_modules` renamed away.
 *
 * ## What this cannot protect, stated rather than implied
 *
 * **If `scripts/kit-check.mjs` is itself deleted, nothing here can print anything.**
 * `node` will say `Cannot find module …kit-check.mjs` and the `&&` chain stops, so
 * the QA command still does not run — fail-closed — but the message is Node's, not
 * ours. That case is documented in `docs/QA-QUICKSTART.md` and in `AGENTS.md` as
 * "any error mentioning Cannot find module right after extraction means the kit is
 * damaged: re-extract, do not repair". Pretending it is handled would be worse than
 * naming it.
 *
 * The in-engine check stays where it is, as a second line of defence: it runs
 * inside the process that is about to drive a browser, after this one has run in a
 * process that has already exited.
 *
 * ## The three copies of the hash rule, and why that is not drift waiting to happen
 *
 * This file, `kit-manifest.mjs` and `integrity.ts` each normalise CRLF and hash. A
 * hand-maintained triplicate is the §AE shape, so it is not maintained by hand:
 * `kit-check-standalone.spec.ts` runs this script and the in-engine check over the
 * same fixture kit and asserts they reach the same verdict and name the same files,
 * on a clean tree and on a tampered one. They cannot drift silently.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The kit root is THIS FILE'S OWN LOCATION, and nothing can redirect it.
 *
 * No `AITP_REPO_ROOT`, no argument, no environment variable — the same reasoning
 * as `ALLOW_WRITES` and the maintainer marker. A root that can be pointed
 * elsewhere is a check that can be pointed at a kit nobody is about to run.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hashed raw. Normalising a PNG would corrupt the comparison. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.xlsx',
  '.xls',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

/**
 * Build output inside a locked path. Measured with `git status --ignored`: these are
 * the only ignored paths that sit inside the locked directories.
 *
 * The worst a missing entry can do here is a FALSE REFUSAL — loud, named, and on a
 * freshly installed kit. An extra entry is the dangerous direction, so the list
 * holds only names that cannot plausibly carry framework code.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIPPED_SUFFIXES = ['.tsbuildinfo'];

const skip = (name) =>
  SKIPPED_FILES.has(name) || SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));

function hashFile(absolute) {
  const raw = readFileSync(absolute);
  const binary = BINARY_EXTENSIONS.has(path.extname(absolute).toLowerCase());
  const bytes = binary ? raw : Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file under one locked prefix, as repo-relative POSIX paths. */
function filesUnderPrefix(prefix) {
  const absolute = path.join(ROOT, prefix);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return skip(path.basename(prefix)) ? [] : [prefix];

  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(`${relative}/${entry.name}`);
        continue;
      }
      if (skip(entry.name)) continue;
      found.push(`${relative}/${entry.name}`);
    }
  };
  walk(prefix);
  return found;
}

/** The sentence a QA reads. Identical wording to the in-engine check, on purpose. */
function refuse(detail, problems) {
  const lines = [
    '',
    'KIT MODIFIED — refusing to run.',
    '',
    detail,
    '',
    ...problems.slice(0, 40).map((p) => `  ${p.why.padEnd(9)} ${p.file}`),
    ...(problems.length > 40 ? [`  …and ${problems.length - 40} more`] : []),
    '',
    'This kit has been modified. Do not fix it. Re-extract the original zip and copy',
    'back only your config/apps/<slug>/, config/env/<file>.json and .env — or contact',
    'Hashim.',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}

// MAINTAINER MODE FIRST, because it is the only thing that can skip, and a reader
// needs to know that is what happened before any other explanation.
if (existsSync(path.join(ROOT, '.aitp-maintainer'))) {
  console.log('MAINTAINER MODE — integrity check skipped');
  process.exit(0);
}

const manifestPath = path.join(ROOT, 'kit-manifest.json');
if (!existsSync(manifestPath)) {
  refuse('kit-manifest.json is not there, so nothing can be checked against it.', [
    { file: 'kit-manifest.json', why: 'missing' },
  ]);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    typeof manifest.kitVersion !== 'string' ||
    !Array.isArray(manifest.lockedPrefixes) ||
    typeof manifest.files !== 'object' ||
    manifest.files === null
  ) {
    throw new Error('kit-manifest.json does not have the expected shape');
  }
} catch (error) {
  refuse(`kit-manifest.json could not be read: ${error.message}`, [
    { file: 'kit-manifest.json', why: 'changed' },
  ]);
}

const problems = [];

// 1. EVERY LISTED FILE IS THERE AND UNCHANGED.
//
// This is also what catches a RENAMED directory, which is what v0.4 could not
// report: renaming `packages/execution-engine` makes every file it held `missing`,
// and every file at its new name `unlisted` below. Both halves are named.
for (const [file, expected] of Object.entries(manifest.files)) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute)) {
    problems.push({ file, why: 'missing' });
    continue;
  }
  if (hashFile(absolute) !== expected) problems.push({ file, why: 'changed' });
}

// 2. NOTHING EXTRA INSIDE A LOCKED PATH. A hash list cannot see an ADDED file, and
//    a renamed directory arrives here as a tree full of them.
const listed = new Set(Object.keys(manifest.files));
for (const prefix of manifest.lockedPrefixes) {
  for (const file of filesUnderPrefix(prefix)) {
    if (!listed.has(file)) problems.push({ file, why: 'unlisted' });
  }
}

if (problems.length > 0) {
  problems.sort((a, b) => a.file.localeCompare(b.file));
  refuse(`${problems.length} locked file(s) differ from the manifest.`, problems);
}

console.log(`Kit v${manifest.kitVersion} — integrity verified (${listed.size} files)`);
