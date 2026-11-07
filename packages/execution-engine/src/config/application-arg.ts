import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ambientEnvName, loadEnvironment, repoRoot } from './environment';
import type { EnvironmentConfig } from './schema';

/**
 * `--app <application>` for a NON-INTERACTIVE tool, and the one refusal that goes
 * with it.
 *
 * ## Why the application is an argument and not an environment variable
 *
 * Nobody is watching a non-interactive tool resolve a target, and its output — a
 * ceiling that gets quoted, a report that gets sent — is about one application's
 * sheet paired against that application's captures. An ambient `TEST_ENV` deciding
 * that silently is SEC-2's shape: the thing that chooses where the work points must
 * not come from the layer that can redirect it without anyone looking.
 *
 * So the application is an argument. If an environment is ALSO set and names a
 * different application, both are printed and the run refuses — two sources
 * disagree and there is no safe tie-break, the same reasoning as the clause-kind
 * column.
 *
 * ## Why this is a function and not a convention
 *
 * It was written once in `scripts/triage-sheet.ts` and `pnpm run-sheet` needed the
 * same thing. A second copy of a refusal is the §AE shape with a verdict attached:
 * two implementations of "which application is this" drift, and a drifted refusal
 * reads identically to a correct one. Both callers use this, which is also what
 * makes the extraction provable — one caller proves nothing about a shared rule.
 */
export interface ApplicationArgOptions {
  /** `process.argv`, passed in so a test does not have to mutate the real one. */
  argv: readonly string[];
  /** Printed verbatim when `--app` is absent. The caller knows its own usage. */
  usage: string;
}

export function requireApplicationArg(options: ApplicationArgOptions): string {
  const index = options.argv.indexOf('--app');
  const application = index > 0 ? options.argv[index + 1] : undefined;

  // A flag with nothing after it is not a value. `--app --out x` would otherwise
  // make the application `--out`, which then fails much later as a missing config
  // file and reads as a different problem entirely.
  if (!application || application.startsWith('--')) {
    throw new Error(
      `${options.usage}\n` +
        '  --app is required: this tool pairs ONE application against that ' +
        "application's captures and config, and nothing else should decide which.",
    );
  }

  const ambient = ambientEnvName();
  if (ambient) {
    const ambientApplication = loadEnvironment(ambient).application;
    if (ambientApplication !== application) {
      throw new Error(
        `refusing to run: --app says "${application}" and TEST_ENV="${ambient}" is configured ` +
          `for application "${ambientApplication}". Two sources disagree about which ` +
          'application this is, and there is no safe tie-break.\n' +
          `  Pass --app ${ambientApplication}, or unset TEST_ENV.`,
      );
    }
  }

  return application;
}

/** Where the environment files live. One expression, so nothing builds it by hand. */
export function envConfigDir(): string {
  return path.join(repoRoot(), 'config', 'env');
}

/**
 * Which environments declare an application — DERIVED from the files, never a list.
 *
 * `configDir` is PASSED IN and never computed here (§AJ). A function that reached
 * for `repoRoot()` itself would be testing this machine's `config/env/`, and every
 * assertion about "two environments declare this app" would depend on which files
 * happen to be on disk. The caller that wants the real directory asks
 * `envConfigDir()` for it.
 *
 * Returns sorted names. A file that is not readable JSON, or whose `application` is
 * not a string, is SKIPPED rather than refused: this answers one narrow question
 * and `loadEnvironment` is the thing entitled to reject a malformed config, with a
 * message about that file. Skipping here cannot hide a problem, because a name this
 * misses is a name the refusal below prints as absent.
 */
export function environmentsDeclaring(options: {
  configDir: string;
  application: string;
}): string[] {
  return [...declaredApplications(options.configDir)]
    .filter(([, declared]) => declared === options.application)
    .map(([name]) => name)
    .sort();
}

/**
 * Every environment name and the application it declares, read ONCE.
 *
 * Both the search and the "what does exist" half of its refusal come from this.
 * They were two separate walks of the same directory with the same try/catch, which
 * is the §AE shape: a drifted copy reads exactly like a correct one, and here the
 * drift would show up as a refusal listing applications the search did not consider.
 */
function declaredApplications(configDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(configDir)) return out;
  for (const entry of readdirSync(configDir)) {
    if (!entry.endsWith('.json')) continue;
    let declared: unknown;
    try {
      declared = (
        JSON.parse(readFileSync(path.join(configDir, entry), 'utf8')) as { application?: unknown }
      ).application;
    } catch {
      continue;
    }
    if (typeof declared === 'string') out.set(entry.slice(0, -'.json'.length), declared);
  }
  return out;
}

/**
 * `--app <application>` for an INTERACTIVE tool that needs a target, and the three
 * refusals that go with it.
 *
 * ## Why these four commands needed it
 *
 * `pnpm auth`, `pnpm inspect`, `pnpm heal` and `pnpm rca` all called bare
 * `loadEnvironment()`, which resolves `TEST_ENV` from the ambient environment. With
 * `TEST_ENV=app` sitting in a `.env` — the normal state of a machine that has ever
 * run against the customer system — `pnpm auth` opens a browser at DMS and saves a
 * live session under `artifacts/dms/auth/app.json` while the person running it
 * believes they are onboarding a second application. That is not a hypothetical:
 * it is the default outcome of typing the command.
 *
 * `requireApplicationArg` already settles the general rule and its disagreement
 * refusal. What it cannot answer is WHICH ENVIRONMENT, because an application may
 * have several (`app`, `qa`, `staging` are all DMS). So:
 *
 * - **`TEST_ENV` set:** that environment is used. It has already been proven to
 *   agree with `--app`, so this is the caller naming one of several, not ambient
 *   state choosing a target.
 * - **`TEST_ENV` unset, exactly one environment declares the application:** that
 *   one. There is nothing to choose between.
 * - **unset and SEVERAL declare it:** REFUSED, listing them. Picking the first
 *   alphabetically would be a guess about which live system to open a browser at —
 *   `resolveEnvName`'s refusal exists for exactly this and is not worth undoing one
 *   layer up.
 * - **unset and NONE declares it:** REFUSED, naming the slug and what does exist.
 *   A missing `config/env/<app>.json` is the actual first step of onboarding, so
 *   the message says so rather than failing later as a missing file.
 */
export function resolveEnvironmentForApp(options: ApplicationArgOptions): EnvironmentConfig {
  const application = requireApplicationArg(options);

  const ambient = ambientEnvName();
  if (ambient) return loadEnvironment(ambient);

  const configDir = envConfigDir();
  const candidates = environmentsDeclaring({ configDir, application });

  if (candidates.length === 0) {
    // What DOES exist, so the reader can see a typo rather than guess at one —
    // from the SAME read the search used, never a second walk.
    const declared = [...new Set(declaredApplications(configDir).values())].sort();
    throw new Error(
      `refusing to run: no environment declares application "${application}". ` +
        (declared.length > 0
          ? `Applications config/env/ declares today: ${declared.map((a) => `"${a}"`).join(', ')}.`
          : 'config/env/ declares no applications at all.') +
        `\n  Add config/env/${application}.json with "application": "${application}" — see ` +
        'docs/ADD-AN-APPLICATION.md. This is a refusal and not an empty result: nothing was ' +
        'searched beyond the environment files.',
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `refusing to run: ${candidates.length} environments declare application ` +
        `"${application}" (${candidates.map((name) => `"${name}"`).join(', ')}), and nothing ` +
        'here can say which live system you meant.\n' +
        `  Name one: TEST_ENV=${candidates[0]} pnpm <command> --app ${application}.`,
    );
  }

  return loadEnvironment(candidates[0]!);
}
