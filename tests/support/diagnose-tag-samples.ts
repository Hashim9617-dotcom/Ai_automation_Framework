/**
 * SYNTHETIC `test.describe` LINES, kept OUT of any `.spec.ts` file.
 *
 * `diagnose-tag-scope.spec.ts` scans every spec file for a describe title that
 * carries `@diagnose` alongside `@smoke` or `@regression`. Its own control needs
 * exactly such a line to hand the matcher — and on the guard's first run it found
 * that line in the guard itself and reported the guard as the offender.
 *
 * Third time this repo has been bitten by a check reading its own source: the
 * live-setup scope guard tripped on a comment quoting the pattern it was looking
 * for, and the app-agnostic audit on a keyword it had written down. The fix is the
 * same each time and it is not an exemption for the file — an allowlist entry would
 * blind the guard to a real offender added to that same file later. The fixtures
 * simply live somewhere the scan does not look, which here means any name that does
 * not end in `.spec.ts`.
 */

/** The offending shape: a diagnose suite that a scheduled run would collect. */
export const DESCRIBE_WITH_SCHEDULED_TAG =
  "test.describe('Ecom session @ecom @diagnose @smoke', () => {";

/** The correct shape: diagnose and nothing a scheduled run selects on. */
export const DESCRIBE_DIAGNOSE_ONLY =
  "test.describe('Ecom session: why the re-logins @ecom @diagnose', () => {";

/** Not this guard's business at all — no `@diagnose` anywhere. */
export const DESCRIBE_WITHOUT_DIAGNOSE =
  "test.describe('Ecom list pages load @ecom @smoke', () => {";
