import { test, expect } from '@playwright/test';
import {
  boundCaptureForCommand,
  collapseRepeatedShapes,
  type AccessibilityNode,
  type CapturedState,
  type StateCapture,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-generation.md`, "Cost, capture
 * bounding, and the cache key" — not from reading `bounding.ts` (rule 4).
 *
 * Bounding is entirely selection, ordering and filtering, which is exactly the
 * shape that produces fixtures unable to distinguish right from wrong
 * behaviour (CLAUDE.md, "A discriminating property needs a discriminating
 * fixture"). So every fixture here is deliberately asymmetric: differing
 * scores, mixed named/unnamed nodes, groups both above and below the collapse
 * threshold. A fixture where everything is alike would pass against any
 * implementation.
 *
 * Design rules under test:
 *   B1  select by command; a state library must never go into one prompt
 *   B2  the selection record names available, chosen and EXCLUDED states
 *   B3  transition neighbours travel with a chosen state
 *   B4  unnameable nodes are dropped, and need no marker
 *   B5  `truncated` is MONOTONIC — bounding may set it, never clear it
 *   B6  repeated shapes collapse into a group; the view stays complete
 *   B7  order is drop -> collapse -> cap
 */

const node = (role: string, name: string): AccessibilityNode => ({ role, name, enabled: true });

const state = (id: string, nodes: AccessibilityNode[], truncated = false): CapturedState => ({
  id,
  label: id,
  url: `https://app.example/${id}`,
  nodes,
  truncated,
});

const capture = (states: CapturedState[], transitions: StateCapture['transitions'] = []): StateCapture => ({
  sessionId: 'test',
  states,
  transitions,
});

test.describe('capture bounding — state selection (B1-B3) @unit', () => {
  // Deliberately asymmetric: only one state mentions "upload", so a selector
  // that ignored the command entirely would keep the wrong ones.
  const library = capture([
    state('upload.workspace', [node('heading', 'Choose a workspace'), node('button', 'Upload')]),
    state('admin.users', [node('heading', 'Users'), node('button', 'New User')]),
    state('search.results', [node('heading', 'Results'), node('button', 'Search')]),
    state('files.tree', [node('heading', 'Workspaces'), node('treeitem', 'Expand A More options')]),
  ]);

  test('B1: only states matching the command are sent', () => {
    const bounded = boundCaptureForCommand(library, 'test the upload workspace step');
    const ids = bounded.states.map((s) => s.id);
    expect(ids).toContain('upload.workspace');
    expect(ids).not.toContain('admin.users');
  });

  test('B1: the state cap is respected', () => {
    const bounded = boundCaptureForCommand(library, 'workspace users results tree', {
      maxStates: 2,
    });
    expect(bounded.states.length).toBeLessThanOrEqual(2 + 0);
  });

  test('B2: the selection record names available, chosen AND excluded states', () => {
    const bounded = boundCaptureForCommand(library, 'test the upload workspace step');

    expect(bounded.selection.available.length).toBe(4);
    expect(bounded.selection.chosen.length).toBeGreaterThan(0);
    expect(bounded.selection.excluded.length).toBeGreaterThan(0);

    // The whole point: a reviewer can ask "was the state holding this fact
    // even offered to the model?" without re-running anything.
    const excludedIds = bounded.selection.excluded.map((e) => e.id);
    expect(excludedIds).toContain('admin.users');
    for (const entry of bounded.selection.excluded) {
      expect(['below-cut', 'beyond-state-cap']).toContain(entry.why);
    }
  });

  test('B2: the keywords actually scored on are recorded, stop words removed', () => {
    const bounded = boundCaptureForCommand(library, 'test the upload workspace step');
    expect(bounded.selection.keywords).toContain('upload');
    expect(bounded.selection.keywords).not.toContain('the');
    expect(bounded.selection.keywords).not.toContain('test');
  });

  test('B2: excluded states carry the score that dropped them', () => {
    // Discriminating: "upload" scores 1 on one state and 0 on the others, so
    // a record that fabricated scores would disagree.
    const bounded = boundCaptureForCommand(library, 'upload');
    const admin = bounded.selection.excluded.find((e) => e.id === 'admin.users');
    expect(admin).toBeDefined();
    expect(admin!.score).toBe(0);
    expect(admin!.why).toBe('below-cut');
  });

  test('B3: a transition neighbour travels with a chosen state', () => {
    // The neighbour must score ZERO, or this cannot distinguish "arrived as a
    // neighbour" from "arrived on its own score" — the first version of this
    // test named it `upload.folder`, which matched the command's "upload" and
    // so was chosen by score, making the neighbour path untested.
    const withFlow = capture(
      [
        state('upload.workspace', [node('heading', 'Choose a workspace')]),
        state('folder-picker', [node('heading', 'Select destination folder')]),
        state('admin.users', [node('heading', 'Users')]),
      ],
      [
        {
          from: 'upload.workspace',
          to: 'folder-picker',
          action: 'clicked a tile',
          verdict: 'consistent',
        },
      ],
    );

    const bounded = boundCaptureForCommand(withFlow, 'the upload workspace step');

    // Zero score, so it can only be here via the transition.
    expect(bounded.selection.available.find((a) => a.id === 'folder-picker')!.score).toBe(0);
    expect(bounded.states.map((s) => s.id)).toContain('folder-picker');
    expect(bounded.selection.chosen.find((c) => c.id === 'folder-picker')!.why).toBe(
      'transition-neighbour',
    );
    // And a zero-scoring state with no transition to a chosen one stays out.
    expect(bounded.states.map((s) => s.id)).not.toContain('admin.users');
  });

  test('B3: a transition whose other end was dropped is not sent', () => {
    const withDangling = capture(
      [state('upload.workspace', [node('heading', 'Choose a workspace')])],
      [{ from: 'upload.workspace', to: 'never-captured', action: 'clicked', verdict: 'consistent' }],
    );
    const bounded = boundCaptureForCommand(withDangling, 'upload workspace');
    expect(bounded.transitions).toEqual([]);
  });
});

test.describe('capture bounding — node filtering (B4-B7) @unit', () => {
  test('B4: unnameable nodes are dropped', () => {
    const withBlanks = capture([
      state('s', [node('button', 'Refresh'), node('generic', ''), node('button', '   ')]),
    ]);
    const bounded = boundCaptureForCommand(withBlanks, 'refresh');
    expect(bounded.states[0]!.nodes.map((n) => n.name)).toEqual(['Refresh']);
  });

  test('B5: truncated is MONOTONIC — dropping unnamed nodes cannot clear it', () => {
    // The exact hazard: the capture hit its cap (truncated) but, after unnamed
    // nodes are dropped, holds few enough nodes that a recomputation would say
    // "complete". That would re-enable refutation over nodes nobody saw.
    const alreadyTruncated = capture([
      state('s', [node('button', 'Refresh'), node('button', ''), node('button', '')], true),
    ]);
    const bounded = boundCaptureForCommand(alreadyTruncated, 'refresh', {
      maxNodesPerState: 100,
    });
    expect(bounded.states[0]!.nodes.length).toBe(1); // well under the cap
    expect(bounded.states[0]!.truncated).toBe(true); // and still incomplete
  });

  test('B5: bounding SETS truncated when its own cap bites', () => {
    const many = capture([
      state('s', Array.from({ length: 20 }, (_, i) => node('button', `Button ${i}`))),
    ]);
    const bounded = boundCaptureForCommand(many, 'button', { maxNodesPerState: 5 });
    expect(bounded.states[0]!.nodes.length).toBe(5);
    expect(bounded.states[0]!.truncated).toBe(true);
  });

  test('B5: an untruncated capture under the cap stays untruncated', () => {
    // Discriminating pair for the test above: without this, an implementation
    // that always set `truncated` would pass.
    const few = capture([state('s', [node('button', 'Refresh'), node('button', 'Export')])]);
    const bounded = boundCaptureForCommand(few, 'refresh export', { maxNodesPerState: 100 });
    expect(bounded.states[0]!.truncated).toBe(false);
  });

  test('B7: the cap is applied AFTER dropping, not before', () => {
    // 3 unnamed then 3 named. Capping first would keep the unnamed and yield
    // nothing useful; dropping first keeps all three named nodes.
    const mixed = capture([
      state('s', [
        node('button', ''),
        node('button', ''),
        node('button', ''),
        node('button', 'Alpha'),
        node('button', 'Beta'),
        node('button', 'Gamma'),
      ]),
    ]);
    const bounded = boundCaptureForCommand(mixed, 'alpha beta gamma', { maxNodesPerState: 3 });
    expect(bounded.states[0]!.nodes.map((n) => n.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(bounded.states[0]!.truncated).toBe(false);
  });
});

test.describe('capture bounding — collapsing repeated shapes (B6) @unit', () => {
  const rows = (count: number): AccessibilityNode[] =>
    Array.from({ length: count }, (_, i) => node('treeitem', `Expand WS-${i} More options`));

  test('B6: a repeated shape collapses into one group', () => {
    const { nodes, collapsed } = collapseRepeatedShapes(rows(25));
    expect(nodes).toEqual([]);
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]!.pattern).toBe('Expand <name> More options');
    expect(collapsed[0]!.count).toBe(25);
  });

  test('B6: a group below the threshold is left alone', () => {
    // Discriminating against "collapse everything": same shape, fewer nodes.
    const { nodes, collapsed } = collapseRepeatedShapes(rows(2), 4);
    expect(nodes.length).toBe(2);
    expect(collapsed).toEqual([]);
  });

  test('B6: same role but no shared shape is NOT collapsed', () => {
    // Guards against inventing a pattern from a coincidence of role.
    const unrelated = [
      node('button', 'Refresh'),
      node('button', 'Export'),
      node('button', 'Delete'),
      node('button', 'Archive'),
    ];
    const { nodes, collapsed } = collapseRepeatedShapes(unrelated, 4);
    expect(collapsed).toEqual([]);
    expect(nodes.length).toBe(4);
  });

  test('B6: collapsing does not set truncated — the view stays complete', () => {
    const treeState = capture([state('files', rows(25))]);
    const bounded = boundCaptureForCommand(treeState, 'expand more options');
    expect(bounded.states[0]!.truncated).toBe(false);
    expect(bounded.states[0]!.collapsed!.length).toBe(1);
  });

  test('B6: collapsing is what keeps a list-heavy state under the cap', () => {
    // 25 rows would blow a cap of 5; collapsed, they cost nothing.
    const treeState = capture([state('files', rows(25))]);
    const bounded = boundCaptureForCommand(treeState, 'expand more options', {
      maxNodesPerState: 5,
    });
    expect(bounded.states[0]!.nodes.length).toBe(0);
    expect(bounded.states[0]!.truncated).toBe(false);
  });
});
