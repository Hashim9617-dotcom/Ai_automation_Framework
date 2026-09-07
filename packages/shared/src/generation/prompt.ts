import { createHash } from 'node:crypto';
import { tokenize } from '../matching/command-matcher';
import type { AccessibilityNode } from '../types/ai';
import type { BoundedCapture } from './bounding';
import type { CollapsedGroup } from './grounding';

/**
 * The prompt, and the digest of the prompt.
 *
 * These live in one file because they must not be able to disagree, and the
 * previous arrangement made disagreement a matter of vigilance: the digest was
 * assembled ALONGSIDE the prompt from the same capture, so adding a field to
 * the prompt and forgetting the digest served a stale answer for a changed
 * question — silently, with every existing test green. Tests could only pin
 * what the digest did that day; none of them could notice the field that was
 * never added.
 *
 * So the shape is structural rather than careful:
 *
 * 1. `buildPromptInput()` produces ONE canonical `PromptInput`.
 * 2. `renderGenerationPrompt()` takes that object and NOTHING else, so the
 *    model cannot be shown anything the digest has not seen.
 * 3. `promptInputDigest()` hashes that same object through an EXHAUSTIVE,
 *    compile-time-checked field map, so a new field on `PromptInput` fails to
 *    compile until its contribution to the digest is declared.
 *
 * Divergence is then impossible by construction. The remaining judgement — is
 * a field's digest form right? — is a visible line in `PROMPT_INPUT_DIGEST`,
 * not an omission nobody can see.
 */

const sha = (input: string): string => createHash('sha256').update(input).digest('hex').slice(0, 16);

/** The prompt's contract version. Bumping it invalidates every cache entry. */
export const PROMPT_VERSION = 'gen-1';

/** A node as the prompt renders it. Exactly the fields the model is shown. */
export interface PromptNode {
  role: string;
  name: string;
  enabled: boolean;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean;
  level?: number;
}

export interface PromptState {
  id: string;
  truncated: boolean;
  /**
   * In capture order, deliberately NOT sorted. AX order is document order, so
   * it is page structure the model reads — two orderings are two different
   * prompts and must not share a cache entry.
   */
  nodes: PromptNode[];
  collapsed: CollapsedGroup[];
}

export interface PromptTransition {
  from: string;
  to: string;
  action: string;
  verdict: 'consistent' | 'suspect';
}

/**
 * Everything the model is shown, canonicalised.
 *
 * What is ABSENT is as load-bearing as what is present. `sessionId`,
 * `capturedAt`, a state's `label` and `url`, and bounding's `selection` record
 * are all missing on purpose: none of them reaches the model, so none of them
 * may change a cache key. Before this type existed that was a claim about the
 * digest's contents; now it is a claim about what a renderer can physically
 * reach, which is checkable by reading one interface.
 */
export interface PromptInput {
  promptVersion: string;
  /** The operator's own words, rendered verbatim — the model needs the phrasing. */
  command: string;
  /** The command's cache identity: stop-worded, sorted. See `PROMPT_INPUT_DIGEST`. */
  commandKey: string;
  /** Sorted by id. See `buildPromptInput` on why order is canonicalised here. */
  states: PromptState[];
  transitions: PromptTransition[];
  existingCaseTitles: string[];
}

const promptNode = (node: AccessibilityNode): PromptNode => ({
  role: node.role,
  name: node.name,
  enabled: node.enabled,
  ...(node.selected === undefined ? {} : { selected: node.selected }),
  ...(node.expanded === undefined ? {} : { expanded: node.expanded }),
  ...(node.checked === undefined ? {} : { checked: node.checked }),
  ...(node.level === undefined ? {} : { level: node.level }),
});

/**
 * Builds the canonical prompt input for one command against one bounded capture.
 *
 * **State order is canonicalised, and that is a design decision rather than a
 * convenience.** A bounded capture's state order is inherited from the order a
 * human happened to capture them in; the flow between states is carried
 * explicitly by `transitions`, not by list position. So two captures holding
 * the same states in a different order describe the same application and must
 * render the same prompt — otherwise re-capturing a flow in a different order
 * would pay for a fresh generation of an identical question.
 *
 * Sorting here rather than in the digest is what makes that true of the
 * PROMPT and not merely of the key. A digest that sorted while the renderer
 * did not would be claiming an equivalence the model does not see.
 *
 * Node order inside a state is left alone for the opposite reason: it is
 * document order, so it is page structure.
 */
export function buildPromptInput(input: {
  capture: BoundedCapture;
  command: string;
  existingCaseTitles: string[];
  promptVersion?: string;
}): PromptInput {
  const states: PromptState[] = input.capture.states
    .map((state) => ({
      id: state.id,
      truncated: state.truncated,
      nodes: state.nodes.map(promptNode),
      collapsed: [...(state.collapsed ?? [])].sort((a, b) =>
        `${a.role}|${a.pattern}`.localeCompare(`${b.role}|${b.pattern}`),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const transitions: PromptTransition[] = input.capture.transitions
    .map((t) => ({ from: t.from, to: t.to, action: t.action, verdict: t.verdict }))
    .sort((a, b) =>
      `${a.from}>${a.to}:${a.action}`.localeCompare(`${b.from}>${b.to}:${b.action}`),
    );

  return {
    promptVersion: input.promptVersion ?? PROMPT_VERSION,
    command: input.command,
    commandKey: normalizeCommand(input.command),
    states,
    transitions,
    existingCaseTitles: [...input.existingCaseTitles].sort(),
  };
}

/**
 * Normalises a command so equivalent phrasings share a cache entry.
 *
 * Reuses the matcher's `tokenize` (lowercase, stop words removed) and sorts,
 * so "test the upload flow" and "Upload flow test" are one entry rather than
 * two — the model would be asked the same question either way.
 */
export function normalizeCommand(command: string): string {
  return tokenize(command).sort().join(' ');
}

const serialiseNode = (node: PromptNode): string =>
  [
    node.role,
    node.name,
    node.enabled ? 'e1' : 'e0',
    node.selected === undefined ? '' : `s${node.selected ? 1 : 0}`,
    node.expanded === undefined ? '' : `x${node.expanded ? 1 : 0}`,
    node.checked === undefined ? '' : `c${node.checked ? 1 : 0}`,
    node.level === undefined ? '' : `l${node.level}`,
  ].join('|');

const serialiseState = (state: PromptState): string =>
  [
    state.id,
    state.truncated ? 't1' : 't0',
    state.nodes.map(serialiseNode).join('~'),
    state.collapsed
      .map((g) => `${g.role}|${g.pattern}|${g.count}|${g.examples.join(',')}`)
      .join('~'),
  ].join('#');

const serialiseTransition = (t: PromptTransition): string =>
  `${t.from}>${t.to}:${t.action}:${t.verdict}`;

/**
 * How each field of `PromptInput` enters the digest — exhaustively.
 *
 * `Required<PromptInput>` is the point: add a field to `PromptInput` and this
 * object stops compiling until you say what it contributes. That is the
 * structural half of the guarantee, and it is why the digest can no longer
 * fall behind the prompt by omission.
 */
type PromptInputDigestFields = {
  [K in keyof Required<PromptInput>]: (value: Required<PromptInput>[K]) => string;
};

const PROMPT_INPUT_DIGEST: PromptInputDigestFields = {
  promptVersion: (v) => v,

  /**
   * The ONE field whose digest form is deliberately coarser than its rendered
   * form: `commandKey` carries the command's identity, so "test the upload
   * flow" and "Upload flow test" share an entry rather than paying twice for
   * the same question (design: "The cache key").
   *
   * Written out as an explicit empty contribution rather than omitted, so the
   * exhaustiveness check still covers it and the decision stays visible.
   */
  command: () => '',
  commandKey: (v) => v,

  states: (v) => v.map(serialiseState).join('\n'),
  transitions: (v) => v.map(serialiseTransition).join('\n'),
  existingCaseTitles: (v) => v.join('\n'),
};

const DIGEST_FIELD_NAMES = Object.keys(PROMPT_INPUT_DIGEST).sort();

/**
 * The digest of exactly what the prompt renders.
 *
 * The compile-time map above catches a field added to the TYPE. This runtime
 * check catches a field added to the OBJECT — by a JavaScript caller, or by a
 * cast — and it follows the repo convention that a thing which scans must
 * assert its own effect rather than report a comfortable answer. A digest that
 * quietly skipped an unknown field would be the exact failure this file exists
 * to make impossible.
 */
export function promptInputDigest(input: PromptInput): string {
  const uncovered = Object.keys(input).filter((key) => !DIGEST_FIELD_NAMES.includes(key));
  if (uncovered.length > 0) {
    throw new Error(
      `promptInputDigest: [${uncovered.join(', ')}] can reach the prompt but not the digest. ` +
        'Add each to PROMPT_INPUT_DIGEST — a field the model sees and the cache key does not ' +
        'serves a stale answer for a changed prompt.',
    );
  }

  const parts = DIGEST_FIELD_NAMES.map((key) => {
    const field = key as keyof PromptInput;
    const serialise = PROMPT_INPUT_DIGEST[field] as (value: unknown) => string;
    return `${key}=${serialise(input[field])}`;
  });

  return sha(parts.join('\n'));
}

/**
 * The digest of the CAPTURE portion of a prompt, for the proposal's
 * provenance record ("approved when the app looked like this").
 *
 * Derived from the same `PromptInput` and serialised by the same functions as
 * the cache key, so it cannot describe a different capture than the one the
 * model was shown.
 */
export function captureDigest(capture: BoundedCapture): string {
  const input = buildPromptInput({ capture, command: '', existingCaseTitles: [] });
  return sha(
    [
      `states=${PROMPT_INPUT_DIGEST.states(input.states)}`,
      `transitions=${PROMPT_INPUT_DIGEST.transitions(input.transitions)}`,
    ].join('\n'),
  );
}

/**
 * The cache key IS the prompt digest.
 *
 * Not "the digest plus some components": every component of the old key
 * (`promptVersion`, the normalised command, the capture, the existing titles)
 * is a field of `PromptInput` and enters through the one map above. Rule 3
 * still applies — remove any one and a test must fail — but it is now checked
 * against the thing the model is actually sent.
 */
export function generationCacheKey(input: PromptInput): string {
  return `gen:${promptInputDigest(input)}`;
}

const renderNode = (node: PromptNode): string => {
  const flags = [
    node.enabled ? undefined : 'disabled',
    node.selected === undefined ? undefined : `selected=${node.selected}`,
    node.expanded === undefined ? undefined : `expanded=${node.expanded}`,
    node.checked === undefined ? undefined : `checked=${node.checked}`,
    node.level === undefined ? undefined : `level=${node.level}`,
  ].filter((flag): flag is string => flag !== undefined);

  return `- ${node.role} "${node.name}"${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`;
};

const renderState = (state: PromptState): string => {
  const lines = [`### state: ${state.id}`];

  if (state.truncated) {
    lines.push(
      '_This capture was TRUNCATED. Elements you cannot see here may exist, so nothing may be',
      'asserted absent from this state._',
    );
  }

  lines.push(...state.nodes.map(renderNode));

  if (state.collapsed.length > 0) {
    lines.push(
      '',
      'Repeated shapes, listed once instead of individually (every member was seen; only the',
      'listing was summarised):',
      ...state.collapsed.map(
        (group) =>
          `- ${group.count} x ${group.role} matching "${group.pattern}" (e.g. ${group.examples
            .map((example) => `"${example}"`)
            .join(', ')})`,
      ),
    );
  }

  return lines.join('\n');
};

/**
 * Renders the generation prompt.
 *
 * Its only parameter is the `PromptInput`, and that is the enforcement: there
 * is no capture, no session and no options object in scope, so nothing can be
 * rendered that the digest did not hash.
 */
export function renderGenerationPrompt(input: PromptInput): string {
  const sections: string[] = [];

  sections.push(
    `# Draft test cases from a captured application (prompt ${input.promptVersion})`,
    '',
    'You are shown real accessibility-tree captures of an application, taken by a human who',
    'drove the browser. Propose draft test cases for the command at the end.',
    '',
    'You are NOT the judge of whether your output is grounded. Every assertion you return is',
    're-graded against these captures by deterministic code, and that grade overrides your',
    'label. Labelling an invented assertion "observed" gains you nothing and is recorded.',
  );

  sections.push(
    '',
    '## Rules',
    '',
    '1. Reference an element ONLY by a `role` and `name` written exactly as they appear below.',
    '   These are computed accessible names, which routinely differ from the visible text — do',
    '   not shorten, tidy or guess one.',
    '2. An action step must quote a declared transition\'s action verbatim. There is no other',
    '   way to move between states: an action that matches no declared transition leaves the',
    '   test standing somewhere unknown, and everything after it becomes a question.',
    '3. Do not assert what an action CAUSES unless a transition below declares it. If you',
    '   believe a flow works a certain way and no transition says so, that belongs in',
    '   `openQuestions`, phrased as a question.',
    '4. Label each assertion `observed` (this capture shows it) or `assumed` (this capture is',
    '   silent about it). Prefer `assumed` when unsure; a question costs a reader a minute, a',
    '   wrong `observed` costs them a green test that asserts something untrue.',
    '5. A transition marked `suspect` failed its cross-check. It cannot ground anything.',
  );

  sections.push(
    '',
    '## Captured states',
    '',
    input.states.length > 0
      ? input.states.map(renderState).join('\n\n')
      : '_No states were captured. Nothing here can be grounded._',
  );

  sections.push(
    '',
    '## Declared transitions',
    '',
    input.transitions.length > 0
      ? input.transitions
          .map((t) => `- ${t.from} -> ${t.to}: "${t.action}" (cross-check: ${t.verdict})`)
          .join('\n')
      : '_None declared. No action can be shown to lead anywhere, so any multi-step flow is a question._',
  );

  sections.push(
    '',
    '## Tests that already exist',
    '',
    input.existingCaseTitles.length > 0
      ? input.existingCaseTitles.map((title) => `- ${title}`).join('\n')
      : '_None._',
  );

  sections.push('', '## Command', '', input.command);

  sections.push(
    '',
    '## Output',
    '',
    'Return JSON only:',
    '',
    '```json',
    '{',
    '  "cases": [{',
    '    "title": "string",',
    '    "entryState": "one of the state ids above",',
    '    "steps": [',
    '      { "kind": "action", "description": "a declared transition\'s action, verbatim" },',
    '      { "kind": "assert", "role": "string", "name": "string",',
    '        "property": "present" | "enabled" | "selected", "expected": true,',
    '        "modelSaid": "observed" | "assumed" }',
    '    ]',
    '  }],',
    '  "openQuestions": [{ "question": "string", "wouldAssert": "string" }]',
    '}',
    '```',
  );

  return sections.join('\n');
}
