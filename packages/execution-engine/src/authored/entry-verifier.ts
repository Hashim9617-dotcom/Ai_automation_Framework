import {
  TEXT_ROLES,
  assertProvenByInCapture,
  type BoundedCapture,
  type EntryVerification,
  type ModuleMap,
} from '@aitp/shared';
import type { Page } from '@playwright/test';

/**
 * Establishing the state a module's rows start from, and PROVING it.
 *
 * `docs/phase-2-authored-cases.md` §10.1a. Three stages, and the reason a row
 * carries is the stage that stopped it — never a guess made afterwards:
 *
 * | stage          | what it does                               | reason on failure |
 * | -------------- | ------------------------------------------ | ----------------- |
 * | auth           | signs in, once per run                     | `auth`            |
 * | navigation     | opens the module's route                   | `navigation`      |
 * | state-assert   | finds the map's `provenBy` on the page     | `state-assert`    |
 *
 * **Verification is not "the page navigated".** In the DMS shakedown 27
 * "locator failures" were one fact: the session had expired and every route
 * answered 200 while redirecting to `/login`. A URL check calls that arrival.
 * The bundled demo app makes the same point by itself — it serves one document
 * for every path — so the proof is an element the capture says is on that
 * screen.
 *
 * **Signing in is supplied by the caller, not written here.** A login form is
 * the application's own vocabulary, and `packages/` does not carry any.
 * Credentials reach that callback from the environment; there is no path from a
 * sheet cell to this file.
 */

/** The slice of `Page` this needs. Narrow, so a stub can stand in. */
export interface EntryPage {
  goto: (url: string) => Promise<unknown>;
  getByRole: Page['getByRole'];
  getByText: Page['getByText'];
}

export interface EntryVerifierOptions {
  /** Validated by `loadModuleMap`, and checked against the capture below. */
  map: ModuleMap;
  /**
   * The capture the rows were resolved against.
   *
   * Passed in, never read from disk. Checking it HERE is what makes a
   * `provenBy` the capture does not hold a load-time failure rather than a
   * browser-time one.
   */
  capture: BoundedCapture;
  /** Named in every message, so a QA knows which file to edit. */
  mapFile: string;
  page: EntryPage;
  /**
   * Signs in. Supplied by the caller because a login form is app-specific.
   *
   * Called at most once per run: a failure here stops every module, and
   * repeating it would report one problem once per screen.
   */
  signIn: () => Promise<void>;
}

/**
 * Builds the per-module verifier.
 *
 * The map is checked against the capture at CONSTRUCTION — before a browser is
 * touched — so an entry that could never be proven is a refusal at the start of
 * a run rather than a row-by-row failure in the middle of one.
 */
export function createEntryVerifier(
  options: EntryVerifierOptions,
): (module: string) => Promise<EntryVerification> {
  assertProvenByInCapture(options.map, options.capture, options.mapFile);

  let signedIn: 'no' | 'yes' | { failed: string } = 'no';

  return async (module: string): Promise<EntryVerification> => {
    const entry = options.map[module];
    if (!entry) {
      // Not an outcome: rows are grouped by module and every module is checked
      // at load, so reaching here means a caller skipped that. Refusing loudly
      // beats inventing a row status for a programming error.
      throw new Error(
        `${options.mapFile}: no entry for module "${module}". Rows are grouped by module and ` +
          'the map is validated before a run starts, so this is a wiring fault, not a result.',
      );
    }

    if (signedIn === 'no') {
      try {
        await options.signIn();
        signedIn = 'yes';
      } catch (error) {
        signedIn = { failed: (error as Error).message };
      }
    }
    if (typeof signedIn === 'object') {
      return {
        verified: false,
        reason: 'auth',
        detail: `signing in failed, so no row could start: ${signedIn.failed}`,
      };
    }

    try {
      await options.page.goto(entry.route);
    } catch (error) {
      return {
        verified: false,
        reason: 'navigation',
        detail: `could not open "${entry.route}" for module "${module}": ${(error as Error).message}`,
      };
    }

    const { role, name } = entry.provenBy;
    // Addressed the way the executor addresses a row's target: a text role by
    // its text, everything else by role and exact name (§11.2).
    const locator = TEXT_ROLES.includes(role)
      ? options.page.getByText(name, { exact: true })
      : options.page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true });

    let count: number;
    try {
      count = await locator.count();
    } catch (error) {
      return {
        verified: false,
        reason: 'state-assert',
        detail: `could not look for ${role} "${name}" on "${entry.route}": ${(error as Error).message}`,
      };
    }

    if (count === 0) {
      return {
        verified: false,
        reason: 'state-assert',
        detail:
          `"${entry.route}" opened, but the element that proves module "${module}" — ` +
          `${role} "${name}" — is not on it. The rows below never ran.`,
      };
    }

    return { verified: true };
  };
}
