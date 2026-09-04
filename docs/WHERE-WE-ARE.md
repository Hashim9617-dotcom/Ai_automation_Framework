# Where we are

Read this first if you have no memory of this project. It exists so a fresh
session (or a fresh person) doesn't have to reconstruct context from git log
and guesswork.

> ⚠️ **Before you share any test artifact: never send a raw `trace.zip`
> outside the team.** A Playwright trace contains a live session — the
> `refresh_token` cookie plus `access_token`/`refresh_token` from
> localStorage — and the access token authorises real API calls for 60
> minutes from capture. Pasting one into a ticket to help someone debug is
> the likeliest leak path and needs no CI involvement at all. The same goes
> for anything under `artifacts/test-results/` or `artifacts/runs/`, and for
> the Playwright HTML report, which embeds traces under `html/data/*.zip`.
> `run.json`, `junit.xml` and `summary.html` are token-free. The CI boundary
> is enforced in [`infra/jenkins/Jenkinsfile`](../infra/jenkins/Jenkinsfile),
> which had a latent version of exactly this bug before it ever ran — see
> "Latent defect, found before first use" below before you touch that file.

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
wiped normally. If this flake recurs, its trace will be sitting under
`artifacts/runs/<that run's id>/test-results/`; inspect it before touching
any locator code.

**Inspection captures are retained, and deliberately never committed.**
`pnpm inspect` writes one timestamped directory per session under
`artifacts/inspect/` and keeps the newest 20 — **count-capped but never aged
out**, unlike failure archives below. The difference is deliberate: a failure
archive is diagnostics (worthless once the failure is understood, bulky enough
to need an expiry), while a capture is *provenance* — it is what a locator was
written against, and an old one is more valuable than a new one for answering
"why does this locator say ABCD". Ageing them out would recreate exactly the
loss this retention exists to prevent: the original 24-page capture the whole
45-test suite was built from was destroyed by the inspector overwriting itself,
and cannot be reproduced now that the app's data has moved on
([`dms-suite.md`](dms-suite.md) records that honestly rather than citing it).

They stay **gitignored, and are not committed** — they hold real workspace
names, document titles and user names from a live customer system, and
committing that copies customer data into permanent git history. A redacted
version was considered and rejected: redaction destroys precisely the detail
that makes a capture useful ("why does this locator say ABCD" needs the real
name), while the facts that *survive* redaction — 0% testid coverage, the
role+name strategy, Finding 11's name shape — are already written down in
reviewed prose in [`tests/app/README.md`](../tests/app/README.md) and
[`dms-findings.md`](dms-findings.md). So it would restate documented knowledge
in exchange for a recurring human redaction review whose failure mode is a
quiet leak.

**Retention.** `global-setup.ts` prunes that archive on every suite start:
keep the newest 10, drop anything older than 14 days, one log line naming
what went. Both rules prune, so the count is a hard cap — without that,
nightly runs would fill the disk and surface as a run dying on ENOSPC one
morning with no obvious cause. The tradeoff to know about: an archive from a
rare flake nobody investigated is deleted at 14 days even if it's the only
copy of that evidence. Raise `MAX_ARCHIVE_AGE_DAYS` if that window is too
short.

**The archive copies exactly two directories** — `artifacts/reports` and
`artifacts/test-results`, both named explicitly in `archiveIfNotClean`.
`artifacts/auth/` (live session state) is structurally unreachable: there is
no recursive copy of `artifacts/` itself. Verified by planting a sentinel
file in `artifacts/auth/`, forcing a failing run, and confirming it appears
nowhere in the resulting archive.

⚠️ **But the archived traces do contain live session tokens.** Playwright
records network traffic and storage state, so `trace.zip` holds the
`refresh_token` cookie plus `access_token`/`refresh_token` from
localStorage — confirmed by extracting an archived trace and matching
against `artifacts/auth/app.json`. This is inherent to trace capture, not
to archiving, and it was already true of `artifacts/test-results`. What
archiving changed is the *lifetime*: those tokens used to be wiped at the
next run, and now persist up to 10 failing runs / 14 days. Mitigating:
`artifacts/` is gitignored so none of it reaches the repo, and the exposure
window is bounded by the **access token's 60-minute TTL** — that's the token
that actually authorises calls (not the refresh token's 15 minutes, which is
a different thing and not the bound that matters here).

**Never share a raw `trace.zip` outside the team.** Pasting one into a
ticket to help someone debug is the likeliest leak path and needs no CI
involvement at all — the trace carries a working session for up to an hour.
Share the failing test name, the error, and a screenshot instead; if someone
genuinely needs the trace, hand it over inside the team and say why.

### Latent defect, found before first use: CI would have published live sessions

**Nothing was ever exposed.** `infra/jenkins/Jenkinsfile` has never run —
there is no Jenkins instance and no build history; the file has sat in the
repo since the Phase 1 scaffold. The defect below was real and would have
published working credentials on the pipeline's first failing run, but it
was caught while the file was still inert. Nothing to purge, nobody to
notify, no cleanup outstanding.

Recorded anyway, because the defect is subtle, and the guardrail now sitting
in the Jenkinsfile only makes sense if you know what it guards against. If
you are the person wiring this pipeline up for real, this section is for you.

**The defect.** The post block archived `artifacts/reports/**`. That glob
reads like a report-only glob and is not: the Playwright HTML report embeds
its attachments, so every trace would have been swept up under
`artifacts/reports/html/data/*.zip` and published to the build page,
readable by anyone who could view the job. Each trace carries a live session
— `refresh_token` cookie plus `access_token`/`refresh_token` from
localStorage — verified by unzipping one and matching it against
`artifacts/auth/app.json`.

**It would not have been limited to failing builds.** This is the part worth
carrying forward. `trace: 'retain-on-failure'` keeps the trace of a failed
*attempt*, so a test that fails and then passes on retry leaves a trace
behind while the build finishes **green**. Verified deliberately with a
throwaway probe spec that failed on attempt 0 and passed on retry: run
status `passed`, exit code 0, Jenkins would have shown it blue — and a
token-bearing trace zip was still sitting in the HTML report. Any reasoning
about this that starts with "only the red builds matter" is wrong.

**What it would have reached.** `TEST_ENV` is a `choice` parameter
restricted to `qa`/`staging`, and the job authenticates with the
`aitp-qa-admin-*` credentials — so QA/staging admin sessions, not
production. The access token's 60-minute TTL would have bounded each one.
Real but moderate severity, had it ever run.

**The fix (in place now).** `archiveArtifacts` names only the three files
verified token-free — `run.json`, `junit.xml`, `summary.html` — and the HTML
report is published only after `rm -f artifacts/reports/html/data/*.zip`
strips the embedded traces. Results, errors, screenshots and videos survive
that; only trace-viewer links go dead. The Jenkinsfile carries a comment
block naming the trap explicitly, so the glob doesn't get widened back by
someone who reasonably assumes `reports/**` means reports.

**When you do wire this up, verify it stayed fixed.** On the controller,
after the first few builds:

```bash
find "$JENKINS_HOME/jobs/<JOB>/builds" \
  \( -path "*/archive/artifacts/reports/html/data/*.zip" \
     -o -path "*/htmlreports/*/data/*.zip" \) -print
```

Any output means traces are being published again. Both locations matter:
`archive/` is `archiveArtifacts`, `htmlreports/` is
`publishHTML(keepAll: true)` keeping a copy per build.

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

## Phase 2 status: step 3, test-case generation

Design: [`docs/phase-2-generation.md`](phase-2-generation.md), which is the
authority. This is the orientation summary.

**Where it stands as of 2026-09-04 (all committed and pushed):**

| | Status |
| --- | --- |
| **P1** — AX-tree capture in `pnpm inspect` | **done** |
| **P2a** — `selected`/`expanded`/`checked`/`level` in `captureAccessibilityTree` | **done** |
| **P2** — state-oriented capture with declared, cross-checked transitions | **done** |
| **P3** — the generator itself | **designed, NOT built.** This is next. |

**The fixture exists and the scores ARE recorded** — `pnpm eval:generation`,
`scripts/eval-generation-fixture.ts`. Every stage is reproducible with
`AITP_FIXTURE_STAGE=baseline|p2a|p2`, which recreates an earlier stage by
removing exactly what that prerequisite added:

| Stage | #1 | #2 | #3 | #4 | Score |
| --- | --- | --- | --- | --- | --- |
| empty capture (ignorance check, runs every time) | ✗ | ✗ | ✗ | ✗ | **0/4** |
| baseline (after P1) | ✓ | **✗** | ✓ | ✓ | **3/4** |
| after P2a | ✓ | **✗** | ✓ | ✓ | **3/4** |
| after P2 | ✓ | **✓** | ✓ | ✓ | **4/4** |

P2a moved nothing alone — #2 fails at the *transition* step before ever
reaching the selection assertion — but with a transition present and
`selected` missing it still fails. **Necessary but not sufficient**; the two
prerequisites only carry #2 together.

### The pass criterion, and why the first one was wrong

**This is the part that took the work; it must survive.**

The fixture's first criterion was "the generator must not emit the known-wrong
assertion as `OBSERVED`". That is satisfied **before any prerequisite lands**:
with no transitions the state cursor goes `unknown` and grades the wrong
assertion `assumed`, which is not `observed`. It would have scored #2 as
passing before P2 existed, and we would have discovered that only after
building P2 and congratulating ourselves.

The general rule, recorded because it is not specific to this fixture:

> **A criterion that can be satisfied by knowing nothing is not a criterion.**

Refusing to assert anything is free, so any criterion phrased as an *absence*
("does not claim X", "emits no false positive") is passed perfectly by a system
that has not looked. This is [Finding 15](dms-findings.md)'s shape one level
up: there, an absence claim needed a completeness guarantee; here, a pass
criterion needs positive evidence.

So `caught` is **two positive halves**:

- **safety** — the wrong assertion must reach a *specific* grade, not merely
  "anything but observed". #1/#3/#4 must reach `contradicted`, which requires
  the state to be captured *and complete*. #2 cannot (nobody captured what
  `Next` does, so `assumed` is the honest grade) and therefore rests entirely
  on its capability half.
- **capability** — the *right* assertion must grade `observed`.

Two guards, because the halves fail to ignorance differently:
`expectedWrongGrade` stops safety being satisfiable by silence; the ignorance
check stops capability being. The latter runs on every invocation and fails the
run if an empty capture ever scores above 0/4.

### What a green score does not prove

The fixture runs against `tests/fixtures/generation/four-mistakes.html` — a
~60-node synthetic offline page with no icon glyphs, no async loading, no
session expiry, no 25-row tree, no truncation. Every one of those has broken an
assumption in the real app at least once. **4/4 means "the machinery is sound",
never "the DMS suite is covered."** Live spot-checks done separately: P2a's
selection capture against the real upload wizard, and the transition
cross-check against the real dashboard. Two spot-checks, not coverage.

---

## The exact next command to run

```powershell
pnpm.cmd eval:generation
```

Needs **no `.env`, no network and no session** — it is deterministic, offline
and free. Confirms the four-mistake fixture still scores 4/4 and that the
ignorance check still reports 0/4 before anything else is touched. Run it first
on a new machine: if it passes, P1/P2a/P2 are intact and the next work is
**P3, the generator** (`docs/phase-2-generation.md` — the matcher gate, the
prompt, `TestCaseProposal`, and `pnpm generate:review`).

To confirm the rest of the platform too:

```powershell
pnpm.cmd test --project=unit      # 46 tests, no browser, no network
pnpm.cmd eval:healing             # 7/7, needs ANTHROPIC_API_KEY
pnpm.cmd test --project=chromium  # 42/0/0/4, needs a session + the real app
```

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

**Resuming the generation work specifically:**

| To run | Needs |
| --- | --- |
| `pnpm eval:generation` (the four-mistake fixture) | **nothing** — offline, deterministic, no key, no session |
| `pnpm test --project=unit` | **nothing** |
| `pnpm inspect` against the real app (P2 captures) | `TEST_ENV`, `BASE_URL`, `APP_USERNAME`, `APP_PASSWORD` |
| `pnpm eval:healing`, `pnpm heal`, `pnpm rca`, and P3's generator | the above plus `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `LLM_MODEL_REASONING`, `LLM_MODEL_FAST` |

So a machine with no `.env` at all can still verify P1/P2a/P2 are intact —
that is deliberate, and the reason the fixture was built offline.

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
