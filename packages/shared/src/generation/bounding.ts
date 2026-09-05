import type { AccessibilityNode } from '../types/ai';
import { tokenize } from '../matching/command-matcher';
import type { CapturedState, CollapsedGroup, StateCapture } from './grounding';

/**
 * Capture bounding: what actually goes into a generation prompt.
 *
 * The capture is the prompt's dominant cost, so bounding it IS bounding the
 * cost. But bounding DROPS INFORMATION, and rule 1 says absence is evidence
 * only in a complete view — so every loss here either carries a marker or is
 * provably lossless for grading. See docs/phase-2-generation.md, "Cost,
 * capture bounding, and the cache key".
 */

/** How many states may be sent, before transition neighbours are added. */
export const DEFAULT_MAX_STATES = 3;
/** Node cap per state, applied AFTER dropping and collapsing. */
export const DEFAULT_MAX_NODES_PER_STATE = 150;
/** A shape must repeat at least this many times before it is worth collapsing. */
export const DEFAULT_MIN_GROUP_SIZE = 4;

export interface StateSelectionRecord {
  /** Keywords the scoring actually used, after stop-word removal. */
  keywords: string[];
  available: Array<{ id: string; score: number }>;
  chosen: Array<{ id: string; score: number; why: 'score' | 'transition-neighbour' }>;
  excluded: Array<{ id: string; score: number; why: 'below-cut' | 'beyond-state-cap' }>;
}

export interface BoundedCapture extends StateCapture {
  /**
   * What state selection saw, kept and dropped.
   *
   * State selection is a relevance heuristic, and when it picks wrong the
   * generator never sees the state holding the fact — so an observable
   * assertion grades `assumed` and the reviewer is shown "this is a question,
   * not a case". That is indistinguishable from a genuinely undeclared
   * transition, and the two have opposite fixes. This record is what lets a
   * reviewer tell them apart without re-running anything.
   */
  selection: StateSelectionRecord;
}

/** Replaces the digits/varying tail of a name so repeated shapes group together. */
function shapeOf(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Collapses runs of same-role nodes whose names share a leading and trailing
 * literal, e.g. `Expand WS-ALPHA More options` / `Expand WS-BETA More options`
 * -> `Expand <name> More options`.
 *
 * Returns the nodes that survive plus the groups that were folded away. A
 * collapsed group is NOT the same loss as truncation: the view is still
 * complete, the members are merely unlisted, so refutation stays enabled for
 * every shape that was not collapsed.
 */
export function collapseRepeatedShapes(
  nodes: AccessibilityNode[],
  minGroupSize = DEFAULT_MIN_GROUP_SIZE,
): { nodes: AccessibilityNode[]; collapsed: CollapsedGroup[] } {
  const byRole = new Map<string, AccessibilityNode[]>();
  for (const node of nodes) {
    byRole.set(node.role, [...(byRole.get(node.role) ?? []), node]);
  }

  const kept: AccessibilityNode[] = [];
  const collapsed: CollapsedGroup[] = [];

  for (const [role, group] of byRole) {
    if (group.length < minGroupSize) {
      kept.push(...group);
      continue;
    }

    const words = group.map((node) => shapeOf(node.name).split(' '));
    const first = words[0]!;

    // Longest shared prefix and suffix of words across the whole group.
    let prefix = 0;
    while (prefix < first.length && words.every((w) => w.length > prefix && w[prefix] === first[prefix])) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < first.length - prefix &&
      words.every((w) => w.length > prefix + suffix && w[w.length - 1 - suffix] === first[first.length - 1 - suffix])
    ) {
      suffix += 1;
    }

    // Without a shared prefix AND suffix there is no common shape, only a
    // coincidence of role — collapsing those would invent a pattern.
    if (prefix === 0 || suffix === 0) {
      kept.push(...group);
      continue;
    }

    const pattern = [
      ...first.slice(0, prefix),
      '<name>',
      ...first.slice(first.length - suffix),
    ].join(' ');

    collapsed.push({
      role,
      pattern,
      count: group.length,
      examples: group.slice(0, 2).map((node) => node.name),
    });
  }

  return { nodes: kept, collapsed };
}

/** Scores a state against the command's keywords, by id and by node names. */
function scoreState(state: CapturedState, keywords: string[]): number {
  const haystack = `${state.id} ${state.label} ${state.nodes.map((n) => n.name).join(' ')}`
    .toLowerCase();
  return keywords.reduce((total, keyword) => (haystack.includes(keyword) ? total + 1 : total), 0);
}

export interface BoundOptions {
  maxStates?: number;
  maxNodesPerState?: number;
  minGroupSize?: number;
}

/**
 * Bounds a capture for one command.
 *
 * Order is load-bearing: drop, then collapse, then cap. Capping first would
 * spend the budget on nodes about to be discarded.
 */
export function boundCaptureForCommand(
  capture: StateCapture,
  command: string,
  options: BoundOptions = {},
): BoundedCapture {
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const maxNodes = options.maxNodesPerState ?? DEFAULT_MAX_NODES_PER_STATE;
  const keywords = tokenize(command);

  const scored = capture.states
    .map((state) => ({ state, score: scoreState(state, keywords) }))
    .sort((a, b) => b.score - a.score || a.state.id.localeCompare(b.state.id));

  const available = scored.map((entry) => ({ id: entry.state.id, score: entry.score }));

  const scoring = scored.filter((entry) => entry.score > 0);
  const chosenByScore = scoring.slice(0, maxStates);
  const chosenIds = new Set(chosenByScore.map((entry) => entry.state.id));

  // Anything one declared transition away, so a flow's other end travels with
  // it — a case that steps across a transition needs both sides present.
  //
  // Only ever a state that ACTUALLY EXISTS in the capture. A transition can
  // name a state the session never captured, and pulling that id in would put
  // it in `keptIds`, keep the dangling transition, and hand the grader a
  // cursor that advances to a state not in `states` — which crashed it.
  const existingIds = new Set(capture.states.map((s) => s.id));
  const neighbourIds = new Set<string>();
  for (const transition of capture.transitions) {
    if (chosenIds.has(transition.from) && !chosenIds.has(transition.to) && existingIds.has(transition.to)) {
      neighbourIds.add(transition.to);
    }
    if (chosenIds.has(transition.to) && !chosenIds.has(transition.from) && existingIds.has(transition.from)) {
      neighbourIds.add(transition.from);
    }
  }

  const chosen: StateSelectionRecord['chosen'] = [
    ...chosenByScore.map((entry) => ({ id: entry.state.id, score: entry.score, why: 'score' as const })),
    ...[...neighbourIds].map((id) => ({
      id,
      score: available.find((entry) => entry.id === id)?.score ?? 0,
      why: 'transition-neighbour' as const,
    })),
  ];
  const keptIds = new Set(chosen.map((entry) => entry.id));

  const excluded: StateSelectionRecord['excluded'] = scored
    .filter((entry) => !keptIds.has(entry.state.id))
    .map((entry) => ({
      id: entry.state.id,
      score: entry.score,
      why: entry.score === 0 ? ('below-cut' as const) : ('beyond-state-cap' as const),
    }));

  const states = capture.states
    .filter((state) => keptIds.has(state.id))
    .map((state) => {
      const named = state.nodes.filter((node) => node.name.trim().length > 0);
      const { nodes: afterCollapse, collapsed } = collapseRepeatedShapes(
        named,
        options.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE,
      );
      const capped = afterCollapse.slice(0, maxNodes);

      return {
        ...state,
        nodes: capped,
        // Monotonic, deliberately: bounding may only ever SET this. Dropping
        // unnamed nodes shrinks the count, so recomputing from scratch could
        // report `false` for a view already known incomplete — Finding 15's
        // failure reintroduced by an ordering detail.
        truncated: state.truncated || afterCollapse.length > maxNodes,
        collapsed: collapsed.length > 0 ? collapsed : state.collapsed,
      };
    });

  return {
    ...capture,
    states,
    transitions: capture.transitions.filter(
      (transition) => keptIds.has(transition.from) && keptIds.has(transition.to),
    ),
    selection: { keywords, available, chosen, excluded },
  };
}
