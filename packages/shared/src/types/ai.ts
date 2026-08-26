import type { LocatorSpec } from './locator';
import type { FailureContext, RootCauseAnalysis } from './run';
import type { TestCase } from './test-case';

/**
 * Phase 2 sockets. These interfaces are intentionally defined in Phase 1 so the
 * execution engine, API and reporting layers can be written against them now and
 * the AI implementations can be dropped in without touching call sites.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  messages: LlmMessage[];
  /** Logical model name resolved by the gateway, e.g. "reasoning" or "fast". */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * JSON schema the response should satisfy. The gateway inlines it into the
   * prompt so the model conforms; it is part of the cache key, so changing the
   * schema invalidates cached completions.
   */
  responseSchema?: Record<string, unknown>;
  /** Cache key — identical keys reuse a cached completion (cost control). */
  cacheKey?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cached: boolean;
}

export interface LlmCompletion<T = string> {
  content: T;
  usage: LlmUsage;
  provider: string;
  model: string;
}

export interface LlmGateway {
  complete(request: LlmCompletionRequest): Promise<LlmCompletion<string>>;
  completeJson<T>(request: LlmCompletionRequest): Promise<LlmCompletion<T>>;
}

/** Compacted representation of a page handed to the LLM instead of raw HTML. */
export interface DomSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  elements: Array<{
    ref: string;
    role: string;
    name?: string;
    tag: string;
    testId?: string;
    placeholder?: string;
    value?: string;
    visible: boolean;
    enabled: boolean;
  }>;
}

export interface TestCaseGenerator {
  /** "test complete employee registration flow" -> structured cases. */
  generate(input: {
    command: string;
    snapshot?: DomSnapshot;
    existingCases?: TestCase[];
  }): Promise<TestCase[]>;
}

export interface ScriptGenerator {
  /** Compile a structured case into an executable Playwright spec file. */
  compile(testCase: TestCase, snapshot?: DomSnapshot): Promise<{ filePath: string; source: string }>;
}

export interface SelfHealingEngine {
  /** Called when every pre-generated candidate for a locator has failed. */
  heal(input: {
    spec: LocatorSpec;
    snapshot: DomSnapshot;
  }): Promise<{ candidate: LocatorSpec['candidates'][number]; rationale: string } | null>;
}

export interface RootCauseAnalysisInput {
  testTitle: string;
  testFile: string;
  error: string;
  stack?: string;
  /** Step titles leading up to the failure — often the clearest signal of intent. */
  steps?: string[];
  context?: FailureContext;
}

export interface RootCauseAnalyzer {
  analyze(input: RootCauseAnalysisInput): Promise<RootCauseAnalysis>;
}

export interface AiEngine {
  gateway: LlmGateway;
  testCases: TestCaseGenerator;
  scripts: ScriptGenerator;
  healing: SelfHealingEngine;
  rca: RootCauseAnalyzer;
}
