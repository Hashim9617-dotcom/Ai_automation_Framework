import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { BoundedCapture, CapturedState, DeclaredTransition } from '@aitp/shared';
import { capturesDir, legacyCapturesDir } from '../config/environment';

/**
 * The captures on disk for one application, merged into one capture.
 *
 * ## Why this exists, and why it did not before
 *
 * `runSheet` took its capture from the caller and said so
 * (`run-sheet.ts`, "It does not load the capture from disk"): `artifacts/` is
 * gitignored, so a loader would have failed on every fresh clone and in CI for a
 * reason that is not wrong. 3b needs one anyway — a CLI has no page to take a
 * capture from — so the loader exists and the three answers are kept apart instead.
 *
 * ## NOT CONFIGURED, EMPTY and FAILED TO LOAD are three answers
 *
 * A `catch` returning an empty capture converts a failure into a confident negative:
 * "this element is not in the capture" about a capture that never loaded. So this
 * returns a discriminated union and never an empty `BoundedCapture`. Every caller
 * has to say which case it is in.
 *
 * ## Only `capture.json`, and the older format is COUNTED
 *
 * Measured 2026-10-02 on the DMS captures: 10 sessions, 104 states. Six sessions
 * carry `pages.json` — the pre-AX format, DOM snapshots with no accessibility tree
 * — so they cannot produce a `CapturedState` at all. `triage` reads them for URLs
 * only, which is all a coverage count needs. A run needs nodes, so those sessions
 * are reported as skipped with the reason rather than silently excluded.
 */

/** What one session contributed, for the report and for a refusal message. */
export interface CaptureSessionSummary {
  sessionId: string;
  capturedAt: string | null;
  /** States kept from this session, after empty ones were dropped. */
  states: number;
  /** The host this session says it was taken from. */
  host: string;
}

export interface SkippedSession {
  sessionId: string;
  why: string;
}

/**
 * Routes seen across EVERY session, including the ones a run cannot use.
 *
 * Two callers want two different things from the same directory, and the
 * difference is nodes:
 *
 * - a RUN needs an accessibility tree, so it can only use `capture.json`;
 * - COVERAGE ("which screens has anybody walked?") needs only an address, which
 *   the older `pages.json` also carries.
 *
 * Serving coverage from the run's view would silently understate it, and
 * understating coverage understates a ceiling that gets quoted. Measured before
 * assuming either way: on the 10 DMS sessions, `pages.json` contributes **0 routes
 * that `capture.json` does not already have** (11 vs 6, no uniques) — so nothing is
 * lost today, and the two views stay separate because that is a fact about today's
 * disk and not a property of the formats.
 */
export interface RouteCoverage {
  /**
   * Every distinct URL pathname, from both formats.
   *
   * THE ADDRESS, never the label. Pairing used to compare the NAME a human typed at
   * capture time — `page.label`, or `slugify(label)`. That name is free text:
   * `inspect-app.ts` PROPOSES `<route>.<heading>` and slugifies it, so accepting the
   * proposal on `/dashboard` produces `dashboard-dashboard`, which paired with
   * nothing. Two of the nine sessions then on disk were orphaned that way while
   * their URLs said exactly which screen they were.
   */
  routes: Set<string>;
  /**
   * URLs that would not parse, COLLECTED and never dropped.
   *
   * A capture silently missing from the set understates the coverage, and
   * understating coverage understates a ceiling that gets quoted.
   */
  unparseable: string[];
}

export type CaptureSource =
  | {
      kind: 'loaded';
      capture: BoundedCapture;
      sessions: CaptureSessionSummary[];
      skipped: SkippedSession[];
      coverage: RouteCoverage;
      /** States dropped for having no nodes at all. Six of 104 on DMS. */
      emptyStatesDropped: number;
      oldest: string | null;
      newest: string | null;
      /** Pre-move sessions under `artifacts/inspect/`, counted and never merged. */
      unlabelled: number;
    }
  | {
      kind: 'none';
      /** A sentence for a human: what is absent and what to run. */
      reason: string;
      skipped: SkippedSession[];
      coverage: RouteCoverage;
      unlabelled: number;
    };

interface RawCapture {
  sessionId?: unknown;
  capturedAt?: unknown;
  application?: unknown;
  environment?: unknown;
  baseUrl?: unknown;
  states?: unknown;
  transitions?: unknown;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Pre-move sessions carry no application, so they are counted, never read. */
function countUnlabelled(): number {
  const legacy = legacyCapturesDir();
  if (!existsSync(legacy)) return 0;
  return readdirSync(legacy, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

export interface LoadCaptureOptions {
  /**
   * The host the run is about to drive, from the resolved environment.
   *
   * A session whose recorded `baseUrl` names a different host is skipped, by
   * session, with both hosts in the message. A capture is what a locator was
   * written against; one taken from another system cannot say anything about this
   * one, and pooling the two is the mistake `labelledBy` exists to prevent.
   *
   * OPTIONAL, and the distinction is deliberate. A RUN must pass it — it is about
   * to drive that host and a capture of a different one describes nothing it will
   * see. A COVERAGE COUNT must not: the same screen captured against staging is
   * still a screen somebody walked, and filtering it out would understate a ceiling
   * that gets quoted.
   */
  targetHost?: string;
}

export function loadCaptureFromDisk(
  application: string,
  options: LoadCaptureOptions,
): CaptureSource {
  const dir = capturesDir(application);
  const unlabelled = countUnlabelled();
  const skipped: SkippedSession[] = [];
  const coverage: RouteCoverage = { routes: new Set(), unparseable: [] };
  const addRoute = (url: unknown, where: string): void => {
    if (typeof url !== 'string') return void coverage.unparseable.push(`${where}: no url`);
    try {
      coverage.routes.add(new URL(url).pathname);
    } catch {
      coverage.unparseable.push(`${where}: ${url}`);
    }
  };

  if (!existsSync(dir)) {
    return {
      kind: 'none',
      reason:
        `no captures for application "${application}": ${rel(dir)} does not exist. ` +
        'Run `pnpm inspect` against it first.',
      skipped,
      coverage,
      unlabelled,
    };
  }

  const states: CapturedState[] = [];
  const transitions: DeclaredTransition[] = [];
  const sessions: CaptureSessionSummary[] = [];
  let emptyStatesDropped = 0;

  for (const sessionId of readdirSync(dir).sort()) {
    // COVERAGE FIRST, from whatever format is there. A session a run cannot use
    // still proves somebody walked that screen.
    const pagesFile = path.join(dir, sessionId, 'pages.json');
    if (existsSync(pagesFile)) {
      try {
        for (const page of JSON.parse(readFileSync(pagesFile, 'utf8')) as Array<{
          url?: unknown;
        }>) {
          addRoute(page.url, sessionId);
        }
      } catch {
        coverage.unparseable.push(`${sessionId}: pages.json does not parse`);
      }
    }

    const file = path.join(dir, sessionId, 'capture.json');
    if (!existsSync(file)) {
      skipped.push({
        sessionId,
        why: existsSync(pagesFile)
          ? 'the pre-accessibility-tree format (pages.json): it has no nodes, so no row can ' +
            'be resolved against it. Its routes still count towards coverage. Capture this ' +
            'screen again to run rows on it.'
          : 'no capture.json in it',
      });
      continue;
    }

    let raw: RawCapture;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as RawCapture;
    } catch (error) {
      // NOT silently dropped. A malformed capture and an absent one send a reader
      // to two different places.
      skipped.push({ sessionId, why: `capture.json does not parse: ${(error as Error).message}` });
      continue;
    }

    // THE LABEL IS CHECKED, not assumed from the directory it sits in.
    //
    // The path says which application this is; so does the file. They are written
    // together (`inspect`) and a migration can move a directory, so a disagreement
    // is possible and is exactly the kind a reader cannot see afterwards.
    if (typeof raw.application === 'string' && raw.application !== application) {
      skipped.push({
        sessionId,
        why:
          `it is labelled application "${raw.application}" but sits under ` +
          `"${application}". One of the two is wrong, and a capture is what a locator ` +
          'was written against.',
      });
      continue;
    }

    const host = typeof raw.baseUrl === 'string' ? hostOf(raw.baseUrl) : '';
    if (host && options.targetHost && host !== options.targetHost) {
      skipped.push({
        sessionId,
        why:
          `it was taken from host "${host}" and this run targets "${options.targetHost}". ` +
          'Two systems, so nothing in it describes the screens about to be driven.',
      });
      continue;
    }

    const rawStates = Array.isArray(raw.states) ? (raw.states as CapturedState[]) : [];
    let kept = 0;
    for (const state of rawStates) {
      addRoute(state.url, sessionId);
      // AN EMPTY STATE IS WORSE THAN A MISSING ONE: it looks like data, and every
      // "X is not in the capture" message built from it lists a state that holds
      // nothing. Six of the 104 DMS states are empty. `inspect` warns about them at
      // capture time; this is the other end of that warning.
      if (!Array.isArray(state.nodes) || state.nodes.length === 0) {
        emptyStatesDropped += 1;
        continue;
      }
      // SESSION-QUALIFIED IDS, because two sessions of the same screen produce the
      // same slug. `CapturedState.id` is the cursor a grounding check moves, so a
      // collision would silently merge two screens' node sets.
      states.push({ ...state, id: `${sessionId}/${state.id}` });
      kept += 1;
    }
    if (Array.isArray(raw.transitions)) {
      for (const transition of raw.transitions as DeclaredTransition[]) {
        transitions.push({
          ...transition,
          from: `${sessionId}/${transition.from}`,
          to: `${sessionId}/${transition.to}`,
        });
      }
    }

    sessions.push({
      sessionId,
      capturedAt: typeof raw.capturedAt === 'string' ? raw.capturedAt : null,
      states: kept,
      host,
    });
  }

  if (states.length === 0) {
    return {
      kind: 'none',
      reason:
        `no usable capture for application "${application}" under ${rel(dir)}: ` +
        `${sessions.length + skipped.length} session(s) there, none of which yielded a ` +
        'state with nodes. This is NOT the same as "the element is not in the capture" — ' +
        'nothing was searched.',
      skipped,
      coverage,
      unlabelled,
    };
  }

  const dates = sessions
    .map((s) => s.capturedAt)
    .filter((d): d is string => d !== null)
    .sort();

  return {
    kind: 'loaded',
    capture: {
      // Named for what it is. A merged capture is not one session, and a reader who
      // sees one session's id would go looking for the whole thing in it.
      sessionId: `merged:${sessions.length} session(s)`,
      states,
      transitions,
      /**
       * NOTHING WAS SELECTED, and the record says so honestly.
       *
       * `selection` exists so a reviewer can tell "the generator never saw the state
       * holding the fact" from "the transition was never declared"
       * (`bounding.ts`). A full disk load dropped nothing for relevance, so every
       * state is chosen and the keyword list is empty — which is the true answer,
       * not a bounding that never happened.
       */
      selection: {
        keywords: [],
        available: states.map((state) => ({ id: state.id, score: 0 })),
        chosen: states.map((state) => ({ id: state.id, score: 0, why: 'score' as const })),
        excluded: [],
      },
    },
    sessions,
    skipped,
    emptyStatesDropped,
    coverage,
    oldest: dates[0] ?? null,
    newest: dates[dates.length - 1] ?? null,
    unlabelled,
  };
}

/** Repo-relative, so no report or refusal carries a home directory. */
function rel(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}
