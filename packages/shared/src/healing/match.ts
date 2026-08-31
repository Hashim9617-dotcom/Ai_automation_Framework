import type { LocatorCandidate } from '../types/locator';
import type { AccessibilityNode } from '../types/ai';

/**
 * Simulates Playwright's own role+name matching against a captured
 * accessibility-tree snapshot — used twice: once to check whether a
 * *proposed* candidate is unique (verification, non-negotiable per
 * docs/phase-2-healing.md), and once to check whether the *original,
 * already-failed* candidate has since started matching (the "was this
 * actually just slow" pre-check that keeps a merely-late element from being
 * proposed a replacement it never needed).
 *
 * Only `role` candidates are matchable this way — `testId` isn't part of
 * the accessibility tree at all (CDP's AX tree has no concept of
 * `data-testid`), and `css`/`xpath`/`text`/`placeholder`/`label` candidates
 * target the DOM directly, not a role+name pair. The healer (`propose()`)
 * is restricted to proposing `role` candidates for exactly this reason —
 * anything else can't be verified against the evidence this pipeline
 * actually captures, and an unverifiable proposal is worse than no
 * proposal at all.
 */
export function matchAxNodes(
  nodes: AccessibilityNode[],
  candidate: Pick<LocatorCandidate, 'strategy' | 'value' | 'options'>,
): AccessibilityNode[] {
  if (candidate.strategy !== 'role') return [];

  const name = candidate.options?.name;
  const exact = candidate.options?.exact === true;
  const hasNameFilter = typeof name === 'string' || name instanceof RegExp;

  return nodes.filter((node) => {
    if (node.role !== candidate.value) return false;
    if (!hasNameFilter) return true;
    if (name instanceof RegExp) return name.test(node.name);
    if (exact) return node.name === name;
    return node.name.toLowerCase().includes((name as string).toLowerCase());
  });
}
