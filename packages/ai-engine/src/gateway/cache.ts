import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { LlmCompletion, LlmCompletionRequest } from '@aitp/shared';

export interface CompletionCache {
  get(key: string): LlmCompletion<string> | undefined;
  set(key: string, value: LlmCompletion<string>): void;
}

export function cacheKeyFor(request: LlmCompletionRequest): string {
  if (request.cacheKey) return request.cacheKey;
  const payload = JSON.stringify({
    messages: request.messages,
    model: request.model,
    temperature: request.temperature,
    responseSchema: request.responseSchema,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** In-process cache; enough for a single run. */
export class MemoryCompletionCache implements CompletionCache {
  private readonly store = new Map<string, LlmCompletion<string>>();
  get(key: string) {
    return this.store.get(key);
  }
  set(key: string, value: LlmCompletion<string>) {
    this.store.set(key, value);
  }
}

/**
 * Disk cache — survives across runs, which matters because the same page usually
 * produces the same generation/healing prompts every night in CI.
 */
export class DiskCompletionCache implements CompletionCache {
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Always hashed: a caller-supplied cacheKey could otherwise contain / or .. */
  private file(key: string): string {
    const safe = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return path.join(this.dir, `${safe}.json`);
  }

  get(key: string): LlmCompletion<string> | undefined {
    const file = this.file(key);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as LlmCompletion<string>;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: LlmCompletion<string>): void {
    writeFileSync(this.file(key), JSON.stringify(value, null, 2), 'utf8');
  }
}
