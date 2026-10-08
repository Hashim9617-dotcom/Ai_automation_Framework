import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * TAMPER-EVIDENT, FAIL-CLOSED. Not tamper-proof, and the difference is the whole
 * design.
 *
 * Three QAs run this kit on their own laptops, with an AI assistant that can edit
 * files. Nothing stopping a determined person editing code on a machine they own is
 * achievable, and claiming otherwise in a message would be the worst outcome: a QA
 * would trust a modified kit because the tool said it was locked.
 *
 * So the goal is narrower and actually reachable: **a modified kit must never produce
 * a pass.** Every command that touches the customer application or the QA's sheet
 * checks this first, and any difference refuses with the file named.
 *
 * ## Why fail-closed, and what "closed" means here
 *
 * A missing or unreadable manifest REFUSES. The alternative — carry on when the
 * manifest cannot be read — makes deleting one file the way to turn the check off,
 * which is a lock with its own key taped to it. It is the same reasoning as §AC:
 * ambiguity resolves toward refusal, never toward the reading that can pass.
 *
 * ## Why hashes are taken after CRLF normalisation
 *
 * `.gitattributes` pins `* text=auto eol=lf`, so a Windows clone and a `git archive`
 * extraction both land LF — measured byte-exact on this repo: 0 CRLF in the working
 * tree. That makes normalisation belt-and-braces rather than load-bearing, and it
 * stays because the failure it prevents is the worst kind of false alarm: a QA whose
 * unzip tool or editor rewrote line endings would be told their kit was modified when
 * nothing about it changed, and the message tells them to re-extract — which would not
 * help. A line-ending difference is not a modification.
 *
 * Binary files are hashed raw. Normalising a PNG would corrupt the comparison.
 *
 * ## Injected inputs, because a guard that reads its own environment tests the machine
 *
 * `root` and `markerPath` are arguments, never resolved in here (§AJ). Four guards in
 * this repo were green on a configured machine and red on a clean checkout, and every
 * one of them read an environment it had not supplied. The tests below hand this
 * fixture directories, so they give the same answer whether or not the maintainer's
 * marker exists on the machine running them.
 */

/** Hashed raw. Everything else is normalised first. */
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
 * Directory names skipped while looking for UNLISTED files inside a locked path.
 *
 * Measured, not guessed: `git status --ignored` reports exactly two kinds of ignored
 * path inside the locked directories — `node_modules/` under each package and
 * `apps/api/dist/`. Both are build output that every install and build recreates, so
 * treating them as tampering would refuse on a freshly-installed clean kit.
 *
 * This is a hand-written list inside a locked path, which is the §AE shape. It is
 * acceptable here because the worst a missing entry can do is a FALSE REFUSAL — loud,
 * immediate, and named — never a false pass. An extra entry is the dangerous
 * direction, so the list is kept to names that cannot plausibly hold framework code
 * and the test below plants a file in each.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);

/** Files skipped for the same reason: regenerated, never authored. */
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIPPED_SUFFIXES = ['.tsbuildinfo'];

export interface KitManifest {
  /** `0.4` — the kit version, stamped into every report a run writes. */
  kitVersion: string;
  /** The commit the manifest was generated from. Recorded, never checked here. */
  commit: string;
  generatedAt: string;
  /**
   * Directory prefixes and exact files that are LOCKED.
   *
   * Needed in addition to `files`, because a hash list can only notice a file that
   * CHANGED or VANISHED. An ADDED file — a new module under `packages/`, a second
   * module map under `config/apps/dms/` — matches no hash and would otherwise be
   * invisible, which is the easiest possible way to modify the kit.
   */
  lockedPrefixes: string[];
  /** Repo-relative POSIX path -> sha256. The path is the key, so order cannot matter. */
  files: Record<string, string>;
}

/** What is wrong with one locked file. `unlisted` is the added-file case. */
export interface KitProblem {
  file: string;
  why: 'changed' | 'missing' | 'unlisted';
}

export type KitIntegrity =
  | { ok: true; skipped: 'maintainer'; files: 0 }
  | { ok: true; skipped: false; files: number; kitVersion: string; commit: string }
  | {
      ok: false;
      /** Why, as a code, so a caller can distinguish without reading prose. */
      reason: 'manifest-missing' | 'manifest-unreadable' | 'files-differ';
      /** Repo-relative paths, sorted, with what is wrong with each. */
      problems: KitProblem[];
      detail: string;
    };

/** Text normalised to LF; binaries raw. One expression, used by generator and checker. */
export function hashKitFile(absolute: string): string {
  const raw = readFileSync(absolute);
  const binary = BINARY_EXTENSIONS.has(path.extname(absolute).toLowerCase());
  const bytes = binary ? raw : Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

const skip = (name: string): boolean =>
  SKIPPED_FILES.has(name) || SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));

/** Every file under one locked prefix, as repo-relative POSIX paths. */
export function filesUnderPrefix(root: string, prefix: string): string[] {
  const absolute = path.join(root, prefix);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return skip(path.basename(prefix)) ? [] : [prefix];

  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
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

export interface KitIntegrityOptions {
  /** The kit root. An argument, never resolved here (§AJ). */
  root: string;
  /**
   * The maintainer marker. Present -> the check is skipped with a visible banner.
   *
   * A FILE and not an environment variable, deliberately, and the reasoning is
   * `ALLOW_WRITES`'s: a variable can be set by anything that can set a variable —
   * a shell profile, a CI step, an AI agent running a command — and none of those
   * leave a trace a reader can check afterwards. The marker is gitignored, so it
   * cannot travel in a clone or a `git archive`, which `kit:release` asserts.
   *
   * Injected so the tests can hand a path that does not exist, and give the same
   * answer on the maintainer's machine as on a clean checkout.
   */
  markerPath: string;
}

export function verifyKitIntegrity(options: KitIntegrityOptions): KitIntegrity {
  // MAINTAINER MODE FIRST, because it is the only thing that can skip, and a reader
  // needs to know that is what happened before any other explanation.
  if (existsSync(options.markerPath)) return { ok: true, skipped: 'maintainer', files: 0 };

  const manifestPath = path.join(options.root, 'kit-manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      reason: 'manifest-missing',
      problems: [{ file: 'kit-manifest.json', why: 'missing' }],
      detail: 'kit-manifest.json is not there, so nothing can be checked against it.',
    };
  }

  let manifest: KitManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as KitManifest;
    if (
      typeof manifest.kitVersion !== 'string' ||
      !Array.isArray(manifest.lockedPrefixes) ||
      typeof manifest.files !== 'object' ||
      manifest.files === null
    ) {
      throw new Error('kit-manifest.json does not have the expected shape');
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'manifest-unreadable',
      problems: [{ file: 'kit-manifest.json', why: 'changed' }],
      detail: `kit-manifest.json could not be read: ${(error as Error).message}`,
    };
  }

  const problems: KitProblem[] = [];

  // 1. EVERY LISTED FILE IS THERE AND UNCHANGED.
  for (const [file, expected] of Object.entries(manifest.files)) {
    const absolute = path.join(options.root, file);
    if (!existsSync(absolute)) {
      problems.push({ file, why: 'missing' });
      continue;
    }
    if (hashKitFile(absolute) !== expected) problems.push({ file, why: 'changed' });
  }

  // 2. NOTHING EXTRA INSIDE A LOCKED PATH. A hash list cannot see an ADDED file, and
  //    adding one is the easiest way to change what the kit does.
  const listed = new Set(Object.keys(manifest.files));
  for (const prefix of manifest.lockedPrefixes) {
    for (const file of filesUnderPrefix(options.root, prefix)) {
      if (!listed.has(file)) problems.push({ file, why: 'unlisted' });
    }
  }

  if (problems.length > 0) {
    problems.sort((a, b) => a.file.localeCompare(b.file));
    return {
      ok: false,
      reason: 'files-differ',
      problems,
      detail: `${problems.length} locked file(s) differ from the manifest.`,
    };
  }

  return {
    ok: true,
    skipped: false,
    files: Object.keys(manifest.files).length,
    kitVersion: manifest.kitVersion,
    commit: manifest.commit,
  };
}

/**
 * The sentence a QA reads. Written here so all five commands say the same thing.
 *
 * It tells them NOT to fix it, because the realistic failure is an AI assistant
 * offering to — and a QA accepting, because the offer looks helpful and the refusal
 * looks like a bug.
 */
export function describeKitRefusal(result: Extract<KitIntegrity, { ok: false }>): string {
  const lines = [
    'KIT MODIFIED — refusing to run.',
    '',
    result.detail,
    '',
    ...result.problems.slice(0, 40).map((p) => `  ${p.why.padEnd(9)} ${p.file}`),
    ...(result.problems.length > 40 ? [`  …and ${result.problems.length - 40} more`] : []),
    '',
    'This kit has been modified. Do not fix it. Re-extract the original zip and copy',
    'back only your config/apps/<slug>/, config/env/<file>.json and .env — or contact',
    'Hashim.',
  ];
  return lines.join('\n');
}

/**
 * The one line every clean run prints, and the stamp that goes into a report.
 *
 * A run whose report does not carry this was produced by something that did not
 * check, which is a different claim from "the check passed".
 */
export function describeKitIntegrity(result: KitIntegrity): string {
  if (!result.ok) return 'KIT MODIFIED';
  if (result.skipped === 'maintainer') return 'MAINTAINER MODE — integrity check skipped';
  return `Kit v${result.kitVersion} — integrity verified (${result.files} files)`;
}

/**
 * What each QA-facing command calls, FIRST — before reading `.env`, before resolving
 * an environment, before launching a browser.
 *
 * The order is the point. A modified kit must not get as far as reading a credential
 * or opening the customer's application, so this cannot sit after the argument
 * parsing that happens to be convenient. The CLI test asserts the order by running a
 * command in a directory with no `.env` at all and checking which refusal comes back.
 *
 * Throws on failure rather than exiting, so the caller's `main().catch()` prints it
 * as a refusal and not as a crash — the shape every CLI here was corrected to.
 *
 * **No parameter, variable, flag or request body can skip it.** `markerPath` is a
 * path the caller computes from the repo root; there is nothing to pass that turns
 * the check off, which is `ALLOW_WRITES`'s rule applied to a different switch.
 */
export function assertKitIntegrity(options: {
  root: string;
  markerPath: string;
  /** Injected so a test can capture the banner instead of the process's stdout. */
  write?: (line: string) => void;
}): KitIntegrity {
  const result = verifyKitIntegrity({ root: options.root, markerPath: options.markerPath });
  if (!result.ok) throw new Error(describeKitRefusal(result));
  (options.write ?? ((line: string) => process.stdout.write(line)))(
    `${describeKitIntegrity(result)}\n`,
  );
  return result;
}

/** Where the maintainer marker lives, given a root. One expression, every caller. */
export const maintainerMarkerPath = (root: string): string => path.join(root, '.aitp-maintainer');
