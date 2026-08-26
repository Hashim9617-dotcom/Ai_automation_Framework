# Phase 2 — AI layer: implementation order

Everything below plugs into interfaces that already exist in
`packages/shared/src/types/ai.ts` and are already referenced by the execution
engine and the API. Nothing here requires changing a page object or a spec.

Build in this order — each step is independently useful, and each one produces
the data the next one needs.

---

## 1. DOM understanding — **done**

`captureDomSnapshot()` (now in `@aitp/execution-engine`, since it is browser work
with zero LLM calls) runs automatically on every failure, while the page is still
alive. The snapshot, console errors, page errors, failed requests and locator
telemetry are lifted into `TestResult.context` inside `run.json`.

A typical failure prompt comes out around 1,000 tokens.

Still open:

- Capture a snapshot when a locator falls back, so the healer has before/after.
- Iframe and shadow-DOM traversal.

---

## 2. Root cause analysis — **done**

`LlmRootCauseAnalyzer` (`packages/ai-engine/src/rca/`) turns "expected X received
Y" into an actionable sentence, a category, a confidence and quoted evidence.
`enrichRunWithRca()` applies it across a whole run; `pnpm rca` runs it from the
CLI and the API runs it automatically after any failed run.

Guardrails that shipped with it: cross-browser duplicates are fingerprinted and
analyzed once, generated ids are normalised out of the cache key, `RCA_MAX_FAILURES`
caps distinct analyses per run, a bad or missing model degrades to an `unknown`
verdict instead of throwing, and with no API key the report is left untouched
rather than filled with empty verdicts.

Still open:

- Feed the verdict into the summary **email** (`ReportMailer` renders the same
  HTML, so this is mostly a scheduling question).
- Trend the categories over time — that is the Phase 4 analytics story.

---

## 3. Self-healing selectors

- Implement `SelfHealingEngine.heal()`: given the failing `LocatorSpec` and a DOM
  snapshot, return the best new candidate plus a rationale.
- Wire it into `smartLocatorOptions.onHealRequested` in
  `packages/execution-engine/src/fixtures/index.ts` (the line is already there,
  commented).
- Gate on `env.features.selfHealing` so it can be enabled per environment.
- **Never silently pass.** A healed locator must mark the test as healed, attach
  the rationale, and open a follow-up — a heal is a signal that the app changed,
  not a fix.
- Persist to `LocatorEvent` (schema already in `infra/prisma/schema.prisma`) and
  feed successful heals back as new candidates in the spec.

**Done when** renaming a `data-testid` in the demo app makes the suite heal,
report the heal, and still fail loudly if the element is genuinely gone.

---

## 4. Test-case generation

- Implement `TestCaseGenerator.generate()`: command + DOM snapshot + existing
  cases → `TestCase[]` (schema already defined and zod-validated).
- Pass existing cases in so the model produces *missing* coverage rather than
  duplicating the suite.
- Persist to `GeneratedTestCase` with `approved: false`.

**Done when** "test complete employee registration flow" on a fresh app produces
happy path, duplicate ID, mandatory-field and boundary cases.

---

## 5. Script generation

- Implement `ScriptGenerator.compile()`: `TestCase` + snapshot → a spec file that
  uses the existing page objects and `locator()` helper, not raw selectors.
- Generate the page object too when none exists for the target page.
- Write to `tests/generated/`, run it immediately, and only keep it if it passes
  — a generated test that has never run is a liability.
- Require human approval before it moves into `tests/e2e/`.

**Done when** the command box can take an instruction for a flow with no existing
coverage and end up with a green, reviewable spec in the repo.

---

## 6. Close the loop in the command box

`CommandService.interpret()` currently returns "no match" when keyword scoring
finds nothing. That branch becomes: generate → compile → run → report.

Keep match-before-generate (ADR-005): reuse is faster, cheaper and more
trustworthy than generation.

---

## Guardrails to keep while building this

- Every call through `LlmGateway` — never a direct provider SDK call in feature
  code.
- Every prompt through `redactSecrets()` before it leaves the process.
- Budget cap on (`LLM_BUDGET_USD`), cache on. Check `budgetSnapshot` in the run
  summary.
- Mock gateway path must keep working with no API key, so CI and onboarding never
  depend on credentials.
- Every AI decision must be explainable in the report: what it did, why, and what
  it would have done otherwise.
