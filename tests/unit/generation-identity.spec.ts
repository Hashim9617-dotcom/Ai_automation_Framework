import { test, expect } from '@playwright/test';
import {
  PROMPT_VERSION,
  assertionId,
  assertionIdsFor,
  captureDigest,
  existingCaseTitlesDigest,
  generationCacheKey,
  normalizeCommand,
  type AccessibilityNode,
  type BoundedCapture,
  type CapturedState,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-generation.md`, "The cache key" and
 * "Approval identity" — not from reading `identity.ts` (rule 4).
 *
 * Both things here fail SILENTLY when wrong, in opposite directions, so each
 * is tested both ways:
 *
 *   K1  captures differing in what the prompt USES -> DIFFERENT digests
 *       (a miss serves a stale proposal for a changed app)
 *   K2  captures differing only in what the prompt IGNORES -> SAME digest
 *       (a miss means the cache never hits and every run pays, silently)
 *   K3  every key component has its own falsifier (rule 3 applied to the key)
 *   A1  an assertion's id is content-derived, so changed content LAPSES approval
 *   A2  the PATH is part of the identity — same claim, different route, different id
 */

const node = (
  role: string,
  name: string,
  extra: Partial<AccessibilityNode> = {},
): AccessibilityNode => ({ role, name, enabled: true, ...extra });

const state = (id: string, nodes: AccessibilityNode[], truncated = false): CapturedState => ({
  id,
  label: id,
  url: `https://app.example/${id}`,
  nodes,
  truncated,
});

const bounded = (
  states: CapturedState[],
  overrides: Partial<BoundedCapture> = {},
): BoundedCapture => ({
  sessionId: 'session-a',
  states,
  transitions: [],
  selection: { keywords: ['x'], available: [], chosen: [], excluded: [] },
  ...overrides,
});

const BASE = bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])]);

test.describe('capture digest — differences the prompt USES (K1) @unit', () => {
  // Each pair differs in exactly ONE thing the prompt renders, so a digest
  // that ignored that thing would visibly collide.
  const cases: Array<{ what: string; changed: BoundedCapture }> = [
    {
      what: 'a node name',
      changed: bounded([state('workspace', [node('tab', 'Folder', { selected: true })])]),
    },
    {
      what: 'a node role',
      changed: bounded([state('workspace', [node('button', 'Workspace', { selected: true })])]),
    },
    {
      what: 'a selected value',
      changed: bounded([state('workspace', [node('tab', 'Workspace', { selected: false })])]),
    },
    {
      what: 'enabled',
      changed: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, enabled: false })]),
      ]),
    },
    {
      what: 'the truncation flag',
      changed: bounded([state('workspace', [node('tab', 'Workspace', { selected: true })], true)]),
    },
    {
      what: 'a state id',
      changed: bounded([state('folder', [node('tab', 'Workspace', { selected: true })])]),
    },
    {
      what: 'an added node',
      changed: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true }), node('button', 'Next')]),
      ]),
    },
    {
      what: 'a declared transition',
      changed: bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
        transitions: [{ from: 'workspace', to: 'folder', action: 'clicked', verdict: 'consistent' }],
      }),
    },
    {
      what: 'a transition verdict',
      changed: bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
        transitions: [{ from: 'workspace', to: 'folder', action: 'clicked', verdict: 'suspect' }],
      }),
    },
    {
      what: 'a collapsed group',
      changed: bounded([
        {
          ...state('workspace', [node('tab', 'Workspace', { selected: true })]),
          collapsed: [
            { role: 'treeitem', pattern: 'Expand <name> More', count: 9, examples: ['Expand A More'] },
          ],
        },
      ]),
    },
  ];

  for (const c of cases) {
    test(`K1: ${c.what} changes the digest`, () => {
      expect(captureDigest(c.changed)).not.toBe(captureDigest(BASE));
    });
  }
});

test.describe('capture digest — differences the prompt IGNORES (K2) @unit', () => {
  test('K2: the session id does not change the digest', () => {
    const other = bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
      sessionId: 'a-completely-different-session',
    });
    expect(captureDigest(other)).toBe(captureDigest(BASE));
  });

  test('K2: the selection record does not change the digest', () => {
    // Bounding's bookkeeping is provenance for humans; the model never sees it.
    const other = bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
      selection: {
        keywords: ['totally', 'different'],
        available: [{ id: 'workspace', score: 9 }],
        chosen: [{ id: 'workspace', score: 9, why: 'score' }],
        excluded: [{ id: 'other', score: 0, why: 'below-cut' }],
      },
    });
    expect(captureDigest(other)).toBe(captureDigest(BASE));
  });

  test('K2: a state label and url do not change the digest', () => {
    const other = bounded([
      {
        ...state('workspace', [node('tab', 'Workspace', { selected: true })]),
        label: 'Some Human Label',
        url: 'https://elsewhere.example/x?token=abc',
      },
    ]);
    expect(captureDigest(other)).toBe(captureDigest(BASE));
  });

  test('K2: state ORDER does not change the digest', () => {
    // Same content rendered in a different order is the same prompt.
    const a = bounded([state('a', [node('button', 'A')]), state('b', [node('button', 'B')])]);
    const b = bounded([state('b', [node('button', 'B')]), state('a', [node('button', 'A')])]);
    expect(captureDigest(a)).toBe(captureDigest(b));
    // Discriminating: the states really are distinguishable, so this is not
    // passing because both digests are of an empty capture.
    expect(captureDigest(a)).not.toBe(captureDigest(BASE));
  });
});

test.describe('the cache key — every component is load-bearing (K3) @unit', () => {
  const parts = {
    promptVersion: PROMPT_VERSION,
    command: 'test the upload workspace step',
    capture: BASE,
    existingCaseTitles: ['Admin lists > Users list loads'],
  };

  test('K3: promptVersion is part of the key', () => {
    expect(generationCacheKey({ ...parts, promptVersion: 'gen-999' })).not.toBe(
      generationCacheKey(parts),
    );
  });

  test('K3: the command is part of the key', () => {
    expect(generationCacheKey({ ...parts, command: 'something else entirely' })).not.toBe(
      generationCacheKey(parts),
    );
  });

  test('K3: the capture is part of the key', () => {
    const changed = bounded([state('workspace', [node('tab', 'Folder', { selected: true })])]);
    expect(generationCacheKey({ ...parts, capture: changed })).not.toBe(generationCacheKey(parts));
  });

  test('K3: the existing-case titles are part of the key', () => {
    expect(
      generationCacheKey({ ...parts, existingCaseTitles: [...parts.existingCaseTitles, 'New test'] }),
    ).not.toBe(generationCacheKey(parts));
  });

  test('equivalent phrasings of a command share one entry', () => {
    // Otherwise the cache never hits on ordinary rewording.
    expect(normalizeCommand('test the upload workspace step')).toBe(
      normalizeCommand('Workspace upload step'),
    );
    expect(generationCacheKey({ ...parts, command: 'Workspace upload step' })).toBe(
      generationCacheKey(parts),
    );
  });

  test('a genuinely different command does NOT share an entry', () => {
    // The discriminating half of the test above.
    expect(normalizeCommand('upload workspace')).not.toBe(normalizeCommand('admin users list'));
  });

  test('title order does not change the titles digest, but content does', () => {
    expect(existingCaseTitlesDigest(['a', 'b'])).toBe(existingCaseTitlesDigest(['b', 'a']));
    expect(existingCaseTitlesDigest(['a', 'b'])).not.toBe(existingCaseTitlesDigest(['a', 'c']));
  });
});

test.describe('assertion identity — approvals lapse, never transfer (A1-A2) @unit', () => {
  const claim = {
    kind: 'assert' as const,
    role: 'tab',
    name: 'Folder',
    property: 'selected' as const,
    expected: true,
  };

  test('A1: the same claim by the same path has a stable id', () => {
    expect(assertionId('workspace', ['clicked "WS-ALPHA"'], claim)).toBe(
      assertionId('workspace', ['clicked "WS-ALPHA"'], claim),
    );
  });

  test('A1: changing the asserted VALUE changes the id — approval lapses', () => {
    expect(assertionId('workspace', [], { ...claim, expected: false })).not.toBe(
      assertionId('workspace', [], claim),
    );
  });

  test('A1: changing the target changes the id', () => {
    expect(assertionId('workspace', [], { ...claim, name: 'Workspace' })).not.toBe(
      assertionId('workspace', [], claim),
    );
    expect(assertionId('workspace', [], { ...claim, role: 'button' })).not.toBe(
      assertionId('workspace', [], claim),
    );
    expect(assertionId('workspace', [], { ...claim, property: 'present' })).not.toBe(
      assertionId('workspace', [], claim),
    );
  });

  test('A2: the PATH is part of the identity — same claim, different route', () => {
    // "Folder is selected" after clicking a workspace tile is a different
    // claim from the same sentence after clicking Next. One must not approve
    // the other.
    const viaTile = assertionId('workspace', ['clicked "WS-ALPHA"'], claim);
    const viaNext = assertionId('workspace', ['clicked Next'], claim);
    expect(viaTile).not.toBe(viaNext);
  });

  test('A2: the entry state is part of the identity', () => {
    expect(assertionId('folder', [], claim)).not.toBe(assertionId('workspace', [], claim));
  });

  test('A2: action ORDER matters', () => {
    expect(assertionId('s', ['a', 'b'], claim)).not.toBe(assertionId('s', ['b', 'a'], claim));
  });

  test('assertionIdsFor threads the preceding actions to each assertion', () => {
    const ids = assertionIdsFor({
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' },
        claim,
        { kind: 'action', description: 'clicked Root folder' },
        { ...claim, name: 'Upload' },
      ],
    });

    expect(ids.length).toBe(2);
    expect(ids[0]!.precedingActions).toEqual(['clicked "WS-ALPHA"']);
    expect(ids[1]!.precedingActions).toEqual(['clicked "WS-ALPHA"', 'clicked Root folder']);
    // Discriminating: the two assertions differ, so identical ids would be a bug.
    expect(ids[0]!.assertionId).not.toBe(ids[1]!.assertionId);
  });

  test('an id does NOT depend on the step index', () => {
    // Otherwise inserting an unrelated assertion earlier in the case would
    // lapse every approval below it, for no reason a human would recognise.
    const withPrefix = assertionIdsFor({
      entryState: 'workspace',
      steps: [{ ...claim, name: 'Workspace' }, claim],
    });
    const withoutPrefix = assertionIdsFor({ entryState: 'workspace', steps: [claim] });
    expect(withPrefix[1]!.assertionId).toBe(withoutPrefix[0]!.assertionId);
  });
});
