/**
 * Locator contract shared by the execution engine and the (Phase 2) self-healing engine.
 *
 * Design decision from the architecture doc: ship *pre-generated fallback selectors*
 * first, add real-time AI healing later. A LocatorSpec therefore carries an ordered
 * candidate list; the engine walks it and records which candidate won so the healer
 * has training data from day one.
 */
export type LocatorStrategy =
  | 'testId'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'css'
  | 'xpath';

export interface LocatorCandidate {
  strategy: LocatorStrategy;
  value: string;
  /**
   * For role-based lookups, e.g. { name: 'Save' }. `name` may be a RegExp —
   * useful for a fallback candidate anchored on the meaningful word(s) when
   * an exact-name candidate above it is too strict (e.g. stray whitespace
   * between an icon and its label changes the computed accessible name).
   */
  options?: Record<string, string | boolean | RegExp>;
  /** 0..1 confidence — hand-authored candidates are 1, AI-suggested ones are lower. */
  confidence?: number;
}

export interface LocatorSpec {
  /** Stable key used in logs, healing history and reports, e.g. "employee.form.saveButton". */
  key: string;
  /** Human description used by the AI layer when it needs to re-derive the locator. */
  description: string;
  candidates: LocatorCandidate[];
}

export interface LocatorResolution {
  key: string;
  usedCandidateIndex: number;
  candidate: LocatorCandidate;
  healed: boolean;
  attempts: number;
  durationMs: number;
}

export function locator(
  key: string,
  description: string,
  candidates: LocatorCandidate[],
): LocatorSpec {
  return { key, description, candidates };
}
