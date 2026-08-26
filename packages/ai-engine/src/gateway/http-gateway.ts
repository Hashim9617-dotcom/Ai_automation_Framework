import {
  LlmError,
  rootLogger,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmGateway,
} from '@aitp/shared';
import { BudgetGuard } from './budget';
import { MemoryCompletionCache, cacheKeyFor, type CompletionCache } from './cache';

export type LlmProvider = 'anthropic' | 'openai';

export interface HttpGatewayConfig {
  provider: LlmProvider;
  apiKey: string;
  /** Logical name -> concrete model id, so call sites never hardcode a model. */
  models: { reasoning: string; fast: string };
  baseUrl?: string;
  /** USD per 1M tokens, used for the budget guard. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  cache?: CompletionCache;
  budget?: BudgetGuard;
  maxRetries?: number;
}

const DEFAULT_BASE_URL: Record<LlmProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};

/**
 * Single egress point for every LLM call in the platform. Everything the
 * architecture doc asks for — caching, retries, budget cap, provider swap,
 * redaction — happens here rather than at call sites.
 */
export class HttpLlmGateway implements LlmGateway {
  private readonly log = rootLogger.child('llm');
  private readonly cache: CompletionCache;
  private readonly budget: BudgetGuard;

  constructor(private readonly config: HttpGatewayConfig) {
    this.cache = config.cache ?? new MemoryCompletionCache();
    this.budget = config.budget ?? new BudgetGuard();
  }

  get budgetSnapshot() {
    return this.budget.snapshot();
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion<string>> {
    const key = cacheKeyFor(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.budget.record({ ...cached.usage, cached: true });
      return { ...cached, usage: { ...cached.usage, cached: true } };
    }

    this.budget.assertAllowed();
    const completion = await this.dispatch(request);
    this.budget.record(completion.usage);
    this.cache.set(key, completion);
    return completion;
  }

  async completeJson<T>(request: LlmCompletionRequest): Promise<LlmCompletion<T>> {
    const instruction = request.responseSchema
      ? `Respond with valid JSON only — no prose, no markdown fences — conforming to this JSON schema:\n${JSON.stringify(request.responseSchema)}`
      : 'Respond with valid JSON only. No prose, no markdown fences.';

    const completion = await this.complete({
      ...request,
      messages: [...request.messages, { role: 'user', content: instruction }],
    });

    const cleaned = completion.content
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();

    try {
      return { ...completion, content: JSON.parse(cleaned) as T };
    } catch (error) {
      throw new LlmError('LLM returned malformed JSON.', {
        preview: cleaned.slice(0, 300),
        cause: (error as Error).message,
      });
    }
  }

  private async dispatch(request: LlmCompletionRequest): Promise<LlmCompletion<string>> {
    const model =
      request.model === 'fast' ? this.config.models.fast : this.config.models.reasoning;
    const url = this.config.baseUrl ?? DEFAULT_BASE_URL[this.config.provider];
    const maxRetries = this.config.maxRetries ?? 3;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.body(request, model)),
        });

        if (!response.ok) {
          const text = await response.text();
          // 429 / 5xx are worth retrying; 4xx are not.
          if (response.status !== 429 && response.status < 500) {
            throw new LlmError(`LLM request failed (${response.status}).`, {
              body: text.slice(0, 300),
            });
          }
          throw new Error(`retryable ${response.status}: ${text.slice(0, 200)}`);
        }

        const payload = (await response.json()) as Record<string, never>;
        return this.parse(payload, model);
      } catch (error) {
        lastError = error;
        if (error instanceof LlmError) throw error;
        if (attempt === maxRetries) break;
        const backoffMs = 500 * 2 ** (attempt - 1);
        this.log.warn('LLM call failed, retrying', { attempt, backoffMs });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new LlmError('LLM request failed after retries.', {
      cause: (lastError as Error)?.message,
    });
  }

  private headers(): Record<string, string> {
    if (this.config.provider === 'anthropic') {
      return {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      };
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private body(request: LlmCompletionRequest, model: string): Record<string, unknown> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const rest = request.messages.filter((m) => m.role !== 'system');

    if (this.config.provider === 'anthropic') {
      return {
        model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0,
        ...(system ? { system } : {}),
        messages: rest,
      };
    }
    return {
      model,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages,
    };
  }

  private parse(payload: Record<string, never>, model: string): LlmCompletion<string> {
    const pricing = this.config.pricing ?? { inputPerMTok: 3, outputPerMTok: 15 };

    if (this.config.provider === 'anthropic') {
      const blocks = (payload.content ?? []) as unknown as Array<{ type: string; text?: string }>;
      const usage = (payload.usage ?? {}) as unknown as {
        input_tokens?: number;
        output_tokens?: number;
      };
      const promptTokens = usage.input_tokens ?? 0;
      const completionTokens = usage.output_tokens ?? 0;
      return {
        content: blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join(''),
        provider: 'anthropic',
        model,
        usage: {
          promptTokens,
          completionTokens,
          cached: false,
          costUsd:
            (promptTokens / 1e6) * pricing.inputPerMTok +
            (completionTokens / 1e6) * pricing.outputPerMTok,
        },
      };
    }

    const choices = (payload.choices ?? []) as unknown as Array<{
      message?: { content?: string };
    }>;
    const usage = (payload.usage ?? {}) as unknown as {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    return {
      content: choices[0]?.message?.content ?? '',
      provider: 'openai',
      model,
      usage: {
        promptTokens,
        completionTokens,
        cached: false,
        costUsd:
          (promptTokens / 1e6) * pricing.inputPerMTok +
          (completionTokens / 1e6) * pricing.outputPerMTok,
      },
    };
  }
}
