import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  findRepoRoot,
  TEXT_ROLES,
  type AssertStep,
  type StepExecutor,
  type StepOutcome,
} from '@aitp/shared';

/**
 * The browser-backed `StepExecutor`.
 *
 * `docs/phase-2-authored-cases.md` §10. The accounting was built and verified
 * behind the seam; this is the piece that meets a live page.
 *
 * Three rules it exists to hold, and each is easiest to break exactly here:
 *
 * 1. **A missing element is a STALE CAPTURE, not a failure.** The resolver
 *    found it in the capture; the page disagrees. That is a fact about our
 *    evidence, not about the application.
 * 2. **Healing may propose, never substitute.** When the target is absent this
 *    records what a healer would have suggested, and returns
 *    `target-not-on-page` regardless. Substituting is one line away and would
 *    tell a QA their case passed against an element they never wrote about.
 * 3. **An assertion returns what it OBSERVED.** `await click()` not throwing is
 *    not evidence. Every assertion outcome carries the state it actually read,
 *    and a clause that resolves to nothing checkable returns
 *    `no-observable-check` — a refusal, not a quiet pass.
 */

export interface PlaywrightExecutorOptions {
  /** Where screenshots go. Under `artifacts/`, which is gitignored. */
  artifactDir: string;
  /** Recorded on evidence by PATH. Never read, never inlined. */
  tracePath?: string;
  /** Per-step timeout. Short: a missing element should not cost 30s per row. */
  timeoutMs?: number;
}

/** The slice of Playwright's `Page` this needs. Narrow, so a stub can stand in. */
export interface ExecutorPage {
  getByRole: Page['getByRole'];
  getByText: Page['getByText'];
  screenshot: (options: { path: string }) => Promise<unknown>;
}

/**
 * The path a REPORT may carry, as opposed to the path the file is written to.
 *
 * An absolute path here is not a credential and is still not something to hand
 * over: `RowEvidence.screenshot` lands in the report and in the app team's CSV,
 * both of which a QA pastes into an issue tracker, so it travelled with the
 * developer's home directory and OS username attached — measured, on a real run,
 * in both files at once. Every path a reader needs is inside the repo, so every
 * path a reader is given can be repo-relative.
 *
 * A directory OUTSIDE the repo keeps its absolute path. `path.relative` would
 * answer `..\..\..\Temp\…`, which leaks the same layout while being harder to
 * read and no longer resolvable from anywhere in particular. Production never
 * takes that branch — `runSheet` documents `outDir` as being under `artifacts/`
 * — and the demo spec's own scan is what would notice if it ever did.
 */
function recordedPath(file: string): string {
  const relative = path.relative(findRepoRoot(), file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return file;
  // FORWARD SLASHES, so the cell reads the same on every machine.
  //
  // `path.relative` answers in the host's separator, so the same run produced
  // `artifacts\run-sheet-spec\…` on Windows and `artifacts/run-sheet-spec/…`
  // elsewhere — in a CSV a QA pastes into a shared sheet, where the reader has no
  // way to know which machine wrote it. The separator is not information here:
  // the path is repo-relative, and every tool that will be handed it (git, a
  // browser, a markdown link, Windows itself) accepts a forward slash.
  return relative.split(path.sep).join('/');
}

const slug = (value: string): string =>
  value
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60);

export function createPlaywrightStepExecutor(
  page: ExecutorPage,
  options: PlaywrightExecutorOptions,
): StepExecutor {
  const timeout = options.timeoutMs ?? 5_000;

  const evidenceFor = async (rowId: string, label: string) => {
    const file = path.join(options.artifactDir, `${slug(rowId)}-${slug(label)}.png`);
    try {
      await page.screenshot({ path: file });
    } catch {
      // A screenshot that cannot be taken must not turn a real result into an
      // error. The failing clause is attached by the caller regardless.
      return options.tracePath ? { trace: options.tracePath } : {};
    }
    // WRITE the absolute path, RECORD the repo-relative one. Those are two
    // different jobs and were one string.
    return {
      screenshot: recordedPath(file),
      ...(options.tracePath ? { trace: options.tracePath } : {}),
    };
  };

  return async ({ rowId, step, target }): Promise<StepOutcome> => {
    // The RESOLVER chose this target. Re-deriving it from the prose here would
    // let two components disagree about the same sentence, silently (§10.0).
    if (!target) {
      return {
        kind: 'no-observable-check',
        observed: '',
        evidence: { failingClause: describe(step) },
      };
    }

    // A TEXT target is addressed by its text, not by a role.
    //
    // `getByRole('StaticText', …)` returns zero WITHOUT throwing, so a text
    // node handed to it was reported `target-not-on-page` -> `stale-capture`:
    // "re-run `pnpm inspect`", forever, about an element that is on the page.
    // The resolver now keeps a standalone label as a real target, so the
    // executor has to be able to reach one.
    const locator = TEXT_ROLES.includes(target.role)
      ? page.getByText(target.name, { exact: true })
      : page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
          name: target.name,
          exact: true,
        });

    let count: number;
    try {
      count = await locator.count();
    } catch (error) {
      return {
        kind: 'failed',
        observed: `could not query the page: ${(error as Error).message}`,
        evidence: await evidenceFor(rowId, 'query-error'),
      };
    }

    // ABSENCE IS THE EXPECTED RESULT FOR AN ABSENCE ASSERTION.
    //
    // `count === 0` returned `target-not-on-page` for every step, including
    // `verify X is not visible` — so a row asserting absence, on a page where the
    // element really was absent, was reported `stale-capture`: "re-run `pnpm
    // inspect`", about a capture that was current and a row that had just been
    // satisfied. §11.4's mistake, arriving through the one step kind whose
    // success looks like a missing element.
    //
    // It had no test, which is why it survived: every `count: 0` fixture in the
    // executor's suite uses an action or a positive assertion.
    const assertsAbsence = step.kind === 'assert' && step.property === 'present' && !step.expected;
    if (assertsAbsence) {
      return count === 0
        ? {
            kind: 'passed',
            observed: `no ${target.role} named "${target.name}" on the live page, as asserted`,
          }
        : {
            kind: 'failed',
            observed:
              `${count} ${target.role}(s) named "${target.name}" on the live page, ` +
              'expected none',
            evidence: await evidenceFor(rowId, 'assertion-failed'),
          };
    }

    if (count === 0) {
      // NOT a failure. The capture said this element was here.
      //
      // Nothing is asked for a suggestion here, and there is no hook to ask
      // through. Healing cannot substitute because this path cannot reach a
      // healer at all — see the executor's header.
      return {
        kind: 'target-not-on-page',
        observed: `no ${target.role} named "${target.name}" on the live page`,
        evidence: await evidenceFor(rowId, 'missing-target'),
      };
    }

    // SEVERAL MATCHES ON THE LIVE PAGE, AND THE CLAUSE NAMES ONE.
    //
    // Before the click and before the property read, which is the whole point: the
    // old code reached `locator.first()` and so the wrong element had already been
    // clicked by the time anything could have noticed. Measured on a real page —
    // a capture with one `button "Edit"`, a table with three, and
    // `clicks "Edit" in the row for "Jane"` edited Alice.
    //
    // `present=true` is the exception and is NOT gated: it claims at least one
    // match, which several satisfy. The count travels in `observed` anyway, so a
    // reader can see how many there were rather than inferring one.
    const claimsAtLeastOne = step.kind === 'assert' && step.property === 'present' && step.expected;
    if (count > 1 && !claimsAtLeastOne) {
      return {
        kind: 'ambiguous-on-page',
        observed:
          `${count} elements on the live page match ${target.role} "${target.name}" — ` +
          'this clause names one of them and nothing was done',
        evidence: await evidenceFor(rowId, 'ambiguous-on-page'),
      };
    }

    if (step.kind === 'action') {
      try {
        await locator.first().click({ timeout });
        return { kind: 'passed', observed: `clicked ${target.role} "${target.name}"` };
      } catch (error) {
        return {
          kind: 'failed',
          observed: `could not click ${target.role} "${target.name}": ${(error as Error).message}`,
          evidence: await evidenceFor(rowId, 'click-failed'),
        };
      }
    }

    // An assertion must come back with what it READ, not with silence.
    const read = await observeProperty(locator, step.property, timeout);
    if (read === undefined) {
      return {
        kind: 'no-observable-check',
        observed: '',
        evidence: await evidenceFor(rowId, 'nothing-observable'),
      };
    }

    // The COUNT travels with a presence claim, because "at least one" is a
    // different observation from "exactly one" and the reader cannot tell them
    // apart from `present=true` alone.
    const observed =
      `${target.role} "${target.name}" ${step.property}=${read}` +
      (claimsAtLeastOne && count > 1 ? ` (${count} matches)` : '');
    return read === step.expected
      ? { kind: 'passed', observed }
      : {
          kind: 'failed',
          observed: `${observed}, expected ${step.expected}`,
          evidence: await evidenceFor(rowId, 'assertion-failed'),
        };
  };
}

/** Reads one property, or `undefined` when the page cannot answer. */
async function observeProperty(
  locator: ReturnType<Page['getByRole']>,
  property: AssertStep['property'],
  timeout: number,
): Promise<boolean | undefined> {
  try {
    if (property === 'present') return await locator.first().isVisible({ timeout });
    if (property === 'enabled') return await locator.first().isEnabled({ timeout });
    // `isChecked` throws on an element that is not checkable, which is caught
    // below and returns `undefined` — a SILENCE, not a `false`. A checkbox
    // assertion aimed at a heading must not read as "the heading is unchecked".
    if (property === 'checked') return await locator.first().isChecked({ timeout });
    const selected = await locator.first().getAttribute('aria-selected');
    // No attribute means the page does not express selection for this element.
    // That is a silence, and a silence is not a `false` — the same distinction
    // `checkGrounding` makes for an unrecorded property.
    return selected === null ? undefined : selected === 'true';
  } catch {
    return undefined;
  }
}

function describe(step: {
  kind: string;
  description?: string;
  role?: string;
  name?: string;
}): string {
  return step.kind === 'action' ? (step.description ?? '') : `${step.role} "${step.name}"`;
}
