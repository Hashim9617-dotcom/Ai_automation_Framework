import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  PROMPT_VERSION,
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

  test('K2: state ORDER does not change the prompt, because the builder canonicalises it', () => {
    // This is the case that could have pinned a bug. It is only true because
    // `buildPromptInput` SORTS states by id, so the model is shown one order
    // whichever order they were captured in — the flow between them is carried
    // by declared transitions, not by list position. Were the builder to render
    // capture order instead, the model's output could depend on it and these
    // two would have to be different cache entries.
    const a = bounded([state('a', [node('button', 'A')]), state('b', [node('button', 'B')])]);
    const b = bounded([state('b', [node('button', 'B')]), state('a', [node('button', 'A')])]);

    expect(promptFor(a)).toBe(promptFor(b));
    expect(digestFor(a)).toBe(digestFor(b));

    // Discriminating: the states really are distinguishable, so this is not
    // passing because both prompts describe an empty capture.
    expect(promptFor(a)).toContain('button "A"');
    expect(promptFor(a)).toContain('button "B"');
    expect(digestFor(a)).not.toBe(digestFor(BASE));
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

  test('K5: the renderer reads only declared fields of that argument', () => {
    const read = new Set<string>();
    const input = inputFor(BASE);
    const watched = new Proxy(input, {
      get(target, property, receiver) {
        if (typeof property === 'string') read.add(property);
        return Reflect.get(target, property, receiver);
      },
    });

    renderGenerationPrompt(watched);

    // Nothing outside the declared shape was touched.
    const declared = new Set(Object.keys(input));
    expect([...read].filter((key) => !declared.has(key))).toEqual([]);

    // Discriminating: it really did read, so an empty read set would not pass.
    expect(read.has('states')).toBe(true);
    expect(read.has('command')).toBe(true);
    expect(read.has('promptVersion')).toBe(true);

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
