import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  PROMPT_VERSION,
  boundCaptureForCommand,
  buildPromptInput,
  captureDigest,
  findRepoRoot,
  generationCacheKey,
  normalizeCommand,
  promptInputDigest,
  renderGenerationPrompt,
  type AccessibilityNode,
  type BoundedCapture,
  type CapturedState,
  type StateCapture,
  type PromptInput,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-generation.md`, "The cache key" and
 * "Cost, capture bounding, and the cache key" — not from reading `prompt.ts`
 * (rule 4).
 *
 * The cache fails silently in two opposite directions:
 *
 *   K1  a difference the prompt RENDERS -> DIFFERENT digest
 *       (a miss serves a stale proposal for an app that changed)
 *   K2  a difference the prompt IGNORES -> SAME digest
 *       (a miss means the cache never hits and every run pays, silently)
 *
 * **Every case below is checked against the RENDERED PROMPT, not only against
 * the digest**, and that is the point of this file rather than a flourish. A
 * digest test alone can only pin what the digest does today: it cannot notice
 * a field added to the prompt and forgotten in the digest, and it cannot
 * notice a K2 case asserting an equivalence the model does not actually see.
 * Two captures share a key IF AND ONLY IF they ask the model the same
 * question, so the prompt is the source of truth for both directions.
 *
 *   K3  every component of the key has its own falsifier (rule 3)
 *   K4  the digest cannot fall behind the prompt by construction
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

const COMMAND = 'test the upload workspace step';
const TITLES = ['Admin lists > Users list loads'];

const inputFor = (capture: BoundedCapture, command = COMMAND, titles = TITLES): PromptInput =>
  buildPromptInput({ capture, command, existingCaseTitles: titles });

const promptFor = (capture: BoundedCapture, command = COMMAND, titles = TITLES): string =>
  renderGenerationPrompt(inputFor(capture, command, titles));

const digestFor = (capture: BoundedCapture, command = COMMAND, titles = TITLES): string =>
  promptInputDigest(inputFor(capture, command, titles));

const BASE = bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])]);

/** A capture whose one collapsed group can be varied a field at a time. */
const withCollapsed = (
  over: Partial<{ count: number; examples: string[]; pattern: string }> = {},
): BoundedCapture =>
  bounded([
    {
      ...state('workspace', [node('tab', 'Workspace', { selected: true })]),
      collapsed: [
        {
          role: 'treeitem',
          pattern: over.pattern ?? 'Expand <name> More',
          count: over.count ?? 9,
          examples: over.examples ?? ['Expand A More'],
        },
      ],
    },
  ]);

/** Likewise for a single declared transition. */
const withTransition = (verdict: 'consistent' | 'suspect', action = 'clicked'): BoundedCapture =>
  bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
    transitions: [{ from: 'workspace', to: 'folder', action, verdict }],
  });

test.describe('the prompt digest — differences the prompt RENDERS (K1) @unit', () => {
  /**
   * `from` defaults to BASE. It is spelled out wherever BASE would NOT be a
   * discriminating baseline — and that distinction is the whole point of this
   * table rather than a tidiness.
   *
   * Mutation testing on 2026-09-07 found two cases here that proved nothing.
   * "A transition verdict" compared a capture with NO transitions against one
   * with a `suspect` transition, so dropping `verdict` from the serialiser left
   * the two still differing on `from>to:action` and the test still passed. The
   * collapsed-group `examples` case had the same shape. Both read sensibly and
   * neither could fail:
   *
   * > **A test of a DISCRIMINATING property is only real if its fixture would
   * > produce a different result under the wrong behaviour** (CLAUDE.md).
   *
   * So a case that names a FIELD pairs two captures differing in that field
   * alone; only a case that names a whole feature ("a declared transition",
   * "a collapsed group") may use BASE, because there the absence IS the
   * difference being tested.
   */
  const cases: Array<{ what: string; from?: BoundedCapture; changed: BoundedCapture }> = [
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
      // The FEATURE: no transition at all, versus one. BASE is the right
      // baseline here because the absence is the difference.
      what: 'a declared transition at all',
      changed: withTransition('consistent'),
    },
    {
      // The FIELD: two captures alike but for the cross-check verdict. A
      // `suspect` transition cannot ground anything, so a digest blind to it
      // would serve a proposal built on evidence the cross-check rejected.
      what: 'a transition verdict',
      from: withTransition('consistent'),
      changed: withTransition('suspect'),
    },
    {
      what: 'a transition action',
      from: withTransition('consistent', 'clicked "WS-ALPHA"'),
      changed: withTransition('consistent', 'clicked Next'),
    },
    {
      what: 'a collapsed group at all',
      changed: withCollapsed(),
    },
    {
      what: "a collapsed group's examples",
      from: withCollapsed({ examples: ['Expand A More'] }),
      changed: withCollapsed({ examples: ['Expand B More'] }),
    },
    {
      what: "a collapsed group's count",
      from: withCollapsed({ count: 9 }),
      changed: withCollapsed({ count: 25 }),
    },
    {
      what: "a collapsed group's pattern",
      from: withCollapsed({ pattern: 'Expand <name> More' }),
      changed: withCollapsed({ pattern: 'Collapse <name> More options' }),
    },
    {
      what: 'expanded being recorded at all',
      changed: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, expanded: true })]),
      ]),
    },
    {
      what: 'an expanded VALUE',
      from: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, expanded: true })]),
      ]),
      changed: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, expanded: false })]),
      ]),
    },
    {
      what: 'a checked VALUE',
      from: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, checked: true })]),
      ]),
      changed: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, checked: false })]),
      ]),
    },
    {
      what: 'a level VALUE',
      from: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, level: 2 })]),
      ]),
      changed: bounded([
        state('workspace', [node('tab', 'Workspace', { selected: true, level: 3 })]),
      ]),
    },
  ];

  for (const c of cases) {
    test(`K1: ${c.what} changes the prompt, so it must change the digest`, () => {
      const from = c.from ?? BASE;
      // The premise first: if the prompt is unchanged, a differing digest would
      // be the K2 failure and an identical one would be correct. Asserting the
      // premise is what stops this test pinning the digest to itself.
      expect(promptFor(c.changed)).not.toBe(promptFor(from));
      expect(digestFor(c.changed)).not.toBe(digestFor(from));
    });
  }

  test('K1: node ORDER inside a state changes the prompt, so it changes the digest', () => {
    // AX order is document order, so it is page structure the model reads.
    // Unlike state order (below) it is NOT canonicalised, and the two must not
    // share a cache entry.
    const a = bounded([state('s', [node('button', 'A'), node('button', 'B')])]);
    const b = bounded([state('s', [node('button', 'B'), node('button', 'A')])]);
    expect(promptFor(a)).not.toBe(promptFor(b));
    expect(digestFor(a)).not.toBe(digestFor(b));
  });
});

test.describe('the prompt digest — differences the prompt IGNORES (K2) @unit', () => {
  /**
   * Each case proves the equivalence at the prompt before asserting it at the
   * digest. The `not.toBe(promptFor(BASE))` line in each is the discriminating
   * half: without it, two prompts that were both empty would pass.
   */
  const sameQuestion = (other: BoundedCapture): void => {
    expect(promptFor(other)).toBe(promptFor(BASE));
    expect(digestFor(other)).toBe(digestFor(BASE));
  };

  test('K2: the session id does not reach the model, so it does not change the digest', () => {
    sameQuestion(
      bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
        sessionId: 'a-completely-different-session',
      }),
    );
  });

  test('K2: the selection record does not reach the model', () => {
    // Bounding's bookkeeping is provenance for humans. Confirmed against the
    // builder: `PromptInput` has no field for it, so no renderer can print it.
    sameQuestion(
      bounded([state('workspace', [node('tab', 'Workspace', { selected: true })])], {
        selection: {
          keywords: ['totally', 'different'],
          available: [{ id: 'workspace', score: 9 }],
          chosen: [{ id: 'workspace', score: 9, why: 'score' }],
          excluded: [{ id: 'other', score: 0, why: 'below-cut' }],
        },
      }),
    );
  });

  test('K2: a state label and url do not reach the model', () => {
    sameQuestion(
      bounded([
        {
          ...state('workspace', [node('tab', 'Workspace', { selected: true })]),
          label: 'Some Human Label',
          url: 'https://elsewhere.example/x?token=abc',
        },
      ]),
    );
  });

  /**
   * **This case moved out of K2 on 2026-09-07, and the move is the finding.**
   *
   * It used to assert that capture order was ignorable, on the grounds that
   * flow is carried by declared transitions rather than list position. That
   * justification has a known exception the design itself names: where a
   * transition is UNDECLARED, capture order was the last remaining hint of
   * which state came first. Sorting it away lost that silently — nothing
   * failed, the model just got a flatter picture.
   *
   * So the walk is now an explicit `visitOrder` field, and the consequence is
   * that capture order is no longer ignorable: two different walks are two
   * different pieces of evidence and must not share one answer. The cache is
   * order-sensitive again — but for a REASON now, rather than as an accident
   * of list layout, and what it buys is that flow survives canonicalisation.
   *
   * What sorting still buys is below: the rendered layout is canonical.
   */
  const orderedA = bounded([
    state('a', [node('button', 'A')]),
    state('b', [node('button', 'B')]),
  ]);
  const orderedB = bounded([
    state('b', [node('button', 'B')]),
    state('a', [node('button', 'A')]),
  ]);

  test('K1: capture order IS the visit sequence, so it changes the prompt', () => {
    expect(promptFor(orderedA)).not.toBe(promptFor(orderedB));
    expect(digestFor(orderedA)).not.toBe(digestFor(orderedB));

    // Discriminating: the difference is the walk, not the content.
    expect(promptFor(orderedA)).toContain('### state: a  [visited 1]');
    expect(promptFor(orderedB)).toContain('### state: a  [visited 2]');
  });

  test('K2: the rendered state LAYOUT is canonical by id, whatever the capture order', () => {
    // What the sort buys now that `visitOrder` carries the walk: the model
    // always meets the states in one stable order, so the only difference
    // between two walks is the declared sequence rather than the page layout.
    const headings = (capture: BoundedCapture): string[] =>
      [...promptFor(capture).matchAll(/^### state: (\S+)/gm)].map((m) => m[1]!);

    expect(headings(orderedA)).toEqual(['a', 'b']);
    expect(headings(orderedB)).toEqual(['a', 'b']);
    // Discriminating: it really did find both headings.
    expect(headings(orderedA).length).toBe(2);
  });

  test('K2: collapsed-group order does not change the prompt either', () => {
    // Found by mutation on 2026-09-07: the builder sorted collapsed groups and
    // NOTHING failed when that sort was removed. Rule 3 — a canonicalisation
    // with no falsifier is decoration, and it either earns a test or comes out.
    // It earns one: bounding derives these groups from a Map, so their order is
    // an artifact of role insertion, not of the page.
    const a: BoundedCapture = bounded([
      {
        ...state('s', [node('button', 'A')]),
        collapsed: [
          { role: 'treeitem', pattern: 'Expand <name> More', count: 9, examples: ['x'] },
          { role: 'row', pattern: 'Select <name> row', count: 5, examples: ['y'] },
        ],
      },
    ]);
    const b: BoundedCapture = bounded([
      {
        ...state('s', [node('button', 'A')]),
        collapsed: [
          { role: 'row', pattern: 'Select <name> row', count: 5, examples: ['y'] },
          { role: 'treeitem', pattern: 'Expand <name> More', count: 9, examples: ['x'] },
        ],
      },
    ]);

    expect(promptFor(a)).toBe(promptFor(b));
    expect(digestFor(a)).toBe(digestFor(b));
    // Discriminating: both groups really are rendered, so this is not passing
    // on two prompts that show no groups at all.
    expect(promptFor(a)).toContain('Expand <name> More');
    expect(promptFor(a)).toContain('Select <name> row');
  });

  test('K2: transition order does not change the prompt either', () => {
    const t1 = { from: 'a', to: 'b', action: 'clicked one', verdict: 'consistent' as const };
    const t2 = { from: 'a', to: 'c', action: 'clicked two', verdict: 'consistent' as const };
    const states = [
      state('a', [node('button', 'A')]),
      state('b', [node('button', 'B')]),
      state('c', [node('button', 'C')]),
    ];

    const a = bounded(states, { transitions: [t1, t2] });
    const b = bounded(states, { transitions: [t2, t1] });

    expect(promptFor(a)).toBe(promptFor(b));
    expect(digestFor(a)).toBe(digestFor(b));
    expect(promptFor(a)).toContain('clicked one');
    expect(promptFor(a)).toContain('clicked two');
  });
});

test.describe('the cache key — every component is load-bearing (K3) @unit', () => {
  test('K3: promptVersion is part of the key', () => {
    const changed = buildPromptInput({
      capture: BASE,
      command: COMMAND,
      existingCaseTitles: TITLES,
      promptVersion: 'gen-999',
    });
    expect(generationCacheKey(changed)).not.toBe(generationCacheKey(inputFor(BASE)));
  });

  test('K3: the command is part of the key', () => {
    expect(generationCacheKey(inputFor(BASE, 'admin roles list loads'))).not.toBe(
      generationCacheKey(inputFor(BASE)),
    );
  });

  test('K3: the capture is part of the key', () => {
    const changed = bounded([state('workspace', [node('tab', 'Folder', { selected: true })])]);
    expect(generationCacheKey(inputFor(changed))).not.toBe(generationCacheKey(inputFor(BASE)));
  });

  test('K3: the existing-case titles are part of the key', () => {
    expect(generationCacheKey(inputFor(BASE, COMMAND, [...TITLES, 'New test']))).not.toBe(
      generationCacheKey(inputFor(BASE)),
    );
  });

  test('equivalent phrasings of a command share one entry', () => {
    // Otherwise the cache never hits on ordinary rewording. The raw command is
    // still what the model READS — only the key is coarsened — so both prompts
    // differ while the key does not.
    expect(normalizeCommand('test the upload workspace step')).toBe(
      normalizeCommand('Workspace upload step'),
    );
    expect(generationCacheKey(inputFor(BASE, 'Workspace upload step'))).toBe(
      generationCacheKey(inputFor(BASE)),
    );
    expect(promptFor(BASE, 'Workspace upload step')).not.toBe(promptFor(BASE));
  });

  test('a genuinely different command does NOT share an entry', () => {
    // The discriminating half of the test above.
    expect(normalizeCommand('upload workspace')).not.toBe(normalizeCommand('admin users list'));
  });

  test('title order does not change the key, but title content does', () => {
    expect(generationCacheKey(inputFor(BASE, COMMAND, ['a', 'b']))).toBe(
      generationCacheKey(inputFor(BASE, COMMAND, ['b', 'a'])),
    );
    expect(generationCacheKey(inputFor(BASE, COMMAND, ['a', 'b']))).not.toBe(
      generationCacheKey(inputFor(BASE, COMMAND, ['a', 'c'])),
    );
  });

  test("the provenance capture digest tracks the capture and not the command", () => {
    // It answers "approved when the app looked like this", so a reworded
    // command must not appear to be a different app.
    const changed = bounded([state('workspace', [node('tab', 'Folder', { selected: true })])]);
    expect(captureDigest(BASE)).toBe(captureDigest(BASE));
    expect(captureDigest(changed)).not.toBe(captureDigest(BASE));
  });
});

test.describe('the digest cannot fall behind the prompt (K4) @unit', () => {
  test('K4: a field that reaches the prompt but not the digest throws', () => {
    // The compile-time half is `PromptInputDigestFields`: adding a field to
    // `PromptInput` stops the field map compiling. This is the runtime half,
    // for a field added to the OBJECT rather than the type — and it follows
    // CLAUDE.md's rule that a thing which scans asserts its own effect instead
    // of reporting a comfortable answer.
    const smuggled = { ...inputFor(BASE), extraContext: 'the model sees this' } as PromptInput;
    expect(() => promptInputDigest(smuggled)).toThrow(/extraContext/);
  });

  test('K4: every field of the prompt input has its own falsifier', () => {
    // Rule 3 applied field by field: change any one and the digest must move,
    // or that field contributes nothing and the map entry is decoration.
    //
    // The `Record<keyof PromptInput, ...>` type is what keeps this honest over
    // time — a field added to `PromptInput` stops this object compiling until
    // someone writes down how to vary it, in the same way the production field
    // map stops compiling until someone writes down how to digest it.
    const input = inputFor(BASE);

    const variants: Record<keyof PromptInput, PromptInput> = {
      promptVersion: { ...input, promptVersion: 'gen-999' },
      commandKey: { ...input, commandKey: 'entirely different' },
      states: { ...input, states: [{ ...input.states[0]!, id: 'renamed' }] },
      transitions: {
        ...input,
        transitions: [{ from: 'a', to: 'b', action: 'clicked', verdict: 'consistent' }],
      },
      existingCaseTitles: { ...input, existingCaseTitles: ['a completely different test'] },
      // The one deliberate exception: the raw command is RENDERED but keyed
      // through `commandKey`, so rewordings share an entry. Its falsifier is
      // the prompt, not the digest — see the rewording test above.
      command: { ...input, command: 'phrased some other way' },
    };

    // Guards the exception from silently widening: every other field must move
    // the digest, and this is the only one allowed not to.
    expect(Object.keys(variants).sort()).toEqual(Object.keys(input).sort());

    for (const [field, variant] of Object.entries(variants)) {
      if (field === 'command') {
        expect(promptInputDigest(variant), field).toBe(promptInputDigest(input));
        expect(renderGenerationPrompt(variant)).not.toBe(renderGenerationPrompt(input));
        continue;
      }
      expect(promptInputDigest(variant), field).not.toBe(promptInputDigest(input));
    }
  });

  test('K4: the prompt version the builder stamps is the exported one', () => {
    expect(inputFor(BASE).promptVersion).toBe(PROMPT_VERSION);
    expect(promptFor(BASE)).toContain(PROMPT_VERSION);
  });
});

test.describe('the rendered prompt carries what grading depends on @unit', () => {
  test('a truncated state says so, because absence proves nothing there', () => {
    const prompt = promptFor(bounded([state('s', [node('button', 'A')], true)]));
    expect(prompt).toContain('TRUNCATED');
  });

  test('a collapsed group is shown as a summarised group, not as absence', () => {
    const prompt = promptFor(
      bounded([
        {
          ...state('s', [node('button', 'A')]),
          collapsed: [
            {
              role: 'treeitem',
              pattern: 'Expand <name> More options',
              count: 25,
              examples: ['ABCD', 'test 123'],
            },
          ],
        },
      ]),
    );
    expect(prompt).toContain('25 x treeitem matching "Expand <name> More options"');
    expect(prompt).toContain('"ABCD"');
  });

  test("the human's visit order reaches the model, and is marked as a hint only", () => {
    // Where a transition is UNDECLARED — one of the three causes of a thin
    // capture — visit order is the last remaining hint of which state came
    // first. Sorting states by id for the cache would throw it away silently,
    // so it travels as a field and must actually be rendered.
    const walk = bounded([
      state('later', [node('button', 'B')]),
      state('earlier', [node('button', 'A')]),
    ]);
    const prompt = promptFor(walk);

    expect(prompt).toContain('### state: later  [visited 1]');
    expect(prompt).toContain('### state: earlier  [visited 2]');

    // And the guard that stops it becoming mistake #2 by another route: a
    // sequence hint must never be read as a claim about what an action causes.
    expect(prompt).toContain('NOT evidence that one state leads to');
  });

  test('a capture with no transitions says so rather than staying silent', () => {
    // Silence would leave the model to supply the conventional wizard model,
    // which is mistake #2 exactly.
    expect(promptFor(BASE)).toContain('None declared');
  });

  test("a transition's cross-check verdict reaches the model", () => {
    const prompt = promptFor(
      bounded([state('a', [node('button', 'A')]), state('b', [node('button', 'B')])], {
        transitions: [{ from: 'a', to: 'b', action: 'clicked A', verdict: 'suspect' }],
      }),
    );
    expect(prompt).toContain('cross-check: suspect');
  });
});

/**
 * K5 — THE STRUCTURAL GUARANTEE ONLY HOLDS IF THE BUILDER CANNOT REACH
 * ANYTHING ELSE.
 *
 * "The digest and the prompt derive from the same object" is a guarantee only
 * while that object is the builder's ONLY source. A second argument, a
 * module-level constant, a `process.env` read, or a reach back into the
 * capture would each let data enter the prompt without entering the digest —
 * and the divergence the field map designs out walks back in through the side
 * door, silently, exactly as before.
 *
 * The compile-time field map cannot see any of that: it constrains what
 * `PromptInput` may contain, not where the renderer may read from. So the
 * property is pinned here directly.
 *
 * **What these tests cover:** the renderer's arity, the exact set of fields it
 * reads off its argument, that it is a pure function of that argument, and
 * that its source references no external data source.
 *
 * **What they do not cover:** an exotic read this token list does not name.
 * The list is a guard against the plausible edit, not a proof of purity —
 * stated plainly so nobody reads more into a green run than is there.
 */
test.describe('the builder reads its argument and nothing else (K5) @unit', () => {
  const SOURCE = readFileSync(
    path.join(findRepoRoot(), 'packages/shared/src/generation/prompt.ts'),
    'utf8',
  );

  /** Everything from the first render helper to the end of the file. */
  const renderSection = (): string => {
    const start = SOURCE.indexOf('const renderNode');
    if (start === -1) throw new Error('could not find the render section — this test is scanning nothing');
    const section = SOURCE.slice(start);
    // Asserts its own effect: a scan that found the wrong region would pass
    // every forbidden-token check below while reading none of the renderer.
    if (!section.includes('export function renderGenerationPrompt')) {
      throw new Error('the render section does not contain renderGenerationPrompt — wrong region');
    }
    return section;
  };

  test('K5: the renderer takes exactly one argument', () => {
    expect(renderGenerationPrompt.length).toBe(1);
  });

  /**
   * The read set is an ABSENCE claim — "the renderer touched nothing else" —
   * so rule 1 applies to this test as it does to the grader:
   *
   * > **An absence claim needs a completeness guarantee over whatever it counts
   * > across.** (Finding 15.)
   *
   * A proxy records only the paths the fixture actually executed. The first
   * version of this test ran ONE fixture and left roughly half the render
   * branches unvisited — a read inside `if (state.truncated)`, or in the empty-
   * transitions arm, would have gone unrecorded and the test would have
   * reported a clean read set anyway. That is the same shape as grading a
   * truncated capture as though absence were evidence.
   *
   * So the fixtures below are a MATRIX over the render function's branches,
   * and each one asserts a marker proving it reached the branch it is there
   * for. A fixture that silently stopped exercising its branch fails rather
   * than quietly shrinking the coverage this claim rests on.
   */
  interface Branch {
    what: string;
    capture: BoundedCapture;
    titles?: string[];
    /** Proof the branch was reached. */
    shows: string[];
    /** Proof the opposite arm was not taken. */
    hides?: string[];
  }

  const rich = (over: Partial<AccessibilityNode>): BoundedCapture =>
    bounded([state('s', [node('tab', 'Rich', over)])]);

  const branches: Branch[] = [
    { what: 'no states at all', capture: bounded([]), shows: ['_No states were captured'] },
    { what: 'a state present', capture: BASE, shows: ['### state:'] },
    {
      what: 'a truncated state',
      capture: bounded([state('s', [node('button', 'A')], true)]),
      shows: ['TRUNCATED'],
    },
    {
      what: 'an untruncated state',
      capture: bounded([state('s', [node('button', 'A')])]),
      shows: ['### state:'],
      hides: ['TRUNCATED'],
    },
    {
      what: 'collapsed groups present',
      capture: withCollapsed(),
      shows: ['Repeated shapes'],
    },
    { what: 'no collapsed groups', capture: BASE, shows: ['### state:'], hides: ['Repeated shapes'] },
    {
      what: 'a declared transition',
      capture: withTransition('suspect'),
      shows: ['cross-check: suspect'],
    },
    { what: 'no transitions', capture: BASE, shows: ['None declared'] },
    { what: 'existing titles', capture: BASE, shows: ['- Admin lists'] },
    { what: 'no existing titles', capture: BASE, titles: [], shows: ['_None._'] },
    {
      what: 'a node with no flags at all',
      capture: bounded([state('s', [node('button', 'Plain')])]),
      shows: ['- button "Plain"'],
      hides: ['- button "Plain" ('],
    },
    { what: 'a disabled node', capture: rich({ enabled: false }), shows: ['(disabled'] },
    { what: 'a selected node', capture: rich({ selected: false }), shows: ['selected=false'] },
    { what: 'an expanded node', capture: rich({ expanded: true }), shows: ['expanded=true'] },
    { what: 'a checked node', capture: rich({ checked: false }), shows: ['checked=false'] },
    { what: 'a node with a level', capture: rich({ level: 3 }), shows: ['level=3'] },
    { what: 'a visit order', capture: BASE, shows: ['[visited 1]'] },
  ];

  /** Every field path actually present on the object — no hand-maintained list to drift. */
  const pathsPresent = (value: unknown, prefix: string, into: Set<string>): Set<string> => {
    if (value === null || typeof value !== 'object') return into;
    if (Array.isArray(value)) {
      for (const item of value) pathsPresent(item, `${prefix}[]`, into);
      return into;
    }
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      into.add(path);
      pathsPresent(child, path, into);
    }
    return into;
  };

  /** Records every field path the renderer reads, at any depth. */
  const watch = <T>(value: T, prefix: string, read: Set<string>): T => {
    if (value === null || typeof value !== 'object') return value;
    return new Proxy(value as object, {
      get(target, property, receiver) {
        const raw = Reflect.get(target, property, receiver);
        if (typeof property === 'symbol' || typeof raw === 'function') return raw;
        if (Array.isArray(target)) return watch(raw, `${prefix}[]`, read);
        const path = prefix ? `${prefix}.${String(property)}` : String(property);
        read.add(path);
        return watch(raw, path, read);
      },
    }) as T;
  };

  test('K5: the renderer reads only fields that exist on its argument', () => {
    const read = new Set<string>();
    const present = new Set<string>();

    for (const branch of branches) {
      const input = inputFor(branch.capture, COMMAND, branch.titles ?? TITLES);

      // The branch was reached. Without this the matrix could silently stop
      // covering what it claims to cover, and the read set would narrow with
      // nothing failing — the completeness guarantee this claim rests on.
      const rendered = renderGenerationPrompt(input);
      for (const marker of branch.shows) {
        expect(rendered, `${branch.what} should show ${marker}`).toContain(marker);
      }
      for (const marker of branch.hides ?? []) {
        expect(rendered, `${branch.what} should not show ${marker}`).not.toContain(marker);
      }

      pathsPresent(input, '', present);
      renderGenerationPrompt(watch(input, '', read));
    }

    // Nothing outside the declared shape was touched, at any depth. Combined
    // with the digest covering every field of that shape, the loop closes:
    // the renderer can only emit what the digest has hashed.
    expect([...read].filter((path) => !present.has(path)).sort()).toEqual([]);

    // Discriminating: it really did read, at every level, so an empty or
    // shallow read set would not pass.
    for (const path of [
      'promptVersion',
      'command',
      'states',
      'states[].id',
      'states[].visitOrder',
      'states[].truncated',
      'states[].nodes',
      'states[].nodes[].role',
      'states[].nodes[].enabled',
      'states[].collapsed',
      'states[].collapsed[].pattern',
      'transitions',
      'transitions[].verdict',
      'existingCaseTitles',
    ]) {
      expect(read.has(path), `expected the renderer to read ${path}`).toBe(true);
    }

    // And the one field the prompt does NOT read: `commandKey` exists purely
    // to coarsen the cache key. If this ever flips, the rewording behaviour
    // has changed and the K3 test above is the one to re-read.
    expect(read.has('commandKey')).toBe(false);
  });

  test('K5: the renderer is a pure function of its argument', () => {
    const a = inputFor(BASE);
    // Structurally equal, distinct object: nothing may be memoised on identity.
    const b: PromptInput = JSON.parse(JSON.stringify(a));
    expect(renderGenerationPrompt(b)).toBe(renderGenerationPrompt(a));
    expect(renderGenerationPrompt(a)).toBe(renderGenerationPrompt(a));
  });

  test('K5: the render section references no source but its argument', () => {
    const section = renderSection();

    // Each of these is a route by which data could reach the prompt without
    // reaching the digest. None appears in the prose either, so a hit is real.
    const forbidden = [
      'process.',
      'globalThis',
      'Math.random',
      'Date.now',
      'new Date',
      'require(',
      'readFileSync',
      'import(',
      'BoundedCapture',
      'StateCapture',
    ];

    // Asserts its own effect: the detector finds a planted hit before any
    // "clean" it reports means anything.
    for (const token of forbidden) {
      expect(`${section}\n${token}`.includes(token), `control for ${token}`).toBe(true);
    }

    expect(forbidden.filter((token) => section.includes(token))).toEqual([]);
  });
});

/**
 * K6 — DOES THE CACHE STILL HIT?
 *
 * `visitOrder` is part of the key, which is right for correctness: two
 * different walks are two different pieces of evidence. But it creates a
 * question in the CACHE-MISS direction, and that direction is silent — if the
 * order were unstable, the key would never repeat, every generation would pay
 * full price, and the only symptom would be a bill. Nothing goes red.
 *
 * So the property the cache's usefulness now rests on gets guarded, because
 * nothing else guards it:
 *
 * > **Given one capture, `visitOrder` is a pure function of that capture.**
 *
 * That is what makes the documented hit scenario — "re-runs during development
 * are free unless the capture changed" — still true: within one capture file
 * the walk is fixed, so the key is fixed.
 *
 * Measured 2026-09-07, since determinism of the tool is the other half:
 * `pnpm inspect` run twice against the same live app with the same scripted
 * walk produced identical visit orders AND identical content digests for all
 * three states. **The honest limit on that measurement:** the page reached was
 * the static marketing landing page, and the deep link to a data-bearing page
 * redirected to `/login`, so it says nothing about whether a page carrying real
 * workspace rows is stable between sessions days apart. The design already
 * expects that it is not — "the workspace list changes between sessions" — and
 * that is the case where content moves the digest regardless of the walk.
 */
test.describe('visit order is a pure function of the capture (K6) @unit', () => {
  const walk = bounded([
    state('third', [node('button', 'C')]),
    state('first', [node('button', 'A')]),
    state('second', [node('button', 'B')]),
  ]);

  test('K6: the same capture yields the same key every time', () => {
    // If this were ever false the cache could not hit at all, and nothing
    // downstream would report it.
    expect(generationCacheKey(inputFor(walk))).toBe(generationCacheKey(inputFor(walk)));
  });

  test('K6: visit order follows the capture, not the sorted output', () => {
    const built = inputFor(walk);
    const order = Object.fromEntries(built.states.map((s) => [s.id, s.visitOrder]));

    // The walk was third -> first -> second; the LIST is sorted by id. If
    // visitOrder were read after the sort it would read 0,1,2 in id order and
    // silently assert a walk that never happened.
    expect(order).toEqual({ third: 0, first: 1, second: 2 });
    expect(built.states.map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });

  test('K6: bounding preserves the session walk, including a pulled-in neighbour', () => {
    // `visitOrder` now depends on bounding keeping the session's order, and
    // bounding builds its kept set through a Set and a score sort — neither of
    // which is the walk. The final `filter` is what preserves it. Nothing
    // tested that before `visitOrder` made the cache depend on it.
    const session: StateCapture = {
      sessionId: 's',
      states: [
        // Scores 0 on the command, so it is only ever kept as a neighbour —
        // and it was visited FIRST.
        { id: 'lobby', label: 'lobby', url: 'u', nodes: [node('button', 'Lobby')], truncated: false },
        {
          id: 'upload',
          label: 'upload',
          url: 'u',
          nodes: [node('button', 'Upload workspace')],
          truncated: false,
        },
      ],
      transitions: [{ from: 'lobby', to: 'upload', action: 'clicked', verdict: 'consistent' }],
    };

    const boundedCapture = boundCaptureForCommand(session, 'upload workspace');
    const built = buildPromptInput({
      capture: boundedCapture,
      command: 'upload workspace',
      existingCaseTitles: [],
    });

    // Discriminating: the neighbour really was pulled in on the transition
    // rather than on its own score, so this is not passing trivially.
    expect(boundedCapture.selection.chosen.find((c) => c.id === 'lobby')?.why).toBe(
      'transition-neighbour',
    );
    // And it keeps its place in the walk despite being chosen last.
    expect(built.states.find((s) => s.id === 'lobby')!.visitOrder).toBe(0);
    expect(built.states.find((s) => s.id === 'upload')!.visitOrder).toBe(1);
  });
});
