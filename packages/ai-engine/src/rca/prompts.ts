import { redactSecrets, type RootCauseAnalysisInput } from '@aitp/shared';
import { renderSnapshotForPrompt } from '../dom/render';

export const RCA_SYSTEM_PROMPT = `You are a senior QA automation engineer doing failure triage on a Playwright test suite.

You are given one failed test and the evidence collected at the moment it failed. Decide WHY it failed and who should act on it.

Rules:
- Base every claim on the evidence provided. Never invent a stack frame, a request or an element that is not there.
- Distinguish clearly between the application being broken and the test being wrong. This distinction is the entire point of the exercise.
- A locator that no longer matches is "selector" — unless the element is genuinely absent because a feature broke, which is "application-bug".
- A 4xx/5xx response, a missing service, a timeout on every request, or a config/credential problem is "environment".
- Wrong or colliding test data (a duplicate ID, a stale fixture) is "test-data".
- Choose "flaky" only when the evidence points to a race or timing issue, not merely because the test passed on retry.
- Choose "unknown" with low confidence rather than guessing. A confident wrong answer is worse than an honest "not enough evidence".
- rootCause: at most two sentences, specific and actionable. Name the element, request or value involved.
- evidence: quote the exact lines from the input that led you there, so a human can check your reasoning in seconds.
- suggestedFix: concrete and minimal. Omit it if you are not confident.`;

export const RCA_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['rootCause', 'category', 'confidence', 'evidence'],
  properties: {
    rootCause: { type: 'string' },
    category: {
      type: 'string',
      enum: [
        'application-bug',
        'test-bug',
        'environment',
        'test-data',
        'selector',
        'flaky',
        'unknown',
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    suggestedFix: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 6 },
  },
} as const;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function section(title: string, body: string | undefined): string {
  return body && body.trim() ? `## ${title}\n${body.trim()}` : '';
}

/**
 * Every evidence channel is bounded. An app hammering a broken endpoint can emit
 * thousands of console errors, and an unbounded join would turn a ~1k-token
 * analysis into a 70k-token one — or blow the context window entirely, which
 * would make analysis fail on exactly the noisy runs that need it most.
 * The last N entries are kept: the ones nearest the failure.
 */
function evidenceList(entries: string[] | undefined, limit = 40, chars = 1_500): string | undefined {
  if (!entries?.length) return undefined;
  const kept = entries.slice(-limit);
  const omitted = entries.length - kept.length;
  const body = truncate(kept.join('\n'), chars);
  return omitted > 0 ? `(${omitted} earlier entries omitted)\n${body}` : body;
}

/**
 * Assembles the evidence into the smallest prompt that still supports a real
 * conclusion. Everything here is size-bounded on purpose: an unbounded stack
 * trace or DOM dump is what turns a $0.01 analysis into a $2 one.
 */
export function buildRcaPrompt(input: RootCauseAnalysisInput): string {
  const context = redactSecrets(input.context ?? {});

  const stack = input.stack
    ? input.stack.split('\n').slice(0, 12).join('\n')
    : undefined;

  const steps = input.steps?.length
    ? input.steps.slice(-12).map((step, index) => `${index + 1}. ${step}`).join('\n')
    : undefined;

  const snapshot = context.domSnapshot
    ? truncate(renderSnapshotForPrompt(context.domSnapshot), 4_000)
    : undefined;

  const locators = context.locatorTelemetry?.length
    ? context.locatorTelemetry
        .slice(-30)
        .map(
          (entry) =>
            `- ${entry.key}: matched via ${entry.candidate.strategy}="${entry.candidate.value}"` +
            `${entry.usedCandidateIndex > 0 ? ` (FELL BACK from candidate 0 to ${entry.usedCandidateIndex})` : ''}` +
            `${entry.healed ? ' (HEALED at runtime)' : ''}`,
        )
        .join('\n')
    : undefined;

  return [
    section('Test', `${input.testTitle}\n(${input.testFile})`),
    section('Steps executed', steps),
    section('Error', truncate(redactSecrets(input.error), 2_000)),
    section('Stack (top frames)', stack),
    section('Browser console errors', evidenceList(context.consoleErrors)),
    section('Uncaught page errors', evidenceList(context.pageErrors, 20, 1_000)),
    section('Failed or 5xx network requests', evidenceList(context.failedRequests)),
    section('Locators resolved during this test', locators),
    section('Page at the moment of failure', snapshot),
  ]
    .filter(Boolean)
    .join('\n\n');
}
