# Where we are

Read this first if you have no memory of this project. It exists so a fresh
session (or a fresh person) doesn't have to reconstruct context from git log
and guesswork.

---

## The baseline: 42 passed / 0 failed / 0 flaky / 4 skipped

This is the current, confirmed state of the DmsSynergy suite (`tests/app/`,
against `dmsuiv3.aitalkx.com`). Not a green rubber stamp — read
[`docs/dms-findings.md`](dms-findings.md) for the full history: several
things that looked like app bugs were retracted after more scrutiny turned
out to be our own test code, and that retraction discipline is why this
number can be trusted.

**Known intermittent flake, unresolved:** a prior session's regression run
saw 3 flaky results on `nav.fileExplorer`/`admin.new` (single-candidate
`LocatorResolutionError`, always recovering on retry). Investigated
2026-09-01: the per-candidate timeout budget logic is confirmed correct
(single-candidate specs get the full timeout, not the demoted fallback one —
verified both by reading `smart-locator.ts` and by an empirical runtime
test). A targeted 4-way-concurrency reproduction (24 attempts) and 3
required full-suite runs (0 flaky each) both failed to reproduce it, and no
trace.zip survived from the original occurrence — Playwright wipes its own
`outputDir` (`artifacts/test-results`) at the start of every run, before
anything of ours gets a chance to look at it. Bottom line: root cause still
unknown, no fix applied — deliberately, since the earlier base-class-retry
"fix" for this same shape of problem was wrong and got rejected.

That evidence-loss problem is now fixed (2026-09-01): `AitpReporter.onEnd`
(`packages/reporting-engine/src/reporters/aitp-reporter.ts`) archives a
run's full `reports/` + `test-results/` — traces, videos, screenshots
included — under `artifacts/runs/<runId>/` whenever that run had any
failures or flakes, before the next run's cleanup can touch anything. (Not
`global-setup.ts` — that runs too late, after Playwright's own internal wipe
has already happened; the archival has to happen at the end of the run that
still has the evidence, not the start of the next one.) Clean runs still get
wiped normally; nothing is pruned automatically yet, so `artifacts/runs/`
will grow unbounded across failing runs — fine for now, revisit if it
matters. If this flake recurs, its trace will be sitting under
`artifacts/runs/<that run's id>/test-results/`; inspect it before touching
any locator code.

**How to run it:**

```powershell
pnpm.cmd install
pnpm.cmd exec playwright install --with-deps chromium   # first time only
pnpm.cmd auth                                             # if .env has no valid session yet
pnpm.cmd test --project=chromium
pnpm.cmd test:report                                       # opens the HTML report
```

The 4 skipped are gated behind `ALLOW_WRITES=true` (3 tests that create real
records — user, role, workspace — in the live app) plus one `test.fixme` for
a genuinely unresolved app-side anomaly (Finding 14, folder-step selection
in the upload wizard — not yet root-caused, deliberately left open rather
than forced to pass or silently red). **`ALLOW_WRITES` has never been set
in this project. Don't set it without deciding that on purpose.**

---

## Phase 2 status: self-healing

**What it is.** When a locator (a `LocatorSpec` — an ordered list of
fallback candidates for finding one element) exhausts every candidate and
fails, self-healing can *propose* a replacement candidate for a human to
review. Design lives in full at
[`docs/phase-2-healing.md`](phase-2-healing.md); this is the short version.

**The core decision: propose, never heal.** The healer NEVER substitutes a
locator mid-test. When a locator fails, the test still fails — same as with
no healer installed at all. Separately, if the failure clears a 5-rule
eligibility gate, an out-of-band pass may later produce a *proposal*: a
candidate, verified unique against a captured accessibility snapshot, with
evidence, written to `run.json`. A human runs `pnpm heal:review`, looks at
the evidence and an exact diff, and only then does anything touch a page
object.

**Why.** During the shakedown that produced the 42/0/0/4 baseline, most
things that looked like locator bugs weren't — dead sessions misread as
selector failures, a genuine app defect, a test asserting the wrong
contract, a locator bug with a completely different mechanism than assumed.
A live healer, given any of those, doesn't fail loudly — it finds *some*
element satisfying its own criteria, resolves, and the test goes green. A
wrong green is worse than a red: a red gets investigated, a wrong green
gets trusted. The whole design is built to survive that failure mode, not
just add a feature.

**Implemented:**
- `checkHealingEligibility` (`packages/shared/src/healing/gate.ts`) — the
  5-rule gate, pure/sync/zero I/O, unit-tested
  (`tests/unit/healing-gate.spec.ts`, 13 tests)
- `LlmSelfHealingEngine.propose()` (`packages/ai-engine/src/healing/engine.ts`)
  — one LLM call + deterministic verification, out-of-band only, never
  called while a test runs
- Teardown wiring (`packages/execution-engine/src/fixtures/index.ts`) —
  runs the free gate check on every locator failure; only for eligible ones,
  captures a real CDP accessibility tree
- `pnpm heal` (`scripts/heal.ts`) — the out-of-band pass over a real
  `run.json`, mirrors `pnpm rca`'s structure (fingerprint/dedup, disk cache,
  budget cap). Verified end to end against a real Playwright run, not just
  the eval harness.
- `pnpm heal:review` (`scripts/heal-review.ts`) — approval CLI: shows
  evidence, prints the exact diff, requires per-proposal confirmation,
  refuses to touch any file with uncommitted changes
- `pnpm eval:healing` (`scripts/eval-healing.ts`) — 7-scenario eval set
  against the bundled demo app, see below

**Not implemented / not done:**
- `env.features.selfHealing` is `true` for DmsSynergy as of 2026-09-01. It
  was flipped on when the flag still controlled nothing (logged at startup
  only) — caught immediately as a real problem ("someone will later set it
  to false and believe healing is disabled") and fixed the same day: the
  flag now gates the one real cost self-healing adds, the CDP accessibility
  snapshot on a gate-eligible failure (`fixtures/index.ts`) — off means that
  capture genuinely doesn't happen, verified by flipping it off and
  confirming `healingContext`/`healing-context.json` are absent while the
  free gate check (`healingGate`) still runs. `pnpm heal` also now refuses
  outright with a clear message if the flag is off for the resolved
  environment. `pnpm heal:review` stays unconditional on purpose — reviewing
  an already-generated proposal is harmless regardless of the flag.
- A real DmsSynergy failure has now gone through `pnpm heal` →
  `pnpm heal:review` end to end (2026-09-01): a deliberately mutated
  `admin.refresh` locator (typo'd label) produced a real LLM proposal at
  0.98 confidence, correctly diagnosing the typo; `heal:review` refused it
  while the source file was dirty, then on a clean tree appended the healed
  candidate with provenance; re-breaking only the original candidate and
  re-running confirmed the appended fallback (not luck) is what resolves it.
  Reverted immediately after — synthetic, not committed. The eval set
  (synthetic, demo-app) remains the repeatable regression check; this was a
  one-off confirmation that the pipeline also works against the real app.
- The eval set says the *pipeline* works; it doesn't say the healer will
  produce equally good proposals against DmsSynergy's actual component
  quirks (the tree-row name-concatenation pattern from Finding 11, for
  instance) — the demo app doesn't reproduce those.

### Known issue: LLM cost reporting is not model-aware

`HttpLlmGateway` (`packages/ai-engine/src/gateway/http-gateway.ts`) prices
every completion at one fixed rate — $3/$15 per million tokens, in/out —
regardless of which model actually ran. `createLlmGateway()`
(`packages/ai-engine/src/gateway/factory.ts`) never passes model-specific
pricing in, so a Haiku call and a Sonnet call currently report identical
`costUsd` for identical token counts, even though Haiku is genuinely
cheaper. The rate itself is also hardcoded, so it will silently drift out
of date as provider pricing changes — nothing here reads live pricing.

**Token counts (`promptTokens`/`completionTokens`) are real and accurate.**
Only the derived `costUsd` is wrong. Anywhere this matters — reading a
budget report, deciding whether `LLM_BUDGET_USD` headroom is real — trust
the token counts, not the dollar figure.

**This makes `LLM_BUDGET_USD` fail conservative, not dangerous**: because
the fixed rate ($3/$15) is Sonnet-level pricing applied even to cheaper
Haiku calls, the budget guard trips *earlier* than a model-aware
calculation would, never later. A run can stop early on an inflated cost
estimate; it can't blow through the real budget because the estimate came
in too low.

Not fixed — flagged, not fixed, per explicit instruction to note it and
move on rather than fix it now.

---

## The seven eval cases, and what each one actually proves

`pnpm eval:healing` — six mutations to the bundled demo app plus one
simulating the real DmsSynergy bug shape. Last real run: **7/7, cold LLM
cache, 5 real calls, 4029 prompt + 532 completion tokens = 4561 tokens
total.** (Dollar cost deliberately not quoted here — see "Known issue: LLM
cost reporting is not model-aware" above; the token counts are the real
measurement, the derived cost isn't.)

| # | Mutation | Proves |
|---|---|---|
| a | `data-testid` renamed | The healer proposes a correct replacement when the *only* candidate strategy breaks. |
| b | Button label reworded | The proposal tracks a *semantic* change (new visible text), not a generic fallback. |
| c | Role changed, button → link | The proposal follows a structural change, and self-reports lower confidence for the least-evidenced inference. |
| d | Element moved outside its container | A CSS-scoped candidate breaking doesn't strand the healer — it proposes a container-independent fix. |
| e | Element genuinely deleted | **Negative control.** The healer must propose nothing. It calls the model, which correctly finds nothing plausible and declines. |
| f | Element rendered 2.5s late (genuinely slow, not broken) | **Negative control, and the strongest one.** A pre-check re-checks the *original* candidates against the fresh snapshot before ever calling a model — by teardown time the element has appeared, so it refuses without spending a token. Proves a merely-slow locator can't be "healed" into an unnecessary change. |
| g | Icon-font glyph prefix on the accessible name (simulates Findings 5/6/10) | **Negative control, different mechanism.** The locator should never even fail — `normalizeAccessibleName`'s existing automatic fallback resolves it upstream, so the gate and healer are never reached at all. This is "propose nothing" in its strongest form: not refused, never asked. |

a–d are true positives (must propose); e–g are true negatives (must not).
Both halves passing, with real evidence for each, is the acceptance bar —
not the retrospective against last week's history, which only proves the
gate is *safe*. The eval set is what proves it's *useful*.

---

## The exact next command to run

```powershell
pnpm.cmd eval:healing
```

Confirms the eval set still passes 7/7 with today's code before doing
anything else with self-healing. If it does, the next real step (not yet
done) is running the full DmsSynergy suite, then `pnpm heal` against its
`run.json`, then `pnpm heal:review` against whatever it proposes — the
first real, non-synthetic test of this feature.

---

## Setup on a fresh clone

```powershell
node -v      # need v20+
pnpm -v      # install via `npm install -g pnpm` if missing
git --version

cd ai-testing-platform
pnpm.cmd install
pnpm.cmd exec playwright install --with-deps chromium

copy .env.example .env
notepad .env       # fill in the variables below, then save

pnpm.cmd test --project=unit      # sanity check — no browser, no network
pnpm.cmd auth                     # interactive login, saves a session
pnpm.cmd test --project=chromium --grep @smoke
```

See also [`SETUP-NEW-MACHINE.md`](../SETUP-NEW-MACHINE.md) at the repo root
for the fuller walkthrough (that file predates the git remote existing —
skip its "there is no git remote" section, that part's done).

### `.env` variable names required (names only — never commit values)

**Core, required to run anything against the real app:**
- `TEST_ENV`
- `BASE_URL`
- `APP_USERNAME`
- `APP_PASSWORD`

**AI layer (Phase 2 — RCA and self-healing both use this):**
- `LLM_PROVIDER`
- `ANTHROPIC_API_KEY`
- `LLM_MODEL_REASONING`
- `LLM_MODEL_FAST`

Without a key, the platform falls back to a mock LLM gateway and still
runs — `pnpm rca`, `pnpm heal`, and `pnpm eval:healing`'s positive scenarios
just report themselves as skipped/blocked rather than faking a result.

**Optional / tuning (see `.env.example` for the full annotated list):**
`LLM_BUDGET_USD`, `LLM_MAX_CALLS`, `LLM_CACHE`, `RCA_MAX_FAILURES`,
`RCA_AUTO`, `LOCATOR_CANDIDATE_TIMEOUT`, `LOCATOR_FALLBACK_TIMEOUT_MS`,
`TEST_DATA_SEED`, `LOG_LEVEL`, `API_PORT`.

**`ANTHROPIC_API_KEY` expires 1 Dec 2026, 12:00 — rotate before then:
Console → API Keys → create new, update .env, revoke old.**
