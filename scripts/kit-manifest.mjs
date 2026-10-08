#!/usr/bin/env node
/* eslint-disable no-console -- a release/maintenance CLI whose whole output is a
   human-readable audit a maintainer reads before handing over a zip. Not a
   machine-consumable log line, and the same exemption `triage-sheet.ts` carries. */
/**
 * Regenerates `kit-manifest.json` — the hash list the integrity check compares against.
 *
 *   pnpm kit:manifest
 *
 * ## The locked set is DERIVED from git, never listed by hand
 *
 * `git ls-files` is the source: every tracked file is locked except the manifest
 * itself and the QA allow-list. A hand-written list here would be the §AE shape with
 * a verdict attached — a file somebody forgot to add is a file an AI assistant may
 * edit with the check still reporting clean, which is a FALSE PASS and the one
 * direction this must not fail in.
 *
 * ## What is NOT locked, and why each
 *
 * - `kit-manifest.json` — cannot contain its own hash.
 * - `config/apps/<slug>/` for a slug that is not `dms` or `bundled-demo`, and
 *   `config/env/<name>.json` for a name no commit tracks. These are the two things a
 *   QA has to create to add their application, and locking them would mean the kit
 *   refuses as soon as it is used as documented.
 *
 * Everything else tracked is locked, including the docs. A doc is how a QA decides
 * what is safe to do, so an AI that "helpfully" rewrote one would change behaviour
 * without changing code.
 *
 * ## Asserts its own effect
 *
 * Refuses unless it hashed every tracked file it expected to, and unless the result
 * differs from what was there (or `--check` was asked for). A generator that wrote a
 * manifest covering nothing would leave the check reporting "integrity verified
 * (0 files)", which is this repo's oldest bug wearing a lock.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The kit version this manifest describes. Bumped by hand, with the release. */
const KIT_VERSION = '0.4.1';

/**
 * Paths a QA creates, which therefore cannot be locked.
 *
 * `config/apps/` and `config/env/` are locked as PREFIXES for the entries that exist
 * today, so a new file under them is allowed while an extra file under
 * `config/apps/dms/` is not. That asymmetry is the allow-list, expressed as the only
 * thing the checker can act on.
 */
const QA_OWNED = (file) =>
  file === 'kit-manifest.json' ||
  (file.startsWith('config/apps/') &&
    !file.startsWith('config/apps/dms/') &&
    !file.startsWith('config/apps/bundled-demo/')) ||
  (file.startsWith('config/env/') && !TRACKED_ENV_FILES.has(file));

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

/** The same normalisation `integrity.ts` applies. Two copies would drift into a lie. */
function hashFile(absolute) {
  const raw = readFileSync(absolute);
  const binary = BINARY_EXTENSIONS.has(path.extname(absolute).toLowerCase());
  const bytes = binary ? raw : Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const tracked = git('ls-files')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (tracked.length < 100) {
  console.error(
    `refusing: git ls-files returned ${tracked.length} file(s), which is not this repo. ` +
      'A manifest built from a partial listing would lock almost nothing and report clean.',
  );
  process.exit(2);
}

const TRACKED_ENV_FILES = new Set(tracked.filter((f) => f.startsWith('config/env/')));

const locked = tracked.filter((file) => !QA_OWNED(file)).sort();

/**
 * The locked PREFIXES, derived from the locked files rather than typed.
 *
 * Top-level directories, plus the two `config/` paths that are locked while their
 * siblings are not. These are what the checker walks to find an ADDED file, which a
 * hash list cannot see.
 */
const prefixes = new Set();
for (const file of locked) {
  const top = file.split('/')[0];
  if (!file.includes('/')) {
    prefixes.add(file);
    continue;
  }
  if (top === 'config') {
    prefixes.add(file.startsWith('config/env/') ? file : file.split('/').slice(0, 3).join('/'));
    continue;
  }
  prefixes.add(top);
}

const files = {};
for (const file of locked) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute)) {
    console.error(
      `refusing: ${file} is tracked by git and not on disk. The working tree and the ` +
        'index disagree, so a manifest from it would describe neither.',
    );
    process.exit(2);
  }
  files[file] = hashFile(absolute);
}

if (Object.keys(files).length !== locked.length) {
  console.error('refusing: hashed a different number of files than were locked.');
  process.exit(2);
}

const manifest = {
  kitVersion: KIT_VERSION,
  commit: git('rev-parse', 'HEAD'),
  generatedAt: new Date().toISOString(),
  lockedPrefixes: [...prefixes].sort(),
  files,
};

// Written with LF and a trailing newline, and NOT formatted by prettier — the file is
// in `.prettierignore` because reformatting it would change its own bytes, and
// `format:check` would then fail on a file nobody edited.
const text = `${JSON.stringify(manifest, null, 2)}\n`;
const target = path.join(ROOT, 'kit-manifest.json');

if (process.argv.includes('--check')) {
  /**
   * COMPARES WHAT THE MANIFEST CLAIMS ABOUT THE TREE, not the whole file.
   *
   * `commit` and `generatedAt` change on every run — `commit` is the HEAD the
   * manifest was generated FROM, so it is one behind by construction: the release
   * flow regenerates, then commits. A byte comparison therefore reports STALE
   * immediately after every release commit, which would make `kit:release` unable
   * to pass and would train somebody to ignore the word.
   *
   * The question worth asking is whether the hash list still describes this tree, so
   * that is the question asked: kitVersion, lockedPrefixes and files.
   */
  const describes = (m) =>
    JSON.stringify({ kitVersion: m.kitVersion, lockedPrefixes: m.lockedPrefixes, files: m.files });
  let current = null;
  try {
    current = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    current = null;
  }
  if (current && describes(current) === describes(manifest)) {
    console.log(`kit-manifest.json is current — ${locked.length} locked file(s).`);
    process.exit(0);
  }
  console.error(
    'kit-manifest.json is STALE. Run `pnpm kit:manifest` and commit the result.\n' +
      '  Until then every QA-facing command refuses on a clean clone, which is the ' +
      'check working rather than a bug.',
  );
  process.exit(1);
}

writeFileSync(target, text, 'utf8');
console.log(
  `kit-manifest.json written: kit v${KIT_VERSION}, ${locked.length} locked file(s), ` +
    `${prefixes.size} locked prefix(es), commit ${manifest.commit.slice(0, 7)}.`,
);
console.log(`  not locked (QA-owned): ${tracked.length - locked.length} tracked file(s).`);
