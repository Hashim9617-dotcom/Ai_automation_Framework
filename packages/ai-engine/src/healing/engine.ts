import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  checkHealingEligibility,
  matchAxNodes,
  newId,
  rootLogger,
  type AccessibilityTreeSnapshot,
  type DomSnapshot,
  type HealingEligibility,
  type HealingProposal,
  type LlmGateway,
  type LocatorCandidate,
  type LocatorResolution,
  type LocatorResolutionError,
  type LocatorSpec,
  type SelfHealingEngine,
} from '@aitp/shared';
import { HEALING_RESPONSE_SCHEMA, HEALING_SYSTEM_PROMPT, buildHealingPrompt } from './prompts';

const log = rootLogger.child('healing');

const responseSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false), rationale: z.string().optional() }),
  z.object({
    found: z.literal(true),
    role: z.string().min(1),
    name: z.string().min(1),
    exact: z.boolean().optional(),
    rationale: z.string().min(1),
    confidence: z.number(),
  }),
]);

export interface HealingEngineOptions {
  model?: string;
  temperature?: number;
}

function fingerprint(spec: LocatorSpec, snapshot: AccessibilityTreeSnapshot): string {
  const names = snapshot.nodes.map((n) => `${n.role}:${n.name}`).join('|');
  return createHash('sha256')
    .update(`${spec.key}::${spec.description}::${names}`)
    .digest('hex')
    .slice(0, 32);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Number(value.toFixed(2))));
}

/**
 * v1 self-healing (docs/phase-2-healing.md). Two methods, two very different
 * cost/timing profiles by design:
 *
 * - checkEligibility: pure, synchronous, free — safe to call from live test
 *   teardown (packages/execution-engine/src/fixtures/index.ts already does).
 * - propose: one LLM call plus deterministic verification, always out of
 *   band. Never called while a test is running. Returns a fully-verified
 *   HealingProposal or null — null is the expected common case, not an
 *   error, and this method NEVER returns something for a test to use live.
 */
export class LlmSelfHealingEngine implements SelfHealingEngine {
  private readonly log = log;

  constructor(
    private readonly gateway: LlmGateway,
    private readonly options: HealingEngineOptions = {},
  ) {}

  checkEligibility(input: {
    spec: LocatorSpec;
    error: LocatorResolutionError;
    telemetry: LocatorResolution[];
    snapshot: DomSnapshot;
    pageUrl: string;
  }): HealingEligibility {
    return checkHealingEligibility(input);
  }

  async propose(input: {
    spec: LocatorSpec;
    axSnapshot: AccessibilityTreeSnapshot;
    runId: string;
    testId: string;
  }): Promise<HealingProposal | null> {
    const { spec, axSnapshot, runId, testId } = input;

    // A truncated accessibility tree cannot support the one guarantee this
    // engine makes. Verification is `matchCount === 1` — a claim that no
    // OTHER node matches — and that is an absence claim, which a view cut off
    // at its node cap cannot establish: a second match may sit past the
    // cutoff. `matchCount: 1` computed here would be a false guarantee, and a
    // false guarantee is worse than none, since the whole point of the
    // verification step is that a human can trust it without re-checking.
    //
    // This is the same reasoning as the gate's rule 4 ("absence proves
    // nothing in a truncated view"), which applies it to the DOM snapshot;
    // nothing applied it to the AX snapshot until now, even though the AX
    // snapshot is what verification actually reads. The prompt already
    // mentioned truncation to the model, which is not the same as refusing
    // to act on it.
    if (axSnapshot.truncated) {
      this.log.warn('Not proposing — the accessibility snapshot was truncated', {
        key: spec.key,
        nodes: axSnapshot.nodes.length,
      });
      return null;
    }

    // Pre-check, before spending an LLM call: if any EXISTING role-strategy
    // candidate now matches exactly one node, the chain would resolve fine
    // today — this was a timing problem (the element was merely slow to
    // render), not a naming one, and proposing a replacement for a locator
    // that was never actually wrong is exactly the false-positive this
    // design exists to prevent. See docs/phase-2-healing.md's eval case (f).
    for (const candidate of spec.candidates) {
      if (candidate.strategy !== 'role') continue;
      const matches = matchAxNodes(axSnapshot.nodes, candidate);
      if (matches.length === 1) {
        this.log.info('Not proposing — an existing candidate already resolves uniquely', {
          key: spec.key,
          strategy: candidate.strategy,
        });
        return null;
      }
    }

    let completion;
    try {
      completion = await this.gateway.completeJson<unknown>({
        model: this.options.model ?? 'reasoning',
        temperature: this.options.temperature ?? 0,
        maxTokens: 512,
        responseSchema: HEALING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        cacheKey: `heal:${fingerprint(spec, axSnapshot)}`,
        messages: [
          { role: 'system', content: HEALING_SYSTEM_PROMPT },
          { role: 'user', content: buildHealingPrompt(spec, axSnapshot) },
        ],
      });
    } catch (error) {
      this.log.warn('Healing proposal call failed', { key: spec.key, error: (error as Error).message });
      return null;
    }

    const parsed = responseSchema.safeParse(completion.content);
    if (!parsed.success) {
      this.log.warn('Healer returned an unusable shape', { key: spec.key });
      return null;
    }
    if (!parsed.data.found) {
      this.log.info('Healer found nothing safe to propose', { key: spec.key });
      return null;
    }

    const candidate: LocatorCandidate = {
      strategy: 'role',
      // Deliberately not carried through from spec.candidates — the healer
      // only ever proposes what it can verify against the accessibility
      // tree, and role is the only strategy that tree can confirm. See
      // packages/shared/src/healing/match.ts.
      value: parsed.data.role,
      options: { name: parsed.data.name, ...(parsed.data.exact ? { exact: true } : {}) },
      confidence: clamp(parsed.data.confidence),
    };

    // Verification — non-negotiable, and happens whether or not the human
    // ever reviews this. A candidate that doesn't resolve to exactly one
    // node is discarded here, not written with a caveat.
    const matches = matchAxNodes(axSnapshot.nodes, candidate);
    if (matches.length !== 1) {
      this.log.info('Discarding proposal — failed verification', {
        key: spec.key,
        matchCount: matches.length,
      });
      return null;
    }
    const matched = matches[0]!;

    return {
      id: newId('heal'),
      runId,
      testId,
      key: spec.key,
      description: spec.description,
      existingCandidates: spec.candidates,
      candidate,
      verification: {
        matchCount: matches.length,
        role: matched.role,
        accessibleName: matched.name,
        // Presence in this snapshot already implies visible-to-AT: capture
        // (packages/execution-engine/src/dom/accessibility-snapshot.ts)
        // drops ignored/hidden nodes before this ever sees them.
        visible: true,
        enabled: matched.enabled,
        verifiedAgainst: 'ax-tree-snapshot',
        verifiedAt: new Date().toISOString(),
      },
      rationale: parsed.data.rationale,
      confidence: clamp(parsed.data.confidence),
      provenance: {
        source: 'healed',
        runId,
        generatedAt: new Date().toISOString(),
        model: `${completion.provider}/${completion.model}`,
      },
      status: 'pending',
    };
  }
}
