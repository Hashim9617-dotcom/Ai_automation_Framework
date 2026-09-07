import { createHash } from 'node:crypto';
import { tokenize } from '../matching/command-matcher';
import type { AccessibilityNode } from '../types/ai';
import type { BoundedCapture } from './bounding';
import type { AssertStep, CandidateCase, CaseStep } from './grounding';

/**
 * Digests and identities for generation.
 *
 * Two things live here, and both fail silently when wrong — which is why each
 * gets tested in BOTH directions rather than only the obvious one.
 */

const sha = (input: string): string => createHash('sha256').update(input).digest('hex').slice(0, 16);

/** The prompt's contract version. Bumping it invalidates every cache entry. */
export const PROMPT_VERSION = 'gen-1';

/**
 * A digest of exactly what the prompt serialises, in the order it serialises
 * it — and nothing else.
 *
 * Both directions matter, and they fail oppositely:
 *
 * - Include too little, and two captures the prompt would render differently
 *   share a key: a stale proposal is served for an app that changed. That is
 *   the worst failure this cache has, because the answer is confident and
 *   about a page that no longer exists.
 * - Include too much — a capture timestamp, a session id, a directory name —
 *   and the key never repeats: the cache never hits and every run pays full
 *   price, with nothing appearing broken.
 *
 * So: state ids, their nodes' role/name/enabled/selected, collapsed group
 * shapes, truncation flags, and declared transitions. Deliberately NOT
 * `sessionId`, `capturedAt`, `url`, or `label` — none reaches the model.
 */
export function captureDigest(capture: BoundedCapture): string {
  const node = (n: AccessibilityNode): string =>
    [
      n.role,
      n.name,
      n.enabled ? 'e1' : 'e0',
      n.selected === undefined ? '' : `s${n.selected ? 1 : 0}`,
      n.expanded === undefined ? '' : `x${n.expanded ? 1 : 0}`,
      n.checked === undefined ? '' : `c${n.checked ? 1 : 0}`,
    ].join('|');

  const states = capture.states
    .map((state) =>
      [
        state.id,
        state.truncated ? 't1' : 't0',
        state.nodes.map(node).join('~'),
        (state.collapsed ?? [])
          .map((g) => `${g.role}|${g.pattern}|${g.count}`)
          .sort()
          .join('~'),
      ].join('#'),
    )
    // Sorted: two bounded captures holding the same states in a different
    // order render the same prompt content, so they must share a key.
    .sort()
    .join('\n');

  const transitions = capture.transitions
    .map((t) => `${t.from}>${t.to}:${t.action}:${t.verdict}`)
    .sort()
    .join('\n');

  return sha(`${states}\n--\n${transitions}`);
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

/** Adding or renaming a test changes what "we already have this" means. */
export function existingCaseTitlesDigest(titles: string[]): string {
  return sha([...titles].sort().join('\n'));
}

export interface CacheKeyParts {
  promptVersion: string;
  command: string;
  capture: BoundedCapture;
  existingCaseTitles: string[];
}

/**
 * Every component is load-bearing: remove any one and some test must fail, or
 * it is decoration (rule 3 applied to the key itself).
 */
export function generationCacheKey(parts: CacheKeyParts): string {
  return `gen:${sha(
    [
      parts.promptVersion,
      normalizeCommand(parts.command),
      captureDigest(parts.capture),
      existingCaseTitlesDigest(parts.existingCaseTitles),
    ].join('::'),
  )}`;
}

/**
 * Identity of one assertion, for per-assertion approval.
 *
 * Derived from the assertion's CONTENT and its PATH — the entry state, the
 * ordered actions preceding it, and the claim itself. Nothing else: not the
 * index, not the case title, not the generation timestamp.
 *
 * Two consequences, both intended:
 *
 * - Content changes, so the id changes, so an approval LAPSES rather than
 *   carrying over onto text a human never read. An approval that silently
 *   transfers to different content converts an unreviewed claim into a
 *   reviewed one.
 * - The path is part of the identity, because "the Folder tab is selected"
 *   after *clicked WS-ALPHA* is a different claim from the same sentence
 *   after *clicked Next*. Identity from the claim alone would let one approve
 *   the other.
 */
export function assertionId(
  entryState: string,
  precedingActions: string[],
  claim: AssertStep,
): string {
  return sha(
    [
      entryState,
      ...precedingActions,
      '::',
      claim.role,
      claim.name,
      claim.property,
      claim.expected ? '1' : '0',
    ].join('|'),
  );
}

/** Walks a case, giving each assertion its id along with the path that led to it. */
export function assertionIdsFor(
  candidate: CandidateCase,
): Array<{ stepIndex: number; assertionId: string; precedingActions: string[] }> {
  const out: Array<{ stepIndex: number; assertionId: string; precedingActions: string[] }> = [];
  const actions: string[] = [];

  for (const [stepIndex, step] of candidate.steps.entries()) {
    if (step.kind === 'action') {
      actions.push(step.description);
      continue;
    }
    out.push({
      stepIndex,
      assertionId: assertionId(candidate.entryState, [...actions], step),
      precedingActions: [...actions],
    });
  }
  return out;
}

/** Kept for callers that need the step-kind guard without importing the type. */
export const isAssertStep = (step: CaseStep): step is AssertStep => step.kind === 'assert';
