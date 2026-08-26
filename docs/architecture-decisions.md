# Architecture decisions

Short records of the choices that shaped Phase 1, and what would make each one
wrong. Add a new entry rather than editing an old one when a decision changes.

---

## ADR-001 — TypeScript everywhere

**Decision.** Playwright tests, orchestration API (NestJS) and the future
dashboard are all TypeScript; the AI layer is TypeScript too, not Python.

**Why.** One language means the `Run`, `TestCase` and `LocatorSpec` contracts are
literally shared objects rather than parallel definitions kept in sync by hand —
which is the failure mode that kills solo-maintained platforms. The Python AI
ecosystem is richer, but nothing in Phase 2 needs more than HTTP calls to an LLM.

**Revisit if.** The AI layer starts needing embeddings, local models or heavy
data tooling. At that point extract `packages/ai-engine` into a FastAPI service
behind the same `LlmGateway`-shaped HTTP contract.

---

## ADR-002 — Pre-generated fallback selectors before real-time AI healing

**Decision.** A `LocatorSpec` carries an ordered list of candidates. The engine
walks them and records the outcome. AI healing is a hook (`onHealRequested`) that
fires only after every candidate has failed.

**Why.** Most selector rot is handled by a good fallback chain at zero cost and
zero latency. Calling an LLM on every lookup would be slow and expensive, and it
hides genuine application changes behind silent auto-fixes. Recording every
resolution also produces the dataset the healer needs to be any good.

**Consequence.** `LocatorResolution` telemetry is attached to any test that used a
fallback, so a rotting selector is visible *before* it breaks.

---

## ADR-003 — DOM understanding first, vision later

**Decision.** `captureDomSnapshot()` extracts an accessibility-first, compact
element list — role, accessible name, test id, placeholder, state — rather than
sending raw HTML or screenshots to the model.

**Why.** Raw HTML blows the context window and the budget on a real enterprise
page. The accessibility tree is what a user-facing test should be reasoning about
anyway. Vision becomes worthwhile for canvas-heavy or non-semantic UIs; it is
additive, not a replacement.

---

## ADR-004 — The canonical `Run` document

**Decision.** The custom reporter writes `artifacts/reports/run.json` in a shape
owned by `@aitp/shared`. Dashboard, email, Jira and Slack consume that file.

**Why.** It decouples every integration from Playwright's internal report format,
and it gives the API a single artifact to hydrate from — the API does not need to
parse test output or scrape stdout.

---

## ADR-005 — Match before generate in the AI Command Box

**Decision.** `POST /api/command` first scores the instruction against the
existing test inventory (`playwright test --list`) and runs the matches. AI
generation (Phase 2) is the fallback for when nothing matches.

**Why.** The cheapest, fastest and most reliable answer to "test the employee
registration flow" is the regression test that already covers it. Generating a
fresh script every time would be slower, costlier and less trustworthy than the
suite the team has already reviewed.

---

## ADR-006 — Process isolation now, container isolation later

**Decision.** `RunnerService` spawns `npx playwright test` as a child process,
behind an interface. Docker-per-job replaces the spawn in Phase 4.

**Why.** Phase 1 needs runs to work on a laptop and in Jenkins without a Docker
daemon. Because the spawn is confined to one class, swapping in a container
runner touches one file.

**Consequence.** Until then, concurrent runs would fight over `artifacts/`, so
`RunsService` serialises them in a FIFO queue. Redis/BullMQ replaces that queue
when the dashboard needs real parallel runs.

---

## ADR-007 — Budget cap and cache at the gateway, not the call site

**Decision.** All LLM traffic goes through `HttpLlmGateway`: disk cache, retry
with backoff, per-run USD cap, provider swap, response-JSON repair.

**Why.** Cost control that depends on every call site remembering to be careful
fails the first time someone adds a feature. Nightly CI also re-issues nearly
identical prompts, so the cache is where most of the savings are.

---

## ADR-008 — In-memory persistence in Phase 1

**Decision.** `RunRepository` is an interface with an in-memory implementation;
`infra/prisma/schema.prisma` is checked in but not wired up.

**Why.** It keeps Phase 1 runnable with zero infrastructure while settling the
data model. Swapping in Postgres touches `run.repository.ts` only.

**Consequence.** Run history is lost on API restart. That is acceptable until the
dashboard exists — and it is the first thing Phase 3 should fix.

---

## ADR-009 — Root cause analysis is a separate pass, not part of execution

**Decision.** The execution engine captures failure evidence (console, page
errors, network failures, locator telemetry, DOM snapshot) while the page is
alive and writes it into `run.json`. Analysis happens afterwards —
`pnpm rca`, or automatically in the API once the run is finished.

**Why.** Three properties fall out of it, none of which survive an inline design:
a failing run never waits on a model; analysis can be re-run against an archived
report months later without re-running any test; and analysis can be skipped
entirely (no key, no budget, no network) without touching the suite.

**Consequence.** `run.json` has to be self-contained, which is why the reporter
lifts JSON attachments into `TestResult.context` instead of leaving them as side
files.

---

## ADR-010 — Failures are deduplicated by fingerprint before analysis

**Decision.** Failures are grouped by a hash of test file + title + a normalised
error message. Each group is analyzed once and the verdict is copied to every
member. Generated values (long ids, 4+ digit numbers) are normalised out of the
hash.

**Why.** One broken feature produces four failures on a four-browser matrix. They
are one bug, so paying four times to hear the same answer is pure waste. Without
id normalisation, a fresh `EMP48213` per run would defeat the cache and make every
nightly run pay full price for a failure that has been known for a week.

**Consequence.** The fingerprint doubles as the LLM cache key, so a re-run of the
same failure is free.

---

## ADR-011 — An uncertain verdict is stated as uncertain

**Decision.** Every analysis carries a 0–1 confidence and the evidence lines it
was drawn from. Below 0.5 the report labels it "Possible cause (low confidence)".
The model is instructed to answer `unknown` rather than guess, and any category
it invents is coerced to `unknown`.

**Why.** The failure mode that would kill trust in this platform is a confident,
plausible, wrong answer sending someone to debug the wrong system. A visible
confidence score and quoted evidence make a verdict checkable in seconds, which
is what makes it safe to act on the confident ones.
