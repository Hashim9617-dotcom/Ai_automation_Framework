import type { LlmCompletion, LlmCompletionRequest, LlmGateway } from '@aitp/shared';

/**
 * Deterministic gateway used by unit tests, CI without an API key, and local
 * development. Register canned responses by substring so a test can assert on
 * prompt content without ever hitting a provider.
 */
export class MockLlmGateway implements LlmGateway {
  private readonly canned: Array<{ match: string; response: string }> = [];
  readonly calls: LlmCompletionRequest[] = [];

  when(match: string, response: string): this {
    this.canned.push({ match, response });
    return this;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion<string>> {
    this.calls.push(request);
    const prompt = request.messages.map((m) => m.content).join('\n');
    const hit = this.canned.find((entry) => prompt.includes(entry.match));
    return {
      content: hit?.response ?? '{}',
      provider: 'mock',
      model: request.model ?? 'mock-model',
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, cached: false },
    };
  }

  async completeJson<T>(request: LlmCompletionRequest): Promise<LlmCompletion<T>> {
    const completion = await this.complete(request);
    return { ...completion, content: JSON.parse(completion.content) as T };
  }
}
