/**
 * WHAT THE PAGE TURNED OUT TO BE — the decision, separated from the waiting.
 *
 * ## Why this file exists
 *
 * `ModulePage.waitForRendered` waited for a heading, a column header or a password
 * input, and reported `element(s) not found` after 30 seconds when none arrived.
 * On 2026-11-24 `TAX-001 Tax create form opens` failed that way twice in one run,
 * and the archived evidence said something the message did not:
 *
 * ```yaml
 * - paragraph: Something went wrong
 * - paragraph: The page could not be displayed. Reload to continue.
 * - button "Reload page"
 * ```
 *
 * That is the application's OWN error boundary. The page had already decided it
 * could not render — 9 same-origin requests for the shell and **zero** `/api`
 * requests, identical on both attempts, against 21 for the list test that passed
 * on the same module in the same run. No heading, grid or form could ever have
 * appeared on that screen, so the thirty seconds bought nothing and the message
 * sent a reader looking for a locator bug that does not exist.
 *
 * This repo already has the rule: **NOT CONFIGURED, EMPTY and FAILED TO LOAD are
 * three different answers.** "The view has not rendered yet" and "the application
 * says it crashed" are two states, and merging them is how a reader is told to do
 * the wrong thing next.
 *
 * ## Why the decision is a pure function
 *
 * Everything the verdict depends on is four booleans. Kept inside
 * `waitForRendered` it would need a real browser and a crashing application to
 * exercise — which is to say it would be tested the day it next fired, which is
 * how the old message survived. Out here, the precedence below is a unit test.
 */

/**
 * The application's error-boundary control, by its accessible name.
 *
 * Anchored, because an unanchored `/reload/i` would also match a grid's own
 * "Reload" refresh button and turn an ordinary list page into a reported crash.
 * This string is this application's, which is why it lives under `tests/apps/ecom/`
 * rather than in anything shared.
 */
export const APP_ERROR_RELOAD = /^reload page$/i;

/** What was visible once something finally was. */
export interface RenderSignals {
  readonly heading: boolean;
  readonly columnheader: boolean;
  readonly password: boolean;
  readonly errorBoundary: boolean;
}

export type RenderVerdict =
  /** The module rendered. `via` says which signal settled it. */
  | { readonly kind: 'rendered'; readonly via: 'heading' | 'columnheader' }
  /** The session is gone and this is the login screen — `ensureSignedIn` handles it. */
  | { readonly kind: 'login' }
  /** The application rendered its own error boundary. An application fault. */
  | { readonly kind: 'app-error' }
  /** Nothing at all, which is the state the old timeout actually described. */
  | { readonly kind: 'nothing' };

/**
 * PRECEDENCE, and the reasoning for the one ordering that is not obvious.
 *
 * The error boundary is checked FIRST — before the heading and before the login
 * screen — and both of those are deliberate:
 *
 * - **Before a heading**, because the shell survives the boundary. A heading in the
 *   top bar with a crash in the content region is still a module that did not
 *   render, and ranking the heading first would report that page as healthy.
 * - **Before a password input**, because the two outcomes do opposite things. A
 *   login verdict is handled silently by re-signing in; an app-error verdict is a
 *   hard failure that names the fault. §AC — an ambiguous screen resolves toward
 *   the REFUSAL, never toward the reading that lets the run continue quietly.
 */
export function classifyRender(signals: RenderSignals): RenderVerdict {
  if (signals.errorBoundary) return { kind: 'app-error' };
  if (signals.password) return { kind: 'login' };
  if (signals.heading) return { kind: 'rendered', via: 'heading' };
  if (signals.columnheader) return { kind: 'rendered', via: 'columnheader' };
  return { kind: 'nothing' };
}

/**
 * The sentence a reader gets instead of `element(s) not found`.
 *
 * It says what happened, that it is the application's fault rather than the
 * suite's, and — because this is the reflex the message exists to stop — that a
 * longer timeout cannot help. A bigger number would delay exactly this message by
 * exactly that much.
 */
export function appErrorBoundaryMessage(path: string): string {
  return (
    `${path} rendered the APPLICATION'S OWN error boundary — "Something went wrong. ` +
    'The page could not be displayed. Reload to continue." — instead of the module. ' +
    'This is an application fault, not a missing element: no heading, grid or form ' +
    'can appear on that screen, so waiting longer cannot help and a larger timeout ' +
    'would only delay this message by that much. The boundary has been seen to be ' +
    'intermittent, so a re-run may pass — which does not make it a test problem.'
  );
}
