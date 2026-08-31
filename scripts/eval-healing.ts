#!/usr/bin/env node
/**
 * Self-healing eval set (docs/phase-2-healing.md).
 *
 *   pnpm eval:healing
 *
 * Six controlled mutations against the bundled demo app — offline,
 * deterministic, free. Four true positives (the healer must propose a
 * verified, correct replacement candidate) and two true negatives (the
 * healer must propose nothing). This is the bar the design is judged
 * against, not the retrospective against last week's real failures: a
 * healer that refuses everything passes that retrospective and is worth
 * nothing, so this is where "does it actually work" gets answered.
 *
 * Every scenario reports, independent of whether an LLM key is configured:
 *   - the gate's verdict (pure logic, always real)
 *   - the pre-check outcome (pure logic, always real — this alone settles
 *     scenario f without ever calling a model)
 *   - the proposal outcome (needs a real model for a-d's actual quality;
 *     reported as BLOCKED rather than run against the mock gateway, which
 *     would silently turn "untested" into a misleading "refused")
 */
/* eslint-disable no-console -- tabular eval report for a human, not a
   machine-consumable log line. */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { LlmSelfHealingEngine } from '@aitp/ai-engine';
import { createLlmGateway, MockLlmGateway } from '@aitp/ai-engine';
import {
  captureAccessibilityTree,
  captureDomSnapshot,
  loadEnvironment,
  SmartLocator,
} from '@aitp/execution-engine';
import {
  checkHealingEligibility,
  findRepoRoot,
  rootLogger,
  type HealingProposal,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmGateway,
  type LocatorResolutionError,
  type LocatorSpec,
} from '@aitp/shared';

const log = rootLogger.child('eval-healing');

/**
 * Thin delegate around the real gateway, purely to report the run's actual
 * token/cost total at the end — `LlmSelfHealingEngine.propose()` doesn't
 * surface per-call usage in its return value (a `HealingProposal` is meant
 * to be evidence for a human reviewer, not a cost ledger), and that's the
 * right call for production code. This wraps it for the eval only, without
 * touching engine.ts.
 */
class InstrumentedGateway implements LlmGateway {
  promptTokens = 0;
  completionTokens = 0;
  costUsd = 0;
  calls = 0;
  cachedCalls = 0;

  constructor(private readonly inner: LlmGateway) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion<string>> {
    const result = await this.inner.complete(request);
    this.record(result);
    return result;
  }

  async completeJson<T>(request: LlmCompletionRequest): Promise<LlmCompletion<T>> {
    const result = await this.inner.completeJson<T>(request);
    this.record(result);
    return result;
  }

  private record(result: LlmCompletion<unknown>): void {
    if (result.usage.cached) {
      this.cachedCalls += 1;
      return;
    }
    this.calls += 1;
    this.promptTokens += result.usage.promptTokens;
    this.completionTokens += result.usage.completionTokens;
    this.costUsd += result.usage.costUsd;
  }
}
const CANDIDATE_TIMEOUT = 2_000; // matches fixtures/index.ts's default
const FALLBACK_TIMEOUT = 750;

const repoRoot = findRepoRoot(__dirname);
const originalHtml = readFileSync(
  path.join(repoRoot, 'tests', 'demo', 'demo-app', 'index.html'),
  'utf8',
);

interface Scenario {
  id: string;
  label: string;
  kind: 'positive' | 'negative';
  mutate: (html: string) => string;
  spec: LocatorSpec;
  /** Drive the page to the state where `spec` should be attempted. */
  prepare: (page: Page, baseUrl: string) => Promise<void>;
  /** For a positive case, does this proposal look like the right fix? */
  isCorrectProposal?: (proposal: HealingProposal) => boolean;
  /**
   * True only for the icon-swap case: per Finding 10 (docs/dms-findings.md),
   * `normalizeAccessibleName`'s automatic fallback inside `SmartLocator`'s
   * `build()` already resolves a PUA-glyph-prefixed accessible name against
   * an `exact: true` candidate — the resolution should SUCCEED, not exhaust
   * and reach the gate at all. That is the strongest possible form of
   * "propose nothing": never even asked, because nothing failed. Every
   * other scenario in this file expects the opposite — an initial
   * resolution failure is the premise the rest of the pipeline runs on.
   */
  expectResolutionSuccess?: boolean;
}

function replaceOnce(html: string, search: string, replacement: string): string {
  if (!html.includes(search)) {
    throw new Error(`Mutation target not found in demo app HTML: ${JSON.stringify(search)}`);
  }
  return html.replace(search, replacement);
}

async function loginOnly(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/login`);
}

async function loginAndReachEmployees(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.getByTestId('login-username').fill('hr.admin');
  await page.getByTestId('login-password').fill('Passw0rd!');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('employee-save').waitFor({ state: 'attached', timeout: 5_000 });
}

const scenarios: Scenario[] = [
  {
    id: 'a-testid-renamed',
    label: '(a) data-testid renamed',
    kind: 'positive',
    mutate: (html) =>
      replaceOnce(
        html,
        `<button id="login-submit" data-testid="login-submit">Login</button>`,
        `<button id="login-submit" data-testid="login-submit-v2">Login</button>`,
      ),
    spec: {
      key: 'eval.a.submit',
      description: 'Primary sign-in button',
      candidates: [{ strategy: 'testId', value: 'login-submit', confidence: 1 }],
    },
    prepare: loginOnly,
    isCorrectProposal: (p) =>
      p.candidate.strategy === 'role' &&
      p.candidate.value === 'button' &&
      typeof p.candidate.options?.name === 'string' &&
      p.candidate.options.name.toLowerCase().includes('login'),
  },
  {
    id: 'b-label-reworded',
    label: '(b) button label reworded',
    kind: 'positive',
    mutate: (html) =>
      replaceOnce(
        html,
        `<button id="login-submit" data-testid="login-submit">Login</button>`,
        `<button id="login-submit" data-testid="login-submit">Sign In</button>`,
      ),
    spec: {
      key: 'eval.b.submit',
      description: 'Primary sign-in button',
      candidates: [
        { strategy: 'role', value: 'button', options: { name: 'Login', exact: true }, confidence: 1 },
      ],
    },
    prepare: loginOnly,
    isCorrectProposal: (p) =>
      p.candidate.strategy === 'role' &&
      p.candidate.value === 'button' &&
      typeof p.candidate.options?.name === 'string' &&
      p.candidate.options.name.toLowerCase().includes('sign in'),
  },
  {
    id: 'c-role-changed',
    label: '(c) role changed (button -> link)',
    kind: 'positive',
    mutate: (html) =>
      replaceOnce(
        html,
        `<button id="login-submit" data-testid="login-submit">Login</button>`,
        `<a id="login-submit" data-testid="login-submit" href="#" role="link">Login</a>`,
      ),
    spec: {
      key: 'eval.c.submit',
      description: 'Primary sign-in button',
      candidates: [
        { strategy: 'role', value: 'button', options: { name: 'Login', exact: true }, confidence: 1 },
      ],
    },
    prepare: loginOnly,
    isCorrectProposal: (p) =>
      p.candidate.strategy === 'role' &&
      p.candidate.value === 'link' &&
      typeof p.candidate.options?.name === 'string' &&
      p.candidate.options.name.toLowerCase().includes('login'),
  },
  {
    id: 'd-moved-container',
    label: '(d) element moved to a new container',
    kind: 'positive',
    mutate: (html) => {
      const withoutButton = replaceOnce(
        html,
        '          <button id="employee-save" data-testid="employee-save" type="submit">Save employee</button>\n',
        '',
      );
      return replaceOnce(
        withoutButton,
        '        </form>',
        '        </form>\n        <button id="employee-save" data-testid="employee-save" type="submit" form="employee-form">Save employee</button>',
      );
    },
    spec: {
      key: 'eval.d.save',
      description: 'Save employee button, inside the registration form',
      candidates: [
        { strategy: 'css', value: '#employee-form button#employee-save', confidence: 1 },
      ],
    },
    prepare: async (page, baseUrl) => {
      await page.goto(`${baseUrl}/login`);
      await page.getByTestId('login-username').fill('hr.admin');
      await page.getByTestId('login-password').fill('Passw0rd!');
      await page.getByTestId('login-submit').click();
      await page.getByText('Register employee').waitFor({ state: 'attached', timeout: 5_000 });
    },
    isCorrectProposal: (p) =>
      p.candidate.strategy === 'role' &&
      p.candidate.value === 'button' &&
      typeof p.candidate.options?.name === 'string' &&
      p.candidate.options.name.toLowerCase().includes('save employee'),
  },
  {
    id: 'e-deleted',
    label: '(e) element genuinely deleted [negative control]',
    kind: 'negative',
    mutate: (html) =>
      replaceOnce(
        html,
        `<button id="logout" data-testid="logout-button" class="secondary hidden">Log out</button>`,
        ``,
      ),
    spec: {
      key: 'eval.e.logout',
      description: 'Log out button in the top bar',
      candidates: [
        { strategy: 'role', value: 'button', options: { name: 'Log out', exact: true }, confidence: 1 },
      ],
    },
    prepare: loginAndReachEmployees,
  },
  {
    id: 'f-slow-render',
    label: '(f) element present but slow to render [negative control]',
    kind: 'negative',
    mutate: (html) =>
      replaceOnce(
        html,
        `<button id="login-submit" data-testid="login-submit">Login</button>`,
        `<span id="login-submit-slot"></span>
        <script>
          setTimeout(() => {
            const b = document.createElement('button');
            b.id = 'login-submit';
            b.setAttribute('data-testid', 'login-submit');
            b.textContent = 'Login';
            document.getElementById('login-submit-slot').replaceWith(b);
            b.addEventListener('click', () => {
              const user = document.getElementById('username').value.trim();
              const pass = document.getElementById('password').value;
              if (user === 'hr.admin' && pass === 'Passw0rd!') {
                document.getElementById('login-error').classList.add('hidden');
                document.getElementById('current-user').textContent = user;
                document.getElementById('login-view').classList.add('hidden');
                document.getElementById('employees-view').classList.remove('hidden');
              }
            });
          }, 2500);
        </script>`,
      ),
    spec: {
      key: 'eval.f.submit',
      description: 'Primary sign-in button',
      candidates: [
        { strategy: 'role', value: 'button', options: { name: 'Login', exact: true }, confidence: 1 },
      ],
    },
    prepare: loginOnly,
  },
  {
    id: 'g-icon-swap',
    label: '(g) icon swapped, PUA glyph changes [negative control]',
    kind: 'negative',
    expectResolutionSuccess: true,
    mutate: (html) => {
      // Simulates the real DmsSynergy bug shape (Findings 5/6/10): an
      // icon-font glyph rendered before the label, so the real computed
      // accessible name is "<glyph> Login", not "Login" — while the
      // rendered/visible text a human reads is unchanged. aria-label sets
      // the computed accessible name directly (correct per the accname
      // spec: aria-label wins over content), which is the simplest faithful
      // way to inject a real Private Use Area character without needing
      // actual icon-font CSS infrastructure. U+E0B0 here stands in for
      // "whichever glyph" — normalizeAccessibleName strips the whole PUA
      // range (U+E000-U+F8FF), not one specific codepoint, so which icon it
      // is shouldn't matter, and that's exactly what this case checks.
      const puaGlyph = String.fromCodePoint(0xe0b0);
      return replaceOnce(
        html,
        `<button id="login-submit" data-testid="login-submit">Login</button>`,
        `<button id="login-submit" data-testid="login-submit" aria-label="${puaGlyph} Login">Login</button>`,
      );
    },
    spec: {
      key: 'eval.g.submit',
      description: 'Primary sign-in button',
      candidates: [
        { strategy: 'role', value: 'button', options: { name: 'Login', exact: true }, confidence: 1 },
      ],
    },
    prepare: loginOnly,
  },
];

function serveHtml(html: string): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

interface ScenarioResult {
  scenario: Scenario;
  gateEligible: boolean;
  gateReasons: string[];
  proposal: HealingProposal | null;
  proposalStatus: 'proposed' | 'refused' | 'blocked-no-llm';
  verdict: 'PASS' | 'FAIL';
  detail: string;
}

async function runScenario(
  browser: Browser,
  scenario: Scenario,
  llmAvailable: boolean,
  gateway: LlmGateway,
): Promise<ScenarioResult> {
  const mutatedHtml = scenario.mutate(originalHtml);
  const { server, baseUrl } = await serveHtml(mutatedHtml);
  const page = await browser.newPage();

  try {
    await scenario.prepare(page, baseUrl);

    let capturedError: LocatorResolutionError | undefined;
    const smart = new SmartLocator(page, {
      candidateTimeout: CANDIDATE_TIMEOUT,
      fallbackCandidateTimeout: FALLBACK_TIMEOUT,
      onResolutionFailed: (_spec, error) => {
        capturedError = error;
      },
    });

    if (scenario.expectResolutionSuccess) {
      // The icon-swap case: correct behavior is resolution succeeding
      // outright, via normalizeAccessibleName's automatic fallback — the
      // gate and healer should never even be reached. That IS "propose
      // nothing," achieved more fundamentally than refusing after a
      // failure. A LocatorResolutionError here means that automatic
      // protection regressed, which is itself the finding.
      try {
        await smart.resolve(scenario.spec);
      } catch (err) {
        return {
          scenario,
          gateEligible: false,
          gateReasons: [],
          proposal: null,
          proposalStatus: 'refused',
          verdict: 'FAIL',
          detail: `expected resolution to SUCCEED (normalizeAccessibleName should have handled the PUA glyph) but it failed instead: ${(err as Error).message}`,
        };
      }
      return {
        scenario,
        gateEligible: false,
        gateReasons: ['resolution succeeded — normalizeAccessibleName handled the PUA glyph automatically; the gate/healer were never reached'],
        proposal: null,
        proposalStatus: 'refused',
        verdict: 'PASS',
        detail: 'correctly proposed nothing — because nothing ever failed, not because anything was refused',
      };
    }

    try {
      await smart.resolve(scenario.spec);
      throw new Error(
        `Scenario ${scenario.id}: locator resolved successfully — the mutation did not break it as intended.`,
      );
    } catch (err) {
      if (!capturedError) throw err; // a real bug in the scenario setup, not the expected failure
    }

    // Model the real gap between a locator failing and teardown actually
    // running (diagnostics attach, other fixtures) — load-bearing for
    // scenario (f): the element needs real wall-clock time to have
    // rendered by the time anything looks again.
    await page.waitForTimeout(1_500);

    const domSnapshot = await captureDomSnapshot(page, { maxElements: 120 });
    const gate = checkHealingEligibility({
      spec: scenario.spec,
      error: capturedError,
      telemetry: [],
      snapshot: domSnapshot,
      pageUrl: page.url(),
    });

    let proposal: HealingProposal | null = null;
    let proposalStatus: ScenarioResult['proposalStatus'] = 'refused';

    if (gate.eligible) {
      const axSnapshot = await captureAccessibilityTree(page);
      const needsLlm = scenario.kind === 'positive';
      if (needsLlm && !llmAvailable) {
        proposalStatus = 'blocked-no-llm';
      } else {
        const engine = new LlmSelfHealingEngine(gateway);
        proposal = await engine.propose({
          spec: scenario.spec,
          axSnapshot,
          runId: 'eval',
          testId: scenario.id,
        });
        proposalStatus = proposal ? 'proposed' : 'refused';
      }
    }

    let verdict: 'PASS' | 'FAIL';
    let detail: string;

    if (scenario.kind === 'negative') {
      verdict = proposal === null ? 'PASS' : 'FAIL';
      detail =
        proposal === null
          ? `correctly proposed nothing (gate eligible=${gate.eligible}, status=${proposalStatus})`
          : `WRONGLY proposed a candidate: ${JSON.stringify(proposal.candidate)}`;
    } else if (proposalStatus === 'blocked-no-llm') {
      verdict = 'FAIL'; // not run, not passed — see report notes
      detail = 'BLOCKED: no LLM API key configured — proposal step not exercised';
    } else if (!proposal) {
      verdict = 'FAIL';
      detail = `expected a proposal, got none (gate eligible=${gate.eligible}, reasons: ${gate.reasons.join('; ')})`;
    } else {
      const correct = scenario.isCorrectProposal?.(proposal) ?? false;
      verdict = correct ? 'PASS' : 'FAIL';
      detail = correct
        ? `proposed ${JSON.stringify(proposal.candidate)}, verified matchCount=${proposal.verification.matchCount}`
        : `proposed ${JSON.stringify(proposal.candidate)} but it does not look like the right fix`;
    }

    return { scenario, gateEligible: gate.eligible, gateReasons: gate.reasons, proposal, proposalStatus, verdict, detail };
  } finally {
    await page.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  // createLlmGateway() reads process.env directly — nothing loads .env into
  // it unless something calls loadEnvironment() (or its internal
  // ensureDotenv()) first. Without this, ANTHROPIC_API_KEY sitting in .env
  // is silently invisible to this script no matter how correctly it's set,
  // and everything falls back to the mock with no indication why.
  loadEnvironment();
  const rawGateway = createLlmGateway();
  const llmAvailable = !(rawGateway instanceof MockLlmGateway);
  if (!llmAvailable) {
    log.warn(
      'No LLM API key configured — positive scenarios (a-d) will be reported as BLOCKED, not run against the mock gateway.',
    );
  }
  // One shared instance for the whole run, not one per scenario — a real
  // budget/cache should apply across the run, not reset per scenario, and
  // this is also what makes a single end-of-run token/cost total possible.
  const gateway = new InstrumentedGateway(rawGateway);

  const browser = await chromium.launch();
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      log.info('Running scenario', { id: scenario.id });
      results.push(await runScenario(browser, scenario, llmAvailable, gateway));
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== Self-healing eval set — results ===\n');
  for (const r of results) {
    console.log(`${r.verdict === 'PASS' ? 'PASS' : 'FAIL'}  ${r.scenario.label}`);
    console.log(`      gate: eligible=${r.gateEligible}`);
    for (const reason of r.gateReasons) console.log(`        - ${reason}`);
    console.log(`      ${r.detail}`);
    console.log('');
  }

  const blocked = results.filter((r) => r.proposalStatus === 'blocked-no-llm').length;
  const passed = results.filter((r) => r.verdict === 'PASS').length;
  console.log(`${passed}/${results.length} scenarios passed. ${blocked} blocked on missing LLM API key.`);
  console.log(
    `Real LLM cost this run: ${gateway.calls} call(s), ${gateway.cachedCalls} served from cache, ` +
      `${gateway.promptTokens} prompt + ${gateway.completionTokens} completion tokens, $${gateway.costUsd.toFixed(4)}.`,
  );
  if (blocked > 0) process.exitCode = 2;
  else if (passed !== results.length) process.exitCode = 1;
}

main().catch((error: Error) => {
  log.error('Eval run failed', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});
