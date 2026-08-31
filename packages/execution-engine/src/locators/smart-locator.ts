import type { Locator, Page } from '@playwright/test';
import {
  LocatorResolutionError,
  rootLogger,
  type LocatorCandidate,
  type LocatorResolution,
  type LocatorSpec,
} from '@aitp/shared';

const log = rootLogger.child('locator');

/**
 * Anything that can spawn locators: a Page, or a Locator when a component needs
 * its lookups scoped to its own root element.
 */
export type LocatorScope = Pick<
  Page,
  'getByTestId' | 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'locator'
>;

export interface SmartLocatorOptions {
  /** Milliseconds allowed for the LAST candidate in a chain — the one with no fallback left. */
  candidateTimeout?: number;
  /**
   * Milliseconds allowed for a demoted MIDDLE candidate — not the primary
   * (index 0), not the last. Deliberately short: a candidate this far down
   * the chain has already been passed over once, so it is the one most
   * likely to be genuinely stale, and letting it fail fast is what lets the
   * chain reach a working candidate within the test's budget.
   *
   * The primary candidate keeps the full candidateTimeout rather than this
   * shorter one — confirmed live (docs/dms-findings.md) that a legitimate,
   * correctly-specified primary candidate can take several seconds to attach
   * after a route change on this app, well past a ~1s budget; demoting it
   * would have turned "slow but correct" into "fails, falls through to a
   * candidate that may never have worked at all." (The one failure mode this
   * was never meant to guard against — a primary that is subtly wrong due to
   * invisible characters in its accessible name — is what normalizeAccessibleName
   * already fixes at the point of matching, not by demoting the timeout.)
   */
  fallbackCandidateTimeout?: number;
  /** Called for every resolution so the dashboard/healer can learn which candidates rot. */
  onResolved?: (resolution: LocatorResolution) => void;
  /**
   * Called once, right before `resolve()` throws — i.e. once every candidate
   * has failed. This is how the healing gate (docs/phase-2-healing.md) learns
   * about a failure without re-parsing Playwright's own serialized
   * `TestInfo.error`, which does not preserve `instanceof` or custom error
   * properties like `details.durationMs`. Purely an observation hook: nothing
   * reads a return value, and nothing here can change what `resolve()` does
   * next — it always throws immediately after.
   */
  onResolutionFailed?: (spec: LocatorSpec, error: LocatorResolutionError) => void;
}

/**
 * Strips characters that a human authoring a candidate cannot see or type,
 * but that DO appear in the browser's computed accessible name: Unicode
 * Private Use Area glyphs (icon fonts that render via CSS `content` on a
 * pseudo-element — confirmed live, e.g. U+EB62 from Tabler Icons — which
 * `element.textContent` never includes, but the accessible name does) and
 * zero-width characters, then collapses whitespace. `exact: true` against
 * a name like this can never match through Playwright's own matching, no
 * matter how the target string is spelled — there is nothing to type that
 * produces character-for-character equality with an invisible glyph.
 * Exported for direct unit testing and for inspection tooling
 * (`pnpm inspect`, `captureDomSnapshot`) to report the name a candidate can
 * actually be written against.
 */
export function normalizeAccessibleName(name: string): string {
  return name
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const isZeroWidth = code === 0x200b || code === 0xfeff;
      const isPrivateUse = code >= 0xe000 && code <= 0xf8ff;
      return !isZeroWidth && !isPrivateUse;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function build(scope: LocatorScope, candidate: LocatorCandidate): Locator {
  switch (candidate.strategy) {
    case 'testId':
      return scope.getByTestId(candidate.value);
    case 'role': {
      const roleValue = candidate.value as Parameters<Page['getByRole']>[0];
      const roleOptions = candidate.options as
        | ({ name?: string | RegExp; exact?: boolean } & Record<string, unknown>)
        | undefined;
      const primary = scope.getByRole(roleValue, roleOptions as Parameters<Page['getByRole']>[1]);

      // Only role + exact + a plain string name is unsafe this way — a
      // RegExp name is already immune (that is exactly how Finding 5/6 were
      // fixed by hand), and non-exact substring matching already tolerates
      // a leading glyph today (confirmed live).
      if (roleOptions?.exact === true && typeof roleOptions.name === 'string') {
        const needle = normalizeAccessibleName(roleOptions.name);
        const { name: _name, exact: _exact, ...rest } = roleOptions;
        const normalizedFallback = scope
          .getByRole(roleValue, rest as Parameters<Page['getByRole']>[1])
          .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(needle)}\\s*$`) });
        // Matches whichever of the two actually finds the element — the
        // common case (no invisible characters) resolves via `primary`
        // exactly as before; the glyph-poisoned case now resolves via the
        // text-content fallback instead of failing outright.
        return primary.or(normalizedFallback);
      }
      return primary;
    }
    case 'label':
      return scope.getByLabel(candidate.value, { exact: false });
    case 'placeholder':
      return scope.getByPlaceholder(candidate.value, { exact: false });
    case 'text':
      return scope.getByText(candidate.value, { exact: false });
    case 'xpath':
      return scope.locator(`xpath=${candidate.value}`);
    case 'css':
    default:
      return scope.locator(candidate.value);
  }
}

/**
 * Resolves a LocatorSpec to a live Playwright Locator by walking its ordered
 * candidate list. Self-healing (`docs/phase-2-healing.md`) deliberately does
 * NOT plug in here: healing v1 only ever *proposes* a candidate for human
 * review, out of band, after this has already thrown. A hook that fed a
 * live-resolved candidate straight back into a running test — the
 * `onHealRequested` option this class used to accept — would let the healer
 * silently rewrite what a test does, mid-run, with no human involved. That is
 * exactly the failure mode the design exists to prevent, so the socket was
 * removed rather than left unwired.
 */
export class SmartLocator {
  constructor(
    private readonly page: Page,
    private readonly options: SmartLocatorOptions = {},
    /** Restrict lookups to a sub-tree; defaults to the whole page. */
    private readonly scope: LocatorScope = page,
  ) {}

  async resolve(spec: LocatorSpec): Promise<Locator> {
    const startedAt = Date.now();
    const finalTimeout = this.options.candidateTimeout ?? 3_000;
    const fallbackTimeout = this.options.fallbackCandidateTimeout ?? Math.min(1_000, finalTimeout);
    let attempts = 0;
    let expectedBudgetMs = 0;

    for (const [index, candidate] of spec.candidates.entries()) {
      attempts += 1;
      const isPrimaryCandidate = index === 0;
      const isLastCandidate = index === spec.candidates.length - 1;
      const timeout = isPrimaryCandidate || isLastCandidate ? finalTimeout : fallbackTimeout;
      expectedBudgetMs += timeout;
      const locator = build(this.scope, candidate).first();
      try {
        await locator.waitFor({ state: 'attached', timeout });
        this.report({
          key: spec.key,
          usedCandidateIndex: index,
          candidate,
          healed: false,
          attempts,
          durationMs: Date.now() - startedAt,
        });
        if (index > 0) {
          log.warn('Primary locator stale, fell back to a lower-priority candidate', {
            key: spec.key,
            usedCandidateIndex: index,
            strategy: candidate.strategy,
          });
        }
        return locator;
      } catch {
        log.debug('Locator candidate did not match', {
          key: spec.key,
          index,
          strategy: candidate.strategy,
        });
      }
    }

    const failure = new LocatorResolutionError(spec.key, attempts, {
      description: spec.description,
      url: this.page.url(),
      // See LocatorResolutionErrorDetails — the self-healing gate (rule 5)
      // compares these two, not either one against a fixed constant.
      durationMs: Date.now() - startedAt,
      expectedBudgetMs,
    });
    this.options.onResolutionFailed?.(spec, failure);
    throw failure;
  }

  private report(resolution: LocatorResolution): void {
    this.options.onResolved?.(resolution);
  }
}
