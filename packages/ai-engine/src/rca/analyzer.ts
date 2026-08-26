import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FailureCategory,
  rootLogger,
  type LlmGateway,
  type RootCauseAnalysis,
  type RootCauseAnalysisInput,
  type RootCauseAnalyzer,
} from '@aitp/shared';
import { RCA_RESPONSE_SCHEMA, RCA_SYSTEM_PROMPT, buildRcaPrompt } from './prompts';

const responseSchema = z.object({
  rootCause: z.string().min(1),
  category: z.string(),
  confidence: z.number(),
  suggestedFix: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});

const CATEGORIES = new Set<string>(Object.values(FailureCategory));

export interface RcaOptions {
  /** Logical model tier. Triage is cheap enough that "reasoning" is worth it. */
  model?: string;
  temperature?: number;
}

/**
 * Turns "expected X, received Y" into "the save button stayed disabled because
 * /departments returned 500".
 *
 * It never throws into a run: if the model is unavailable or answers badly, the
 * result is an `unknown` verdict with zero confidence. A failing test must fail
 * on its own merits, not because triage broke.
 */
export class LlmRootCauseAnalyzer implements RootCauseAnalyzer {
  private readonly log = rootLogger.child('rca');

  constructor(
    private readonly gateway: LlmGateway,
    private readonly options: RcaOptions = {},
  ) {}

  async analyze(input: RootCauseAnalysisInput): Promise<RootCauseAnalysis> {
    const prompt = buildRcaPrompt(input);

    try {
      const completion = await this.gateway.completeJson<unknown>({
        model: this.options.model ?? 'reasoning',
        temperature: this.options.temperature ?? 0,
        maxTokens: 1_024,
        responseSchema: RCA_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        // The key covers the fingerprint AND the actual payload. Fingerprint alone
        // would serve a stale verdict when the error text stays the same but the
        // cause changes (a 500 yesterday, a renamed selector today), and editing
        // the system prompt or schema would never invalidate anything.
        cacheKey: `${fingerprint(input)}:${payloadHash(prompt)}`,
        messages: [
          { role: 'system', content: RCA_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      });

      const parsed = responseSchema.safeParse(completion.content);
      if (!parsed.success) {
        this.log.warn('Analyzer returned an unusable shape', { test: input.testTitle });
        return unknownAnalysis(
          `${completion.provider}/${completion.model}`,
          'the model response did not match the expected schema',
        );
      }

      const category = CATEGORIES.has(parsed.data.category)
        ? (parsed.data.category as FailureCategory)
        : FailureCategory.Unknown;

      return {
        rootCause: parsed.data.rootCause.trim(),
        category,
        confidence: clamp(parsed.data.confidence),
        suggestedFix: parsed.data.suggestedFix?.trim() || undefined,
        evidence: parsed.data.evidence.slice(0, 6),
        analyzedBy: `${completion.provider}/${completion.model}`,
        analyzedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.log.warn('Root cause analysis failed', {
        test: input.testTitle,
        error: (error as Error).message,
      });
      return unknownAnalysis('unavailable', (error as Error).message);
    }
  }
}

/** Same test + same error = same analysis, regardless of browser or run. */
export function fingerprint(input: RootCauseAnalysisInput): string {
  const normalized = input.error
    // Strip generated values so a fresh EMP48213 each run does not defeat the cache.
    // The digit rule deliberately has no word boundary — generated ids are usually
    // glued to a prefix ("EMP48213") — but needs 4+ digits so status codes like
    // 500 and 404 stay intact and keep genuinely different failures apart.
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d{4,}/g, '<num>')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  return createHash('sha256')
    .update(`${input.testFile}::${input.testTitle}::${normalized}`)
    .digest('hex')
    .slice(0, 32);
}

function payloadHash(prompt: string): string {
  return createHash('sha256')
    .update(`${RCA_SYSTEM_PROMPT}\u0000${prompt}\u0000${JSON.stringify(RCA_RESPONSE_SCHEMA)}`)
    .digest('hex')
    .slice(0, 16);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Number(value.toFixed(2))));
}

function unknownAnalysis(model: string, reason: string): RootCauseAnalysis {
  return {
    rootCause: `Automated analysis was not available: ${reason}`,
    category: FailureCategory.Unknown,
    confidence: 0,
    evidence: [],
    analyzedBy: model,
    analyzedAt: new Date().toISOString(),
  };
}
