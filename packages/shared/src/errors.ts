export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ConfigError extends PlatformError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
  }
}

export interface LocatorResolutionErrorDetails extends Record<string, unknown> {
  description?: string;
  url?: string;
  /** Wall-clock time spent walking the candidate chain before giving up. */
  durationMs?: number;
  /**
   * Sum of every candidate's own timeout budget (`candidateTimeout` for the
   * primary/last, `fallbackCandidateTimeout` for demoted middle ones) —
   * i.e. what `durationMs` should be, at most, if every candidate genuinely
   * never attaches and nothing outside the chain adds latency. A single
   * absent candidate normally costs close to its full timeout on its own —
   * `waitFor({ state: 'attached' })` polls until the deadline, it does not
   * detect "this will never happen" early — so `durationMs` landing near
   * `expectedBudgetMs` is the ordinary case, not a red flag. What the gate
   * (docs/phase-2-healing.md, rule 5) actually watches for is `durationMs`
   * *exceeding* this budget: extra latency the chain's own timeouts don't
   * explain, e.g. from a page still settling or a stacked earlier
   * resolution against the same key (the specific pattern that made
   * Finding 5 look like session instability before the per-candidate
   * timeout split existed).
   */
  expectedBudgetMs?: number;
}

export class LocatorResolutionError extends PlatformError {
  constructor(key: string, attempts: number, details?: LocatorResolutionErrorDetails) {
    super(
      `Could not resolve locator "${key}" after ${attempts} candidate(s).`,
      'LOCATOR_UNRESOLVED',
      details,
    );
  }
}

/**
 * Thrown when a page has been bounced to the login screen mid-test. Distinct
 * from LocatorResolutionError on purpose: the element the test wanted was
 * never missing, the session was gone — an environment failure, not a
 * selector one. Without this split, a dead session and a stale locator look
 * identical in the test report.
 */
export class SessionExpiredError extends PlatformError {
  constructor(details?: Record<string, unknown>) {
    super('session expired — page redirected to /login', 'SESSION_EXPIRED', details);
  }
}

export class LlmError extends PlatformError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'LLM_ERROR', details);
  }
}

export class BudgetExceededError extends PlatformError {
  constructor(spentUsd: number, capUsd: number) {
    super(
      `LLM budget exceeded for this run: $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}.`,
      'LLM_BUDGET_EXCEEDED',
      { spentUsd, capUsd },
    );
  }
}
