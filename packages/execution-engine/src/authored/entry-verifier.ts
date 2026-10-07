import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

/**
 * The slice of `Page` this needs. Narrow, so a stub can stand in.
 *
 * `screenshot` and `ariaSnapshot` are OPTIONAL for exactly that reason: adding them
 * as required would break every stub in the suite, and a stub that had to implement
 * them would be implementing the evidence writer it is meant to stand in for. A
 * stub therefore collects no evidence, and the demo suite proves the real thing
 * against a real page (E10).
 */
export interface EntryPage {
  goto: (url: string) => Promise<unknown>;
  getByRole: Page['getByRole'];
  getByText: Page['getByText'];
  screenshot?: Page['screenshot'];
  ariaSnapshot?: Page['ariaSnapshot'];
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
  /**
   * Where a failing entry's evidence goes. Omitted means none is collected (E10).
   *
   * The CALLER's directory, never one chosen here: `runSheet` already has a per-run
   * `outDir` under `artifacts/<app>/sheet-runs/<runId>/` and the screenshots a step
   * failure writes go there. Two components choosing their own artifact roots is how
   * the capture directories came to be pooled.
   */
  artifactDir?: string;
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

  /**
   * Writes the evidence for ONE failing module, and never throws (E10).
   *
   * A verdict that became an exception because a screenshot could not be taken would
   * turn a diagnosable `state-assert` into a crash — which is precisely what
   * happened to the first File Explorer diagnostic, where a non-existent
   * `page.accessibility` threw after the measurements and cost two of four passes.
   * So the evidence is best-effort by construction: a failure to write it is
   * reported in the detail and the verdict is unchanged.
   *
   * NOT called for `auth`. The page is the login screen there, and a picture of a
   * login form tells nobody anything about the module that was being verified.
   */
  const collect = async (
    module: string,
  ): Promise<{ evidence?: { screenshot: string; aria: string }; note: string }> => {
    const dir = options.artifactDir;
    if (!dir || !options.page.screenshot || !options.page.ariaSnapshot) return { note: '' };
    const slug = module.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const screenshot = path.join(dir, `entry-${slug}.png`);
    const aria = path.join(dir, `entry-${slug}-aria.yaml`);
    try {
      mkdirSync(dir, { recursive: true });
      await options.page.screenshot({ path: screenshot, fullPage: true });
      // `ariaSnapshot`, because `page.accessibility` does not exist in Playwright
      // 1.62.1 — checked against the installed types, not assumed.
      writeFileSync(aria, await options.page.ariaSnapshot({ boxes: true }));
      return { evidence: { screenshot, aria }, note: '' };
    } catch (error) {
      return { note: ` (evidence could not be written: ${(error as Error).message})` };
    }
  };

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
      const shot = await collect(module);
      return {
        verified: false,
        reason: 'navigation',
        detail:
          `could not open "${entry.route}" for module "${module}": ${(error as Error).message}` +
          shot.note,
        ...(shot.evidence ? { evidence: shot.evidence } : {}),
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
      const shot = await collect(module);
      return {
        verified: false,
        reason: 'state-assert',
        detail:
          `could not look for ${role} "${name}" on "${entry.route}": ${(error as Error).message}` +
          shot.note,
        ...(shot.evidence ? { evidence: shot.evidence } : {}),
      };
    }

    if (count === 0) {
      const shot = await collect(module);
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
              'tab open as easily as not at all.') +
          shot.note,
        ...(shot.evidence ? { evidence: shot.evidence } : {}),
      };
    }

    return { verified: true };
  };

  return { verify, validation };
}
