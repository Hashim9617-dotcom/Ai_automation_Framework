import path from 'node:path';
import type { Page } from '@playwright/test';
import { TEXT_ROLES, type StepExecutor, type StepOutcome } from '@aitp/shared';

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
  /**
   * Asked for a suggestion when a target is absent. Its answer is RECORDED and
   * never acted on — the parameter exists so a proposal can be surfaced to a
   * human, not so the executor can retry with it.
   */
  proposeHealing?: (target: { role: string; name: string }) => Promise<string | undefined>;
}

/** The slice of Playwright's `Page` this needs. Narrow, so a stub can stand in. */
export interface ExecutorPage {
  getByRole: Page['getByRole'];
  getByText: Page['getByText'];
  screenshot: (options: { path: string }) => Promise<unknown>;
}

const slug = (value: string): string =>
  value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60);

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
    return { screenshot: file, ...(options.tracePath ? { trace: options.tracePath } : {}) };
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

    if (count === 0) {
      // NOT a failure. The capture said this element was here.
      const proposal = await options.proposeHealing?.(target).catch(() => undefined);
      return {
        kind: 'target-not-on-page',
        observed: `no ${target.role} named "${target.name}" on the live page`,
        // Recorded, never acted on. The kind above is already decided.
        ...(proposal ? { healingProposal: proposal } : {}),
        evidence: await evidenceFor(rowId, 'missing-target'),
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

    const observed = `${target.role} "${target.name}" ${step.property}=${read}`;
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
  property: 'present' | 'enabled' | 'selected',
  timeout: number,
): Promise<boolean | undefined> {
  try {
    if (property === 'present') return await locator.first().isVisible({ timeout });
    if (property === 'enabled') return await locator.first().isEnabled({ timeout });
    const selected = await locator.first().getAttribute('aria-selected');
    // No attribute means the page does not express selection for this element.
    // That is a silence, and a silence is not a `false` — the same distinction
    // `checkGrounding` makes for an unrecorded property.
    return selected === null ? undefined : selected === 'true';
  } catch {
    return undefined;
  }
}

function describe(step: { kind: string; description?: string; role?: string; name?: string }): string {
  return step.kind === 'action' ? (step.description ?? '') : `${step.role} "${step.name}"`;
}
