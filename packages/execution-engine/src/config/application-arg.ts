import { ambientEnvName, loadEnvironment } from './environment';

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
