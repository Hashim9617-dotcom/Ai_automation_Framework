import type { LocatorResolutionError } from '../errors';
import type { LocatorCandidate, LocatorResolution, LocatorSpec } from './locator';
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
  /**
   * True when `elements` hit `maxElements` and was cut off mid-page. An
   * element's *absence* from a truncated snapshot proves nothing — it may
   * simply be past the cutoff. The self-healing gate (docs/phase-2-healing.md,
   * rule 4) refuses to act on a truncated snapshot for exactly this reason.
   */
  truncated: boolean;
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

/**
 * One accessibility-tree node, captured via CDP (`Accessibility.getFullAXTree`)
 * rather than the DOM-heuristic `DomSnapshot.elements[].name` — this is the
 * *real* computed accessible name Playwright's own `getByRole` matches
 * against, which is the whole reason it exists: Findings 5, 6, 10 and 11
 * (docs/dms-findings.md) were all cases where the visible label and the real
 * computed name diverged, and a heuristic snapshot can't see that divergence
 * because it's built from the same heuristics that got fooled the first time.
 */
export interface AccessibilityNode {
  role: string;
  name: string;
  /** From the AX node's `disabled` property when present; `true` otherwise. */
  enabled: boolean;
}

/**
 * Captured once per eligible failure, while the page is still alive (test
 * teardown) — not reconstructable later, since most of what this targets
 * (an open dialog, an open menu, a specific wizard step) can't be
 * reproduced by re-navigating a fresh page to the same URL.
 */
export interface AccessibilityTreeSnapshot {
  url: string;
  capturedAt: string;
  /** Same meaning as `DomSnapshot.truncated` — see the gate, rule 4. */
  truncated: boolean;
  nodes: AccessibilityNode[];
}

/**
 * Always populated, whether eligible or not — the reason list is itself
 * useful output (docs/phase-2-healing.md, "The gate").
 */
export interface HealingEligibility {
  eligible: boolean;
  reasons: string[];
}

/**
 * The teardown-time gate result for one failed locator, as attached to a
 * test (`healing-gate.json`) and lifted into `FailureContext.healingGate`
 * by the reporter — same pattern as `dom-snapshot.json`/`domSnapshot`. Only
 * eligible entries carry `spec`: `pnpm heal`'s out-of-band pass needs
 * `description`/`candidates` to call `propose()`; a refused entry's spec is
 * never read again, so it isn't carried.
 */
export interface HealingGateVerdict extends HealingEligibility {
  key: string;
  spec?: LocatorSpec;
}

export interface HealingProposalVerification {
  /** MUST be 1 for a proposal to exist at all — see "The verification step". */
  matchCount: number;
  role: string;
  accessibleName: string;
  visible: boolean;
  enabled: boolean;
  /** Named plainly so nobody mistakes this for a live-browser guarantee. */
  verifiedAgainst: 'ax-tree-snapshot';
  verifiedAt: string;
}

export interface HealingProposal {
  id: string;
  runId: string;
  testId: string;
  key: string;
  description: string;
  /** The chain as it stood when this was proposed — for the reviewer's diff. */
  existingCandidates: LocatorCandidate[];
  /** Appended, never substituted — see "The proposal record". */
  candidate: LocatorCandidate;
  verification: HealingProposalVerification;
  rationale: string;
  confidence: number;
  provenance: {
    source: 'healed';
    runId: string;
    generatedAt: string;
    model: string;
  };
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
  /** Set only if `pnpm heal:review` applied it and the post-edit typecheck failed. */
  appliedError?: string;
}

export interface SelfHealingEngine {
  /**
   * Pure, synchronous, zero I/O — safe to call from live test teardown. It
   * decides whether a failure is even worth spending an LLM call on later;
   * it never spends one itself.
   */
  checkEligibility(input: {
    spec: LocatorSpec;
    error: LocatorResolutionError;
    telemetry: LocatorResolution[];
    snapshot: DomSnapshot;
    pageUrl: string;
  }): HealingEligibility;

  /**
   * LLM call + deterministic verification. Out-of-band only — must never be
   * called while a test is executing (mirrors how RCA is a separate pass
   * over `run.json`, not something that runs live). Returns a fully-verified
   * proposal or `null`; `null` is the expected common case, not an error.
   */
  propose(input: {
    spec: LocatorSpec;
    axSnapshot: AccessibilityTreeSnapshot;
    runId: string;
    testId: string;
  }): Promise<HealingProposal | null>;
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
