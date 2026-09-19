import { readFileSync } from 'node:fs';
import { ARIA_ROLES, TEXT_ROLES, collapseTextDuplicates } from '../a11y/addressability';
import type { BoundedCapture } from '../generation/bounding';
import { findCandidates } from './resolver';

/**
 * The module map: which screen a sheet's Module column means, and how a run
 * PROVES it is on that screen.
 *
 * Per-application CONFIG DATA — `config/apps/<application>/module-map.json`,
 * beside the environment files — never a constant in code. Seven to nine QAs
 * maintain these, and every new application under test gets its own file; a
 * list in a `.ts` makes that a code change each time.
 *
 * ## Why `provenBy` is an element and not a URL
 *
 * "The page navigated" is a criterion that can be satisfied while knowing
 * nothing about the page, which is what rule 2 forbids. It is not theoretical
 * here: in the DMS shakedown 27 "locator failures" were one fact — the session
 * had expired and every route answered 200 while redirecting to `/login`. A URL
 * check would have called that arrival.
 *
 * So the proof is an element the capture says is on that screen, and "verified"
 * means that element resolved. The bundled demo app makes the point by itself:
 * it serves the same document for every path and switches views in JavaScript,
 * so its URL tells a reader nothing at all.
 *
 * ## Two conditions on `provenBy`, both with precedent
 *
 * - The role must be ADDRESSABLE. `getByRole('StaticText', …)` returns zero
 *   without throwing, which is how a row was reported `stale-capture` — "re-run
 *   `pnpm inspect`" — forever, about an element that was on the page (§11.2).
 * - It must match EXACTLY ONE node, in exactly one state. Two matches is not a
 *   proof, and a proof found in two states cannot say which one you are on.
 *
 * ## Wired 2026-09-19
 *
 * `assertProvenByInCapture` is called by `createEntryVerifier`
 * (`packages/execution-engine/src/authored/entry-verifier.ts`) when the verifier
 * is built — before a browser is touched, so an entry that could never be proven
 * refuses at the start of a run rather than failing row by row inside one.
 */

export interface ProvenBy {
  role: string;
  name: string;
}

export interface ModuleEntry {
  /**
   * The path this screen is reached at.
   *
   * **4a validates the SHAPE only** — a non-empty string starting with `/`.
   * Whether it opens anything is behaviour, and behaviour is 4d's to check.
   */
  route: string;
  provenBy: ProvenBy;
}

export type ModuleMap = Record<string, ModuleEntry>;

/** Roles a run can actually address: ARIA for `getByRole`, text roles via text. */
const ADDRESSABLE = new Set([...ARIA_ROLES, ...TEXT_ROLES]);

/** A few real examples for an error message, rather than the whole role list. */
const ROLE_EXAMPLES = 'button, heading, link, textbox, tab';

const quoted = (values: string[]): string => values.map((v) => `"${v}"`).join(', ');

/**
 * Reads and shape-checks a module map.
 *
 * Every message names the module, what was found and what to do instead: a QA
 * reading "role StaticText is not addressable" learns nothing they can act on.
 */
export function loadModuleMap(file: string): ModuleMap {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} could not be read as JSON: ${(error as Error).message}`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${file} must be a JSON object of module name -> { route, provenBy }. ` +
        "Each key is a value from the sheet's Module column, spelled the same way.",
    );
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  // Asserts its own effect: an empty map would otherwise validate perfectly and
  // then leave every module unmapped at the next step.
  if (entries.length === 0) {
    throw new Error(
      `${file} has no modules in it. Add one entry per module in the sheet's Module ` +
        'column: { "<module>": { "route": "/…", "provenBy": { "role": "…", "name": "…" } } }.',
    );
  }

  const map: ModuleMap = {};
  for (const [module, value] of entries) {
    const where = `${file}, module "${module}"`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${where}: must be an object { route, provenBy }, found ${typeof value}.`);
    }
    const entry = value as Record<string, unknown>;

    const route = entry.route;
    if (typeof route !== 'string' || route.trim() === '') {
      throw new Error(
        `${where}: "route" is missing. Give the path this screen is reached at, e.g. "/search". ` +
          'Only its shape is checked here — that it opens the screen is checked when a run uses it.',
      );
    }
    if (!route.startsWith('/')) {
      throw new Error(
        `${where}: route "${route}" must start with "/" — a path, not a full URL. ` +
          'The environment supplies the host, so this file stays the same across environments.',
      );
    }

    const provenBy = entry.provenBy;
    if (!provenBy || typeof provenBy !== 'object' || Array.isArray(provenBy)) {
      throw new Error(
        `${where}: "provenBy" is missing. It is the element that proves a run reached this ` +
          'screen: { "role": "heading", "name": "Welcome to Search" }. Take it from the capture ' +
          'for this screen, and pick one that appears there exactly once.',
      );
    }
    const { role, name } = provenBy as Record<string, unknown>;

    if (typeof role !== 'string' || role.trim() === '') {
      throw new Error(`${where}: provenBy needs a "role", e.g. ${ROLE_EXAMPLES}.`);
    }
    if (!ADDRESSABLE.has(role)) {
      throw new Error(
        `${where}: provenBy role "${role}" is not one a run can look for. ` +
          `Choose an element whose role is one of ${ROLE_EXAMPLES} (any ARIA role), ` +
          'and that appears exactly once on that screen in the capture.',
      );
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(
        `${where}: provenBy needs a "name" — the text the element shows, copied from the ` +
          'capture exactly, e.g. "Welcome to Search".',
      );
    }

    map[module] = { route, provenBy: { role, name } };
  }
  return map;
}

/**
 * FALSIFIER 1 — a module in the sheet with no entry here is REFUSED, loudly.
 *
 * Never a silent skip. With seven to nine people sharing these files, a skipped
 * module is a screen nobody knows went untested, and the run still reads green.
 */
export function assertEveryModuleMapped(
  modules: Iterable<string>,
  map: ModuleMap,
  file: string,
): void {
  const unmapped = [...new Set(modules)].filter((module) => !(module in map)).sort();
  if (unmapped.length === 0) return;
  throw new Error(
    `${unmapped.length} module(s) in the sheet have no entry in ${file}: ${quoted(unmapped)}. ` +
      'Add one for each — { "route": "/…", "provenBy": { "role": "…", "name": "…" } } — or ' +
      "correct the spelling in the sheet's Module column. Nothing runs for an unmapped " +
      'module: it is refused here rather than skipped quietly.',
  );
}

/**
 * FALSIFIER 2 — a `provenBy` the capture does not contain fails at LOAD.
 *
 * The capture is PASSED IN, never looked up from disk: `artifacts/` is
 * gitignored, so a loader that went hunting would fail on every fresh clone and
 * in CI, where nothing is wrong at all.
 *
 * Returns the capture state each module proved to be in — derived from the
 * capture rather than declared in config, so nobody has to write a state id by
 * hand and no entry can name one that does not exist.
 */
export function assertProvenByInCapture(
  map: ModuleMap,
  capture: BoundedCapture,
  file: string,
): Record<string, string> {
  const stateIds = capture.states.map((state) => state.id);
  if (stateIds.length === 0) {
    throw new Error(
      `${file}: the capture handed in has no states, so no provenBy can be checked against it. ` +
        'Capture the application first (`pnpm inspect`).',
    );
  }

  const provedIn: Record<string, string> = {};
  for (const [module, entry] of Object.entries(map)) {
    const { role, name } = entry.provenBy;
    const found = entry.provenBy;
    const matches = capture.states.map((state) => ({
      state,
      nodes: collapseTextDuplicates(findCandidates(state, name, [role])),
    }));

    const ambiguous = matches.find((match) => match.nodes.length > 1);
    if (ambiguous) {
      throw new Error(
        `${file}, module "${module}": provenBy ${found.role} "${found.name}" matches ` +
          `${ambiguous.nodes.length} elements in state "${ambiguous.state.id}", so it cannot ` +
          'prove anything. Pick an element that appears on that screen exactly once.',
      );
    }

    const hits = matches.filter((match) => match.nodes.length === 1);
    if (hits.length === 0) {
      const named = capture.states
        .flatMap((state) => state.nodes.filter((node) => node.role === role))
        .map((node) => node.name)
        .filter(Boolean)
        .slice(0, 5);
      throw new Error(
        `${file}, module "${module}": provenBy ${found.role} "${found.name}" is not in the ` +
          `capture. Its states are ${quoted(stateIds)}. ` +
          (named.length > 0
            ? `${found.role}s the capture does have: ${quoted(named)}. `
            : `The capture has no ${found.role} at all. `) +
          'Copy a name from the capture for this screen, exactly as it appears.',
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `${file}, module "${module}": provenBy ${found.role} "${found.name}" is in ` +
          `${hits.length} states (${quoted(hits.map((hit) => hit.state.id))}), so it cannot say ` +
          'which screen a run reached. Pick an element that only this screen has.',
      );
    }

    provedIn[module] = hits[0]!.state.id;
  }
  return provedIn;
}
