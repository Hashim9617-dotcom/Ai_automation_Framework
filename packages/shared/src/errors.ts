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

export class LocatorResolutionError extends PlatformError {
  constructor(key: string, attempts: number, details?: Record<string, unknown>) {
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
