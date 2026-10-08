#!/usr/bin/env node
/* eslint-disable no-console -- a release/maintenance CLI whose whole output is a
   human-readable audit a maintainer reads before handing over a zip. Not a
   machine-consumable log line, and the same exemption `triage-sheet.ts` carries. */
/**
 * Builds a QA kit zip, and PROVES it before handing it over.
 *
 *   pnpm kit:release            # from the current tag
 *   pnpm kit:release --tag qa-kit-v0.4
 *
 * ## Why this is a script and not a list of steps in a document
 *
 * Six steps have to happen in one order, and three of them are assertions nobody
 * would run by hand every time. A document describing them is a document somebody
 * follows four times out of five — and the fifth zip is the one that ships with a
 * `.env` in it.
 *
 * ## What it does, in order
 *
 * 1. Refuses on a dirty tree. A zip built from uncommitted work describes a commit
 *    that does not contain it, and `kit-manifest.json` would then be a hash list for
 *    files nobody can get back.
 * 2. Refuses unless `kit-manifest.json` is current (`kit:manifest --check`).
 * 3. `git archive` from the tag, written OUTSIDE the repo. `git archive` takes the
 *    COMMIT, so `.git/` and every gitignored file — `.env`, `artifacts/`,
 *    `.aitp-maintainer` — cannot be in it by construction rather than by a filter
 *    somebody maintains.
 * 4. AUDITS the zip's entry list: refuses if anything secret is in it, and refuses if
 *    anything the kit needs is missing. Both directions, because a zip that is merely
 *    missing nothing could still be missing the lock files that make it a kit.
 * 5. Extracts it to a temp directory and runs the integrity check there: must PASS.
 * 6. Changes one byte of a locked file in that extraction and runs the check again:
 *    must REFUSE. Then deletes the temp directory.
 *
 * Step 6 is the one that matters most. Steps 1–5 all pass for a kit whose integrity
 * check does nothing at all, and "the check passed" is the easiest possible false
 * positive — a criterion satisfied by knowing nothing. The tamper half is the only
 * evidence the lock is load-bearing in the artifact actually being shipped.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.KIT_RELEASE_DIR ?? path.join(path.dirname(ROOT), 'qa-kit-release');

/** Run inside a tsx child against `KIT_VERIFY_ROOT`. Prints `OK …` or `REFUSED …`. */
const VERIFY_SNIPPET = `
import { verifyKitIntegrity, describeKitIntegrity } from '@aitp/execution-engine';
import path from 'node:path';
const root = process.env.KIT_VERIFY_ROOT;
const result = verifyKitIntegrity({ root, markerPath: path.join(root, '.aitp-maintainer') });
process.stdout.write(result.ok ? 'OK ' + describeKitIntegrity(result) : 'REFUSED ' + result.detail);
`;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const die = (message) => {
  console.error(`refusing: ${message}`);
  process.exit(1);
};

/** MUST NOT be in the zip. Each is a secret, a credential, or a lock bypass. */
const FORBIDDEN = [
  {
    label: '.env (any)',
    test: (f) => f === '.env' || (f.startsWith('.env.') && f !== '.env.example'),
  },
  { label: '.aitp-maintainer', test: (f) => f === '.aitp-maintainer' },
  { label: 'artifacts/', test: (f) => f.startsWith('artifacts/') },
  { label: 'scratch/', test: (f) => f.startsWith('scratch/') },
  { label: 'a workbook (*.xlsx/*.xls)', test: (f) => /\.xlsx?$/i.test(f) },
  { label: 'a trace.zip', test: (f) => f.endsWith('trace.zip') },
  { label: 'a saved session (**/auth/*.json)', test: (f) => /(^|\/)auth\/.*\.json$/.test(f) },
  { label: '.git/', test: (f) => f.startsWith('.git/') },
  { label: 'node_modules/', test: (f) => f.includes('node_modules/') },
];

/** MUST be in the zip. A kit without these is not locked and cannot be run. */
const REQUIRED = [
  '.cursorignore',
  '.cursor/rules/qa-kit-lock.mdc',
  'AGENTS.md',
  'kit-manifest.json',
  '.env.example',
  'package.json',
  'docs/QA-QUICKSTART.md',
  'docs/ADD-AN-APPLICATION.md',
  'docs/WRITING-STEPS.md',
];

// ---- 1. a clean tree ----
if (git('status', '--porcelain') !== '') {
  die(
    'the working tree is not clean. A zip built from uncommitted work describes a commit ' +
      'that does not contain it.\n  Commit or stash first, then run this again.',
  );
}

// ---- 2. a current manifest ----
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'kit-manifest.mjs'), '--check'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch {
  die('kit-manifest.json is stale. Run `pnpm kit:manifest`, commit it, then release.');
}

const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex > 0 ? process.argv[tagIndex + 1] : git('describe', '--tags', '--exact-match');
if (!tag) die('no tag. Pass --tag <name>, or tag the release commit first.');

const version = JSON.parse(readFileSync(path.join(ROOT, 'kit-manifest.json'), 'utf8')).kitVersion;

// ---- 3. git archive, OUTSIDE the repo ----
mkdirSync(OUT_DIR, { recursive: true });
const zip = path.join(OUT_DIR, `qa-kit-v${version}.zip`);
if (existsSync(zip)) rmSync(zip);
git('archive', '--format=zip', `--output=${zip}`, tag);
console.log(`\nzip:  ${zip}`);

// ---- 4. audit the entry list, BOTH directions ----
/**
 * The zip's entry names, read from its own central directory.
 *
 * NOT `tar -tf`, which is what this used and which fails on Windows: GNU tar reads
 * `C:\Users\…` as a remote host and answers "Cannot connect to C: resolve failed".
 * Found by running the release flow, not by reading it. A zip's central directory is
 * four fields and a loop, and parsing it here takes a platform dependency out of the
 * one script whose whole job is to be trustworthy on the maintainer's machine.
 */
function zipEntries(file) {
  const buffer = readFileSync(file);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) die(`${file} has no zip end-of-central-directory record.`);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) die('malformed zip central directory');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    // A directory entry ends in a slash; the audit compares plain paths.
    names.push(name.endsWith('/') ? name.slice(0, -1) : name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  // Asserts its own effect: a reader that found nothing would make every audit below
  // vacuously clean, which is the worst possible false pass in this file.
  if (names.length !== count) die('read a different number of entries than the zip declares');
  if (names.length === 0) die('the zip has no entries');
  return names;
}

const entries = zipEntries(zip);

console.log(`      ${entries.length} entries`);

const found = [];
for (const rule of FORBIDDEN) {
  const hits = entries.filter((entry) => rule.test(entry));
  console.log(
    `  ${hits.length === 0 ? 'NO ' : '** '} ${rule.label}${hits.length ? `: ${hits.slice(0, 5).join(', ')}` : ''}`,
  );
  if (hits.length > 0) found.push(rule.label);
}
if (found.length > 0) die(`the zip contains ${found.join(', ')}. It must not be handed over.`);

const missing = REQUIRED.filter((file) => !entries.includes(file));
for (const file of REQUIRED)
  console.log(`  ${missing.includes(file) ? '** MISSING' : 'YES      '} ${file}`);
if (missing.length > 0) die(`the zip is missing ${missing.join(', ')}.`);

// ---- 5. the extracted copy must PASS ----
const temp = mkdtempSync(path.join(tmpdir(), 'qa-kit-verify-'));
try {
  // Expand-Archive rather than tar, for the same Windows path reason as above.
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${temp}' -Force`,
    ],
    { stdio: 'pipe' },
  );

  const check = (where, expect) => {
    // The extracted kit's OWN copy of the checker, run as a child so nothing from this
    // process's module cache or environment can influence the answer.
    const script = path.join(temp, 'scripts', 'kit-manifest.mjs');
    if (!existsSync(script)) die('the extracted kit has no scripts/kit-manifest.mjs');
    const result = execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '-e', VERIFY_SNIPPET],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KIT_VERIFY_ROOT: where } },
    ).trim();
    const ok = result.startsWith('OK');
    console.log(
      `  ${ok === expect ? 'as expected' : '** WRONG   '}  ${where === temp ? 'extracted' : where}: ${result.split('\n')[0]}`,
    );
    return ok === expect;
  };

  console.log('\nextracted copy:');
  if (!check(temp, true)) die('the extracted kit FAILED its own integrity check.');

  // ---- 6. one byte changed must REFUSE ----
  const victim = path.join(temp, 'packages', 'shared', 'src', 'index.ts');
  if (!existsSync(victim)) die('expected packages/shared/src/index.ts in the extraction');
  writeFileSync(victim, `${readFileSync(victim, 'utf8')}\n// tampered by kit:release\n`);
  console.log('tampered copy (one line added to packages/shared/src/index.ts):');
  if (!check(temp, false)) {
    die(
      'a TAMPERED kit still passed its integrity check. The lock is not load-bearing in ' +
        'this zip and it must not be handed over.',
    );
  }

  console.log(`\nqa-kit-v${version}.zip is clean, complete, verified and tamper-evident.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
