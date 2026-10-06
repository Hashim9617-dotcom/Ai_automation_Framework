import { readFileSync } from 'node:fs';
import { ARIA_ROLES, TEXT_ROLES, collapseTextDuplicates } from '../a11y/addressability';
import type { BoundedCapture } from '../generation/bounding';
import type { CapturedState } from '../generation/grounding';
import type { AccessibilityNode } from '../types/ai';
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
  /**
   * The element's selection state, for a screen that is a TAB on a shared route.
   *
   * Two modules at one route cannot be told apart by an element both views
   * contain: a `tab "Permissions"` exists in the DOM whether or not it is the open
   * one, so naming it proves only that the tab strip is there. `selected: true` is
   * what makes it a proof of WHICH tab is open.
   *
   * Optional, and absent means "do not look at it" rather than "false" — the same
   * distinction `AccessibilityNode.selected` carries, where `undefined` is the
   * capture not recording the property and must never be read as `false`.
   */
  selected?: boolean;
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

  /**
   * A key starting `//` is a COMMENT, not a module, and is skipped.
   *
   * The convention already exists in `config/env/local.json` and `app.json`, and a
   * map needs it more than they do: the derived DMS map has to record which captures
   * it was computed from, which two entries a human should check by eye, and — most
   * importantly — WHICH MODULES ARE ABSENT AND WHY. A missing entry is otherwise
   * indistinguishable from an oversight, and `assertEveryModuleMapped` refuses the
   * whole run for one, so the reason belongs beside the map rather than in a doc
   * somebody has to know to open.
   *
   * No module in the sheet's Module column starts with a slash, so nothing real is
   * excluded. A malformed entry under any other key still refuses, which the test
   * for this asserts as its other half — a skip rule that swallowed bad entries
   * would be worse than no comments.
   */
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key]) => !key.startsWith('//'),
  );
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

    // VALIDATED, because an unvalidated optional field is a silent no-op: a QA
    // writes `"selected": "true"` and the run ignores it, which is the quiet
    // failure this file exists to avoid.
    const selected = (entry.provenBy as Record<string, unknown>).selected;
    if (selected !== undefined && typeof selected !== 'boolean') {
      throw new Error(
        `${where}: provenBy "selected" must be true or false (a JSON boolean, not a string), ` +
          `found ${typeof selected}. Use it only for a tab on a route another module shares — ` +
          'it is what tells "the tab strip is present" from "this tab is open".',
      );
    }

    map[module] = {
      route,
      provenBy: { role, name, ...(selected === undefined ? {} : { selected }) },
    };
  }
  return map;
}

/**
 * FALSIFIER 1 — a module in the sheet with no entry here is REFUSED, loudly.
 *
 * Never a silent skip. With seven to nine people sharing these files, a skipped
 * module is a screen nobody knows went untested, and the run still reads green.
 */
export function partitionMappedModules(
  modules: Iterable<string>,
  map: ModuleMap,
  file: string,
): { mapped: string[]; unmapped: UnprovableModule[] } {
  const named = [...new Set(modules)].sort();
  const mapped = named.filter((module) => module in map);
  const unmapped = named
    .filter((module) => !(module in map))
    .map((module) => ({
      module,
      why:
        `module "${module}" has no entry in ${file}. Add one — ` +
        '{ "route": "/…", "provenBy": { "role": "…", "name": "…" } } — or correct the ' +
        "spelling in the sheet's Module column.",
    }));
  return { mapped, unmapped };
}

/**
 * The same falsifier, as a REFUSAL for the whole run.
 *
 * Kept for a caller that has no way to report per-module — there is none today, so
 * this exists to keep the old guarantee expressible rather than to be used. The
 * per-module path is `partitionMappedModules` above, which is what `runSheet` uses:
 * one unmapped module refuses ITS rows and the rest of the sheet still runs, because
 * refusing 400 rows over one misspelt Module cell is a worse answer than refusing 3.
 */
export function assertEveryModuleMapped(
  modules: Iterable<string>,
  map: ModuleMap,
  file: string,
): void {
  const { unmapped } = partitionMappedModules(modules, map, file);
  if (unmapped.length === 0) return;
  throw new Error(
    `${unmapped.length} module(s) in the sheet have no entry in ${file}: ` +
      `${quoted(unmapped.map((entry) => entry.module))}. ` +
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
export interface ProvenModule {
  /** The one route every state proving this module was captured at. */
  route: string;
  /** How many captured states hold it. Context for the report, never a verdict. */
  states: number;
}

export interface UnprovableModule {
  module: string;
  /** A sentence a human can act on, naming the file and the fix. */
  why: string;
}

export interface MapValidation {
  provable: Record<string, ProvenModule>;
  /** Every entry that cannot prove its screen, whether the sheet names it or not. */
  unprovable: UnprovableModule[];
}

/** A captured state's route. The host varies between environments; the path does not. */
function routeOf(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

const normaliseRoute = (route: string): string =>
  route.length > 1 ? route.replace(/\/+$/, '') : route;

/**
 * FALSIFIER 2, per module and grouped BY ROUTE.
 *
 * The capture is PASSED IN, never looked up from disk by this function: it is in
 * `@aitp/shared`, which the API compiles, and a loader here would make every caller
 * depend on `artifacts/` existing. `loadCaptureFromDisk` is the loader, and 3b's CLI
 * is what hands the result in.
 *
 * ## Why ROUTE and not STATE, measured
 *
 * This required a provenBy to match in exactly ONE STATE, which is a rule about one
 * capture session. Merging sessions — what a CLI must do, because a QA walks the app
 * over weeks — makes the same screen several states, and the rule then refuses
 * everything. Measured 2026-10-02 against the 10 DMS sessions on disk, 98 non-empty
 * states, all nine mapped modules:
 *
 *     Dashboard       0 clean hits (+4 ambiguous)   refused
 *     File Explorer   58 states                     refused — "in 58 states"
 *     Document        58 states                     refused — "in 58 states"
 *     Global search   0                             refused — not in the capture
 *     User            3                             refused
 *     User Role       10                            refused
 *     user role       10                            refused
 *     Bulk upload     12                            refused
 *     Permissions     10                            refused
 *
 * Nine of nine, which would have stopped every run. The property the rule is for —
 * **the element must say WHICH SCREEN the run reached** — is about the screen, and
 * fifty-eight captures of one screen are still one screen. So hits are grouped by
 * route, and a provenBy found at two different routes is what cannot say anything.
 *
 * This had never been noticed because the validator had never had the DMS map as a
 * subject: its only caller was handed a capture built from the bundled demo app,
 * whose map has one state per route (§T — a check that ran on nothing).
 *
 * ## And the route must be the module's OWN
 *
 * Free, once hits carry a route: an anchor proving `/admin/users` cannot prove a
 * module the map sends to `/files`. The old rule could not ask this.
 *
 * ## An ambiguous state is not a hit, rather than an immediate refusal
 *
 * A state where the name matches twice proves nothing THERE, so it is excluded from
 * the hits instead of disqualifying the module outright. With one session that is
 * the same answer; with 58 it is the difference between a usable anchor and a
 * refusal caused by one bad capture. When nothing is left, the message says
 * ambiguity was the reason — which is exactly `Dashboard` above, 0 clean and 4
 * ambiguous.
 */
export function validateModuleMap(
  map: ModuleMap,
  capture: BoundedCapture,
  file: string,
): MapValidation {
  if (capture.states.length === 0) {
    throw new Error(
      `${file}: the capture handed in has no states, so no provenBy can be checked against it. ` +
        'Capture the application first (`pnpm inspect`). This is a refusal and not an empty ' +
        'result: nothing was searched.',
    );
  }

  const provable: Record<string, ProvenModule> = {};
  const unprovable: UnprovableModule[] = [];

  /**
   * TWO KEYS THAT DIFFER ONLY IN CASE, reported and never merged.
   *
   * The real map holds `"User Role"` and `"user role"`, both at
   * `/admin/user-roles` with the same proof. Folding them together would be a
   * downstream mechanism deciding something the sheet already knows: the Module
   * column is what a QA typed, two spellings may be two screens or one typo, and
   * only the person who wrote the sheet can say which. Keying on a lowercased name
   * would also make the map silently lossy — the second entry would overwrite the
   * first, and whichever route survived would be a coin toss.
   *
   * So both stay, both are validated, and the pair is named. The shared-route rule
   * below refuses them anyway while they carry the same proof, but it refuses them
   * for being indistinguishable rather than for being near-duplicates, and those are
   * two different things to tell a reader.
   */
  const byLowerName = new Map<string, string[]>();
  for (const module of Object.keys(map)) {
    const key = module.toLowerCase();
    byLowerName.set(key, [...(byLowerName.get(key) ?? []), module]);
  }
  for (const [, variants] of byLowerName) {
    if (variants.length < 2) continue;
    unprovable.push({
      module: variants.sort()[0]!,
      why:
        `${file}: ${variants.length} entries differ only in CASE — ${quoted(variants.sort())}. ` +
        'They are NOT merged: two spellings may be two screens or one typo, and the Module ' +
        "column is the QA's. Decide which is real, delete the other, and correct the sheet.",
    });
  }

  /**
   * Candidates for one provenBy in one state, INCLUDING its declared property.
   *
   * `findCandidates` filters on name and role only, so a `selected` a map declares
   * would be expressible and ignored — the map could say "the open tab" and the
   * validator would accept the closed one. The property is applied here, where the
   * matching happens, rather than trusted to a function that does not read it.
   */
  const matchesIn = (state: CapturedState, provenBy: ProvenBy): AccessibilityNode[] => {
    const named = collapseTextDuplicates(findCandidates(state, provenBy.name, [provenBy.role]));
    if (provenBy.selected === undefined) return named;
    // `undefined` on the NODE is the capture not recording the property, and that is
    // silence — never `false`. A proof that needs the property cannot be satisfied by
    // a node that never carried it.
    return named.filter((node) => node.selected === provenBy.selected);
  };

  for (const [module, entry] of Object.entries(map)) {
    const { role, name } = entry.provenBy;
    const matches = capture.states.map((state) => ({
      state,
      nodes: matchesIn(state, entry.provenBy),
    }));

    const ambiguous = matches.filter((match) => match.nodes.length > 1);
    const hits = matches.filter((match) => match.nodes.length === 1);

    if (hits.length === 0) {
      if (ambiguous.length > 0) {
        unprovable.push({
          module,
          why:
            `${file}, module "${module}": provenBy ${role} "${name}" matches ` +
            `${ambiguous[0]!.nodes.length} elements in every state that has it ` +
            `(${ambiguous.length} state(s)), so it cannot prove anything. Pick an element ` +
            'that appears on that screen exactly once.',
        });
        continue;
      }
      const named = [
        ...new Set(
          capture.states
            .flatMap((state) => state.nodes.filter((node) => node.role === role))
            .map((node) => node.name)
            .filter(Boolean),
        ),
      ].slice(0, 5);
      unprovable.push({
        module,
        why:
          `${file}, module "${module}": provenBy ${role} "${name}" is not in the capture. ` +
          (named.length > 0
            ? `${role}s the capture does have: ${quoted(named)}. `
            : `The capture has no ${role} at all. `) +
          'Copy a name from the capture for this screen, exactly as it appears, or capture ' +
          'the screen again if the application has changed.',
      });
      continue;
    }

    const routes = [...new Set(hits.map((hit) => routeOf(hit.state.url)))].sort();
    if (routes.length > 1) {
      unprovable.push({
        module,
        why:
          `${file}, module "${module}": provenBy ${role} "${name}" is at ${routes.length} ` +
          `different routes (${quoted(routes)}), so it cannot say which screen a run ` +
          'reached. Pick an element that only this screen has.',
      });
      continue;
    }

    const route = routes[0]!;
    const declared = normaliseRoute(entry.route);
    if (route !== declared) {
      unprovable.push({
        module,
        why:
          `${file}, module "${module}": the map sends this module to "${entry.route}" but ` +
          `provenBy ${role} "${name}" was captured at "${route}". One of the two is wrong — ` +
          'the route it opens, or the element that proves it opened.',
      });
      continue;
    }

    provable[module] = { route, states: hits.length };
  }

  /**
   * THE HOLE IN THE ROUTE RULE: two modules at one route.
   *
   * A route-level proof says which SCREEN a run reached. It cannot say which of
   * several modules AT that screen it reached, and the real map has two such
   * groups — measured 2026-10-03:
   *
   *     /files              File Explorer | Document   both tree "Workspaces"
   *     /admin/user-roles   User Role | user role | Permissions
   *                                                   all heading "User role"
   *
   * `Permissions` is a tab inside User Role, so its rows would have run against the
   * User Role view and reported passes and failures about the wrong screen. That is
   * worse than a refusal: a refusal is visible and a wrong pass is not.
   *
   * FAIL-CLOSED: on a shared route a module needs a proof the others do NOT match.
   * Identical provenBy entries distinguish nothing, so every member of the group is
   * refused by name. A tab declaring `selected: true` DOES distinguish, because the
   * closed tab's node carries `selected: false` and is filtered out above — which is
   * the whole reason the property was added.
   *
   * The check is structural rather than a list of known-shared routes: it asks
   * whether any captured state separates this module from each route-mate, so a new
   * pairing nobody thought about is caught the day it is added.
   */
  const byRoute = new Map<string, string[]>();
  for (const [module, proven] of Object.entries(provable)) {
    byRoute.set(proven.route, [...(byRoute.get(proven.route) ?? []), module]);
  }

  for (const [route, modules] of byRoute) {
    if (modules.length < 2) continue;
    const statesAt = capture.states.filter((state) => routeOf(state.url) === route);

    for (const module of modules) {
      const mine = map[module]!.provenBy;
      const indistinguishable = modules
        .filter((other) => other !== module)
        .filter((other) => {
          const theirs = map[other]!.provenBy;
          // Is there a state at this route where MY proof holds and THEIRS does not?
          // One such state is enough: it is a screen the two can be told apart on.
          return !statesAt.some(
            (state) => matchesIn(state, mine).length === 1 && matchesIn(state, theirs).length === 0,
          );
        })
        .sort();

      if (indistinguishable.length === 0) continue;
      delete provable[module];
      unprovable.push({
        module,
        why:
          `${file}, module "${module}": shared route "${route}" — proof ${mine.role} ` +
          `"${mine.name}"${mine.selected === undefined ? '' : ` selected=${mine.selected}`} ` +
          `cannot tell "${module}" from ${quoted(indistinguishable)}. Every captured state ` +
          'at that route that has one has the other. Give the tab-like module a proof with a ' +
          'state, e.g. { "role": "tab", "name": "…", "selected": true }, or capture the screen ' +
          'that is actually different and point the route at it.',
      });
    }
  }

  return { provable, unprovable };
}

/**
 * The same falsifier as a whole-map REFUSAL, for a caller that cannot report per
 * module.
 *
 * Kept so the old guarantee stays expressible; `validateModuleMap` is what the run
 * path uses, because an unprovable entry for a module the sheet never names should
 * not stop a sheet that does not depend on it.
 */
export function assertProvenByInCapture(
  map: ModuleMap,
  capture: BoundedCapture,
  file: string,
): Record<string, ProvenModule> {
  const { provable, unprovable } = validateModuleMap(map, capture, file);
  if (unprovable.length > 0) {
    throw new Error(unprovable.map((entry) => entry.why).join('\n'));
  }
  return provable;
}

/**
 * THE STATE EACH MODULE'S ROWS RESOLVE AGAINST — one expression, every caller.
 *
 * This logic lived inside `runSheet` and was then re-derived, identically, by
 * anything that wanted to know what the run would do. Two copies of a route→state
 * lookup is the shape every fail-open finding in this repo has had: a drifted copy
 * reads exactly like a correct one, and the divergence shows up as a row resolving
 * against a different screen than the one the run used.
 *
 * It matters most for B1. Triage's `automatable` is only the run's answer if it
 * resolves against the run's state, so the two now call this rather than agreeing
 * by coincidence.
 *
 * **THE NEWEST state at the route**, because a locator should be written against
 * the most recent walk of that screen. The disk loader reads sessions in sorted
 * directory order and those directories are ISO timestamps, so the last one wins.
 *
 * Modules with no captured state at their route are simply ABSENT from the result
 * — never mapped to an empty string, which a caller could spend on a lookup. The
 * returned map's `keys()` is therefore the honest answer to "which modules can be
 * resolved at all", and that is what triage keys its capture question on.
 */
export function entryStateByModule(map: ModuleMap, capture: BoundedCapture): Map<string, string> {
  const newestAt = new Map<string, string>();
  for (const state of capture.states) newestAt.set(routeOf(state.url), state.id);

  const byModule = new Map<string, string>();
  for (const [module, entry] of Object.entries(map)) {
    // `routeOf` and `normaliseRoute` are this file's own, already used by
    // `validateModuleMap` — so the route a module is matched on here is the same
    // string that validator compared, by construction rather than by agreement.
    const stateId = newestAt.get(normaliseRoute(entry.route));
    if (stateId !== undefined) byModule.set(module, stateId);
  }
  return byModule;
}
