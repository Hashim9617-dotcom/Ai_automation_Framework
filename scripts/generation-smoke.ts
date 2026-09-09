#!/usr/bin/env node
/**
 * The FIRST real API call the generation engine has ever made.
 *
 * Every test to date used a counting or mock gateway written by the same author
 * as the code, from the same understanding — so both can be wrong the same way
 * while the suite stays green. A stub cannot falsify itself.
 *
 * **The point is not that it goes green.** A smoke that only checks "it worked"
 * proves less than it looks. The point is to compare the MOCK to REALITY and
 * report every place they differ, field by field:
 *
 *   1. does the real response parse into the shape the mock returns?
 *   2. the cache: two generate() calls at one key -> dispatch count exactly 1,
 *      and a different command dispatches twice.
 *   3. the budget: does spentUsd move on a real call and stay flat on a cached one?
 *   4. checkGrounding against a REAL model's labels — does it ever claim
 *      `observed` for something the capture contradicts?
 *   5. actual cost against the $0.08 estimate.
 *
 * Needs no DMS: a capture already on disk, plus the real gateway.
 *
 * Run:  pnpm smoke:generation
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  HttpLlmGateway,
  BudgetGuard,
  MemoryCompletionCache,
  GenerationEngine,
} from '@aitp/ai-engine';
import {
  boundCaptureForCommand,
  findRepoRoot,
  type BoundedCapture,
  type CapturedState,
  type AccessibilityNode,
  type InventoryEntry,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmGateway,
} from '@aitp/shared';

/**
 * Wraps the real gateway and records every request and response VERBATIM.
 *
 * Counting dispatches at this layer is not the same as counting `complete()`
 * calls: the cache lives inside `HttpLlmGateway`, so this sees every call
 * whether or not it reached the network. The network count is taken from the
 * usage flag the gateway itself reports.
 */
class RecordingGateway implements LlmGateway {
  readonly requests: LlmCompletionRequest[] = [];
  readonly rawResponses: unknown[] = [];
  readonly completions: Array<LlmCompletion<unknown>> = [];

  constructor(private readonly inner: LlmGateway) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion<string>> {
    this.requests.push(request);
    const completion = await this.inner.complete(request);
    this.rawResponses.push(completion.content);
    this.completions.push(completion);
    return completion;
  }

  async completeJson<T>(request: LlmCompletionRequest): Promise<LlmCompletion<T>> {
    this.requests.push(request);
    const completion = await this.inner.completeJson<T>(request);
    this.rawResponses.push(completion.content);
    this.completions.push(completion as LlmCompletion<unknown>);
    return completion;
  }
}

/** Loads the richest capture on disk. No DMS needed — this is already here. */
function loadCapture(root: string): { states: CapturedState[]; label: string } {
  const dir = path.join(root, 'artifacts', 'inspect');
  if (!existsSync(dir)) throw new Error('no artifacts/inspect — nothing to generate against');

  let best: { states: CapturedState[]; label: string; nodes: number } | undefined;
  for (const session of readdirSync(dir)) {
    const pages = path.join(dir, session, 'pages.json');
    if (!existsSync(pages)) continue;
    for (const page of JSON.parse(readFileSync(pages, 'utf8'))) {
      const nodes: AccessibilityNode[] = (page.accessibilityTree?.nodes ?? []).map(
        (n: AccessibilityNode) => ({
          role: n.role,
          name: n.name,
          enabled: n.enabled ?? true,
          ...(n.selected === undefined ? {} : { selected: n.selected }),
        }),
      );
      if (nodes.length === 0) continue;
      if (!best || nodes.length > best.nodes) {
        best = {
          label: page.label,
          nodes: nodes.length,
          states: [
            {
              id: page.label,
              label: page.label,
              url: page.url,
              nodes,
              truncated: page.truncated ?? false,
            },
          ],
        };
      }
    }
  }
  if (!best) throw new Error('every capture on disk has zero nodes — refusing to smoke against nothing');
  return best;
}

/**
 * Minimal .env reader.
 *
 * Deliberately NOT `source .env` from a shell. This file holds live
 * credentials, and a shell parse error prints them to the terminal — which is
 * exactly what happened on the first attempt at this smoke: three lines of
 * .env, including a password, went to stdout because `source` tried to execute
 * them. Reading the file in-process cannot do that.
 */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    const value = trimmed.slice(eq + 1).trim();
    process.env[key] = value.replace(/^"(.*)"$/, '$1');
  }
}

const line = (s = '') => console.log(s);
const heading = (s: string) => {
  line();
  line(`=== ${s}`);
};

async function main(): Promise<void> {
  const root = findRepoRoot();
  // Loaded here rather than by the shell: .env holds live credentials, and
  // sourcing it into a terminal prints them on any parse error.
  loadEnvFile(path.join(root, '.env'));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — this smoke exists to hit the real API');

  const { states, label } = loadCapture(root);
  // Keywords that actually appear in this capture. State selection scores on
  // keyword overlap, so a command sharing no word with the capture bounds to
  // ZERO states — the first run of this smoke did exactly that and asked the
  // model about an empty page.
  const COMMAND_A = 'test the dashboard refresh button';
  const COMMAND_B = 'test the documents and file explorer links';

  const capture: BoundedCapture = boundCaptureForCommand(
    { sessionId: 'smoke', states, transitions: [] },
    COMMAND_A,
  );
  line(`capture: "${label}" — ${states[0]!.nodes.length} nodes, bounded to ${capture.states.length} state(s)`);

  // ASSERT THE SMOKE'S OWN PREMISE. A capture that bounded to nothing produces
  // a model call about an empty page, and "0 proposals" then reads as a
  // finding about the engine rather than about the input.
  if (capture.states.length === 0) {
    throw new Error(
      `the command "${COMMAND_A}" bounded to 0 states — the model would be asked about an ` +
        'empty capture, and any conclusion drawn from that would be about the command, not the engine',
    );
  }
  const boundedNodes = capture.states.reduce((n, s) => n + s.nodes.length, 0);
  line(`bounded capture carries ${boundedNodes} node(s)`);

  const budget = new BudgetGuard();
  const real = new HttpLlmGateway({
    provider: 'anthropic',
    apiKey,
    models: {
      reasoning: process.env.LLM_MODEL_REASONING ?? 'claude-sonnet-4-5',
      fast: process.env.LLM_MODEL_FAST ?? 'claude-haiku-4-5',
    },
    // MEMORY, not disk: a disk cache from an earlier run would make the cache
    // test pass without ever proving anything about this one.
    cache: new MemoryCompletionCache(),
    budget,
  });
  const gateway = new RecordingGateway(real);
  const engine = new GenerationEngine(gateway);

  const inventory: InventoryEntry[] = [];
  const generate = (command: string) =>
    engine.generate({ command, capture, inventory, existingCaseTitles: [], runId: 'smoke' });

  // ---- call 1 ---------------------------------------------------------------
  heading('CALL 1 — first real generation');
  const before1 = budget.snapshot();
  const first = await generate(COMMAND_A);
  const after1 = budget.snapshot();
  line(`proposals ${first.proposals.length}  refusals ${first.refusals.length}  called ${first.called}`);
  line(`budget: ${before1.spentUsd} -> ${after1.spentUsd} USD, calls ${before1.calls} -> ${after1.calls}`);
  line(`usage: ${JSON.stringify(gateway.completions.at(-1)?.usage)}`);
  line(`provider/model: ${gateway.completions.at(-1)?.provider}/${gateway.completions.at(-1)?.model}`);

  // ---- call 2: same command, must not reach the network ---------------------
  heading('CALL 2 — same command, cache must avoid the MODEL');
  const second = await generate(COMMAND_A);
  const after2 = budget.snapshot();
  line(`same cacheKey: ${second.cacheKey === first.cacheKey}`);
  line(`usage.cached on second: ${gateway.completions.at(-1)?.usage.cached}`);
  line(`budget after: ${after2.spentUsd} USD, calls ${after2.calls}  (unchanged means no dispatch)`);

  // ---- call 3: different command, must dispatch -----------------------------
  heading('CALL 3 — different command, must dispatch again');
  const third = await generate(COMMAND_B);
  const after3 = budget.snapshot();
  line(`different cacheKey: ${third.cacheKey !== first.cacheKey}`);
  line(`usage.cached on third: ${gateway.completions.at(-1)?.usage.cached}`);
  line(`budget after: ${after3.spentUsd} USD, calls ${after3.calls}`);

  // ---- the comparison -------------------------------------------------------
  heading('WHAT THE MODEL ACTUALLY RETURNED');
  const raw = gateway.rawResponses[0] as { cases?: unknown[]; openQuestions?: unknown[] } | undefined;
  line(`top-level keys the model sent: ${Object.keys(raw ?? {}).join(", ")}`);
  line(`the engine reads only: cases`);
  line(JSON.stringify(raw, null, 2).slice(0, 2600));

  heading('GROUNDING — the model’s own labels against the capture');
  for (const proposal of [...first.proposals, ...third.proposals]) {
    for (const assertion of proposal.assertions) {
      line(
        `  modelSaid=${assertion.modelSaid.padEnd(8)} grade=${assertion.grade.padEnd(12)} ` +
          `overrode=${String(assertion.overrodeModel).padEnd(5)} why=${assertion.why}`,
      );
      line(`     claim: ${assertion.claim.role} "${assertion.claim.name}" ${assertion.claim.property}=${assertion.claim.expected}`);
    }
  }
  for (const refusal of [...first.refusals, ...third.refusals]) {
    line(`  REFUSED "${refusal.title}" — invented entryState ${JSON.stringify(refusal.claimedEntryState)}`);
  }

  heading('COST');
  const final = budget.snapshot();
  line(`spent ${final.spentUsd} USD over ${final.calls} network call(s), cap ${final.capUsd}`);
  line(`estimate for this smoke was $0.08 — ratio ${(final.spentUsd / 0.08).toFixed(2)}x`);

  // Write the raw material so the field-by-field comparison is against bytes.
  const outDir = path.join(root, 'artifacts', 'smoke');
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'generation-smoke.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        capture: label,
        requests: gateway.requests.map((r) => ({
          model: r.model,
          temperature: r.temperature,
          maxTokens: r.maxTokens,
          messageCount: r.messages.length,
          messageRoles: r.messages.map((m) => m.role),
          cacheKey: r.cacheKey,
          hasResponseSchema: Boolean(r.responseSchema),
        })),
        completions: gateway.completions.map((c) => ({
          provider: c.provider,
          model: c.model,
          usage: c.usage,
        })),
        rawResponses: gateway.rawResponses,
        proposals: first.proposals,
        refusals: first.refusals,
        budget: final,
      },
      null,
      2,
    ),
    'utf8',
  );
  const landed = readFileSync(file, 'utf8');
  if (!landed.includes('rawResponses')) throw new Error('smoke output did not land — refusing to report success');
  line(`\nraw material written and verified: ${file}`);
}

main().catch((error: Error) => {
  console.error('SMOKE FAILED:', error.stack ?? error.message);
  process.exit(1);
});
