import {
  PROMPT_VERSION,
  buildPromptInput,
  buildProposal,
  checkGenerationGate,
  generationCacheKey,
  renderGenerationPrompt,
  rootLogger,
  type BoundedCapture,
  type GenerationGateVerdict,
  type InventoryEntry,
  type ModelCase,
  type ModelQuestion,
  type PromptInput,
  type TestCaseProposal,
} from '@aitp/shared';
import type { LlmGateway } from '@aitp/shared';

/**
 * The generation LLM call.
 *
 * Everything here is specified in `docs/phase-2-generation.md`, "The LLM call".
 * The four properties this file exists to hold:
 *
 * 1. a cache hit avoids the MODEL, not merely returns the same answer;
 * 2. an invented `entryState` is REFUSED, never repaired;
 * 3. temperature is pinned at 0, so a proposal is stable at a fixed key;
 * 4. the budget cap applies, and exceeding it stops the run.
 *
 * And the fifth, which is a property of the shape rather than of this file:
 * the capture carries untrusted content from the application under test, and
 * `checkGrounding()` re-deriving every grade is what stops an injected
 * instruction promoting an assertion to `observed`.
 */

/** Pinned. See the design: the cache freezes the first roll, deliberately. */
export const GENERATION_TEMPERATURE = 0;

/**
 * A case the model returned that names a state the capture does not contain.
 *
 * Kept as a RESULT rather than thrown, for the same reason contradictions are:
 * a rising invention rate is a signal about the prompt, and one that vanishes
 * into an exception teaches nobody anything.
 */
export interface RefusedCase {
  title: string;
  /** The id the model invented, verbatim — never repaired, never normalised. */
  claimedEntryState: string;
  /** What it could have said. A reviewer should not have to go and look. */
  availableStateIds: string[];
  reason: string;
}

export interface GenerationResult {
  proposals: TestCaseProposal[];
  refusals: RefusedCase[];
  modelQuestions: ModelQuestion[];
  gate: GenerationGateVerdict;
  /** The key this generation used — logged so a cache miss is explainable. */
  cacheKey: string;
  /** False when the gate suppressed generation, so no model call was made. */
  called: boolean;
}

export interface GenerationEngineOptions {
  model?: string;
  /** Overridable only so a test can prove temperature reaches the gateway. */
  temperature?: number;
  maxTokens?: number;
}

interface ModelResponse {
  cases?: ModelCase[];
  /**
   * The model's own questions. **Read since 2026-09-10; discarded before that.**
   *
   * The prompt asks for these and the model supplies them on every call, but
   * this interface listed only `cases`, so they were dropped silently. One real
   * command returned 0 cases and 5 questions and the run reported
   * "proposals 0, refusals 0" — reporting the model's careful account of what it
   * could not determine as though the model had said nothing.
   *
   * No test caught it because the mock never produced the field: a mock encodes
   * what you believe the system returns.
   */
  openQuestions?: ModelQuestion[];
}

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['cases'],
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'entryState', 'steps'],
        properties: {
          title: { type: 'string' },
          entryState: { type: 'string' },
          steps: { type: 'array' },
        },
      },
    },
  },
} as const;

export class GenerationEngine {
  private readonly log = rootLogger.child('generate');

  constructor(
    private readonly gateway: LlmGateway,
    private readonly options: GenerationEngineOptions = {},
  ) {}

  /**
   * Generates proposals for one command against one bounded capture.
   *
   * The gate runs first and short-circuits: the most expensive generation is
   * the one that recreates a test we already have.
   */
  async generate(input: {
    command: string;
    capture: BoundedCapture;
    inventory: InventoryEntry[];
    existingCaseTitles: string[];
    runId?: string;
  }): Promise<GenerationResult> {
    const gate = checkGenerationGate(input.command, input.inventory);

    const promptInput = buildPromptInput({
      capture: input.capture,
      command: input.command,
      existingCaseTitles: input.existingCaseTitles,
    });
    const cacheKey = generationCacheKey(promptInput);

    if (!gate.generate) {
      this.log.info(gate.reason, { command: input.command });
      return { proposals: [], refusals: [], modelQuestions: [], gate, cacheKey, called: false };
    }

    const completion = await this.gateway.completeJson<ModelResponse>({
      model: this.options.model ?? 'reasoning',
      // Pinned at 0. Not a knob to be tuned for "more creative cases" — the
      // stability property that makes per-assertion approval meaningful
      // depends on a fixed key producing a fixed proposal.
      temperature: this.options.temperature ?? GENERATION_TEMPERATURE,
      maxTokens: this.options.maxTokens ?? 4096,
      messages: [{ role: 'user', content: renderGenerationPrompt(promptInput) }],
      responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      // The gateway keys on this verbatim, so the cache hit is OUR key rather
      // than a hash of the messages — which is what makes the digest work the
      // design gave it actually govern the cache.
      cacheKey,
    });

    const modelQuestions = completion.content?.openQuestions ?? [];

    const { proposals, refusals } = this.review({
      cases: completion.content?.cases ?? [],
      modelQuestions,
      capture: input.capture,
      command: input.command,
      model: `${completion.provider}/${completion.model}`,
      gate,
      runId: input.runId,
    });

    this.log.info('Generated', {
      command: input.command,
      proposals: proposals.length,
      refusals: refusals.length,
      // Logged so "0 proposals" can never again be read as the model having
      // said nothing. A run with no cases and five questions is a RESULT.
      modelQuestions: modelQuestions.length,
      cached: completion.usage.cached,
      costUsd: completion.usage.costUsd,
    });

    return { proposals, refusals, modelQuestions, gate, cacheKey, called: true };
  }

  /**
   * Turns model cases into proposals, refusing the ones that name a state the
   * capture does not hold.
   *
   * The refusal is deliberately NOT a repair. Coercing to the nearest real id
   * rewrites the model's claim into one nobody made; falling back to the first
   * state does the same with less information; grading everything `assumed`
   * converts a hallucination into a record that looks reasoned, which a
   * reviewer cannot tell from a genuine open question.
   */
  private review(input: {
    cases: ModelCase[];
    modelQuestions: ModelQuestion[];
    capture: BoundedCapture;
    command: string;
    model: string;
    gate: GenerationGateVerdict;
    runId?: string;
  }): { proposals: TestCaseProposal[]; refusals: RefusedCase[] } {
    const availableStateIds = input.capture.states.map((state) => state.id);
    const known = new Set(availableStateIds);

    const proposals: TestCaseProposal[] = [];
    const refusals: RefusedCase[] = [];

    for (const [index, modelCase] of input.cases.entries()) {
      if (!known.has(modelCase.entryState)) {
        const refusal: RefusedCase = {
          title: modelCase.title,
          claimedEntryState: modelCase.entryState,
          availableStateIds,
          reason:
            `the model's entry state "${modelCase.entryState}" is not in this capture; ` +
            `available: ${availableStateIds.map((id) => `"${id}"`).join(', ') || '(none)'}`,
        };
        refusals.push(refusal);
        // Loudly: a refusal that only appears in a returned array is a refusal
        // nobody sees when the caller forgets to print it.
        this.log.warn('Refused a generated case: invented entry state', {
          command: input.command,
          claimedEntryState: modelCase.entryState,
          availableStateIds,
        });
        continue;
      }

      proposals.push(
        buildProposal({
          id: `${input.runId ?? 'gen'}-${index}`,
          sourceCommand: input.command,
          model: input.model,
          promptVersion: PROMPT_VERSION,
          capture: input.capture,
          modelCase,
          modelQuestions: input.modelQuestions,
          gate: input.gate,
        }),
      );
    }

    return { proposals, refusals };
  }
}

/** Re-exported so callers do not need to reach into `@aitp/shared` for the type. */
export type { PromptInput };
