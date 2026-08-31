import path from 'node:path';
import { rootLogger, type LlmGateway } from '@aitp/shared';
import { BudgetGuard } from './budget';
import { DiskCompletionCache, MemoryCompletionCache } from './cache';
import { HttpLlmGateway, type LlmProvider } from './http-gateway';
import { MockLlmGateway } from './mock-gateway';

const log = rootLogger.child('llm-factory');

export interface GatewayFactoryOptions {
  /** Where the disk cache lives; defaults to artifacts/.llm-cache. */
  cacheDir?: string;
  forceMock?: boolean;
}

/**
 * Chooses a gateway from environment configuration. With no API key present the
 * platform still boots and runs — it just falls back to the mock, which keeps
 * Phase 1 fully runnable before any AI credentials exist.
 */
export function createLlmGateway(options: GatewayFactoryOptions = {}): LlmGateway {
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider;
  const apiKey =
    provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;

  if (options.forceMock || !apiKey) {
    log.warn('No LLM API key configured — using the mock gateway.', { provider });
    return new MockLlmGateway();
  }

  const cacheDir = options.cacheDir ?? path.join(process.cwd(), 'artifacts', '.llm-cache');
  const models = {
    reasoning: process.env.LLM_MODEL_REASONING ?? 'claude-sonnet-4-5',
    fast: process.env.LLM_MODEL_FAST ?? 'claude-haiku-4-5',
  };

  // The mock-fallback path above logs a warning; this is the corresponding
  // confirmation for the real path, so "which gateway is actually in use"
  // is never a matter of inferring it from the absence of that warning.
  log.info('Using the real LLM gateway.', { provider, models });

  return new HttpLlmGateway({
    provider,
    apiKey,
    models,
    cache:
      process.env.LLM_CACHE === 'memory'
        ? new MemoryCompletionCache()
        : new DiskCompletionCache(cacheDir),
    budget: new BudgetGuard(),
  });
}
