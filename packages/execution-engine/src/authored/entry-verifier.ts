import {
  TEXT_ROLES,
  validateModuleMap,
  type BoundedCapture,
  type EntryVerification,
  type MapValidation,
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
 * The map is still checked against the capture at CONSTRUCTION — before a browser
 * is touched — so an entry that could never be proven is settled at the start of a
 * run rather than row by row in the middle of one. What changed in 3b is the
 * CONSEQUENCE: the whole map is validated and every unprovable entry is returned,
 * and only the modules the SHEET NAMES have their rows refused. A `provenBy` nobody
 * depends on is a visible warning in the report, not a reason to refuse 400 rows.
 *
 * `validation` is returned rather than thrown so the caller can do that triage. A
 * caller that cannot — there is none today — has `assertProvenByInCapture`.
 */
export function createEntryVerifier(options: EntryVerifierOptions): {
  verify: (module: string) => Promise<EntryVerification>;
  validation: MapValidation;
} {
  const validation = validateModuleMap(options.map, options.capture, options.mapFile);

  let signedIn: 'no' | 'yes' | { failed: string } = 'no';

  const verify = async (module: string): Promise<EntryVerification> => {
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

    const { role, name, selected } = entry.provenBy;
    /**
     * Addressed the way the executor addresses a row's target: a text role by its
     * text, everything else by role and exact name (§11.2).
     *
     * `selected` is passed ONLY when the map declares it. Two reasons, and the
     * second is why it is a conditional rather than `selected: undefined`:
     *
     * - the map can express the property, so the run must read it, or a provenBy
     *   that says "the OPEN tab" would be satisfied by the closed one — the same
     *   divergence the capture-side filter in `validateModuleMap` closes;
     * - Playwright's `selected` option is only valid for roles that support
     *   `aria-selected`, and it throws for the rest. A heading lookup must not
     *   acquire an option just because the type allows one.
     */
    const locator = TEXT_ROLES.includes(role)
      ? options.page.getByText(name, { exact: true })
      : options.page.getByRole(role as Parameters<Page['getByRole']>[0], {
          name,
          exact: true,
          ...(selected === undefined ? {} : { selected }),
        });

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
          `${role} "${name}"${selected === undefined ? '' : ` selected=${selected}`} — is not ` +
          'on it. The rows below never ran.' +
          // NAMED, because the two failures want different actions: the screen is
          // wrong, or the screen is right and the wrong tab is open. Without the
          // property in the message a QA re-checks the route and finds it correct.
          (selected === undefined
            ? ''
            : ' A route that shares its path with another module is reached with the wrong ' +
              'tab open as easily as not at all.'),
      };
    }

    return { verified: true };
  };

  return { verify, validation };
}
