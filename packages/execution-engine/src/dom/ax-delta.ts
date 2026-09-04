import type { AccessibilityNode } from '@aitp/shared';

/** Roles that carry application data rather than chrome. See `stateSignature`. */
const DATA_ROLES = new Set(['treeitem', 'row', 'cell', 'gridcell', 'option', 'listitem']);
/** Roles whose names are structural and stable across data changes. */
const CHROME_ROLES = new Set(['heading', 'tab', 'button', 'link']);

// A plain space, deliberately: role names never contain one, so it separates
// unambiguously, and an empty separator would let pairs collide
// ("ta"+"bFolder" === "tab"+"Folder").
const key = (node: AccessibilityNode): string => `${node.role} ${node.name}`;

export interface AxDelta {
  added: AccessibilityNode[];
  removed: AccessibilityNode[];
  /** Same role+name, different selected/enabled/expanded/checked. */
  stateChanged: Array<{ node: AccessibilityNode; was: AccessibilityNode }>;
  /** True when nothing meaningful moved. */
  empty: boolean;
}

export function diffAxTrees(from: AccessibilityNode[], to: AccessibilityNode[]): AxDelta {
  const fromByKey = new Map(from.map((n) => [key(n), n]));
  const toByKey = new Map(to.map((n) => [key(n), n]));

  const added = to.filter((n) => !fromByKey.has(key(n)));
  const removed = from.filter((n) => !toByKey.has(key(n)));
  const stateChanged: AxDelta['stateChanged'] = [];

  for (const node of to) {
    const was = fromByKey.get(key(node));
    if (!was) continue;
    if (
      was.enabled !== node.enabled ||
      was.selected !== node.selected ||
      was.expanded !== node.expanded ||
      was.checked !== node.checked
    ) {
      stateChanged.push({ node, was });
    }
  }

  return {
    added,
    removed,
    stateChanged,
    empty: added.length === 0 && removed.length === 0 && stateChanged.length === 0,
  };
}

/**
 * A structural fingerprint of a state, used ONLY to decide whether to ask the
 * operator a question — never as ground truth, and never to auto-accept or
 * auto-merge anything.
 *
 * Built from role counts plus the names appearing under chrome roles, with
 * data roles excluded so that a changing workspace list does not make the same
 * logical state look different every session.
 *
 * The data/chrome split is a heuristic and it can be wrong in both directions
 * (an app rendering navigation as `listitem`, or data as `heading`, defeats
 * it). That is tolerable precisely because both failure directions produce a
 * spurious QUESTION rather than a silent wrong answer — see
 * docs/phase-2-generation.md.
 */
export function stateSignature(nodes: AccessibilityNode[]): string {
  const roleCounts = new Map<string, number>();
  const chromeNames: string[] = [];

  for (const node of nodes) {
    roleCounts.set(node.role, (roleCounts.get(node.role) ?? 0) + 1);
    if (CHROME_ROLES.has(node.role) && !DATA_ROLES.has(node.role) && node.name) {
      chromeNames.push(`${node.role}:${node.name}`);
    }
  }

  const roles = [...roleCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ roles, chrome: chromeNames.sort() });
}

/** How similar two signatures are, 0..1, by shared chrome names. */
export function signatureSimilarity(a: string, b: string): number {
  const namesOf = (sig: string): Set<string> => {
    try {
      return new Set((JSON.parse(sig) as { chrome: string[] }).chrome);
    } catch {
      return new Set();
    }
  };
  const left = namesOf(a);
  const right = namesOf(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const name of left) if (right.has(name)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export interface CrossCheck {
  verdict: 'consistent' | 'suspect';
  reasons: string[];
}

/**
 * Cross-checks a human's declared action against the observed AX delta.
 *
 * This is the guard for the risk P2 introduces: a human's description becomes
 * ground truth that step 3 builds on confidently, and nothing else catches an
 * operator who mislabels at the end of a long session. Costs nothing — both
 * trees are already captured and this is set arithmetic over them.
 *
 * A `suspect` verdict never blocks the recording (the heuristic may be wrong
 * and the human right), but it is stored, and a suspect transition may support
 * a question while never grounding an `observed` assertion.
 */
export function crossCheckTransition(
  action: string,
  from: AccessibilityNode[],
  delta: AxDelta,
): CrossCheck {
  const reasons: string[] = [];

  if (delta.empty) {
    reasons.push('nothing measurable changed between the two captures');
  }

  // Names the operator quoted, or capitalised tokens that look like labels.
  const quoted = [...action.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .filter(Boolean);

  for (const name of quoted) {
    const needle = name.toLowerCase();
    const presentBefore = from.some((n) => n.name.toLowerCase().includes(needle));
    if (!presentBefore) {
      reasons.push(
        `the declaration names "${name}", but no node in the previous state carried that name`,
      );
    }
  }

  // A wholesale replacement usually means a navigation or a session expiry,
  // not the in-place action being described.
  const churn = delta.added.length + delta.removed.length;
  if (from.length > 0 && churn > from.length * 3) {
    reasons.push(
      `almost everything changed (${churn} nodes) — that looks like a navigation, not the action described`,
    );
  }

  return { verdict: reasons.length > 0 ? 'suspect' : 'consistent', reasons };
}

/**
 * Ranks plausible click targets from the previous state, so the operator can
 * pick a number instead of typing prose. Nodes that vanished rank first: a
 * control that disappeared is usually the one that was pressed.
 *
 * Suggestions are offered, never pre-selected — a guess the human accepts
 * without reading becomes ground truth, so the menu is allowed to speed up
 * agreement and not to manufacture it.
 */
export function suggestActions(from: AccessibilityNode[], delta: AxDelta, limit = 4): string[] {
  const removedKeys = new Set(delta.removed.map(key));
  const clickable = from.filter(
    (n) => ['button', 'tab', 'link', 'menuitem', 'treeitem'].includes(n.role) && n.name,
  );
  const scored = clickable.map((node) => ({
    node,
    score: removedKeys.has(key(node)) ? 2 : 0,
  }));
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => `clicked "${s.node.name}"`);
}
