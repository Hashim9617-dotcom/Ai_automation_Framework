# Phase 2, step 2 — self-healing selectors: design

**Status: implemented, including `pnpm heal` (the out-of-band pass over a
real `run.json`), gate unit tests, and a 7th eval scenario. The eval set
passes 7/7 against a real model** (`claude-sonnet-4-5`, confirmed live, cold
cache, $0.02/4575 tokens for the whole run). **Still not wired into the real
DmsSynergy suite** — `env.features.selfHealing` stays off. `pnpm heal` has
been verified against one real (synthetic, temporary) failure end to end,
including through `fixtures/index.ts`'s teardown wiring and the reporter,
not just against the eval harness's own bypass of that path — but no real
DmsSynergy failure has gone through it yet. See "Eval set results" for all
three eval runs and the plumbing bugs fixed along the way.

This design is written against what the shakedown actually produced, not
against a generic self-healing spec. Read `docs/dms-findings.md` before this
— every gate rule below cites the specific finding that motivated it, and
the retrospective (updated with empirically re-verified data, not left as
originally drafted) re-runs this design against that week's real failures.
"Eval set results" is the more important section of the two: the
retrospective only proves the design is *safe*; the eval set is what tests
whether it's *useful*.

---

## Core decision: v1 proposes, it never heals

The healer never substitutes a locator mid-run. When a locator exhausts every
candidate, the test **still fails** — exactly as it does today with no
healer installed. Separately, if the failure clears a gate (below), a
background pass may later produce a **proposal**: a candidate, verified
unique, with evidence, written to `run.json`. A human reviews it and,
if they approve, it is appended to the page object's candidate chain. Nothing
the healer does can change a test's outcome, this run or any run before a
human has acted.

**Why, concretely.** This week: 7 locators audited as "possibly broken" were
already correct (Finding 10). 4 of 6 things that looked like locator failures
were something else entirely — two were retracted "app bugs" that were our
own test code (Findings 5→9, 8→retracted), one was app instability we
misdiagnosed as a selector problem before finding the real cause (Finding 3),
one was a locator bug with a completely different mechanism than assumed
(Finding 11). A live healer, given any of those, does not fail loudly — it
finds *some* element that satisfies its own criteria, resolves, and the test
goes green. A wrong green is worse than a red: a red gets investigated; a
wrong green gets trusted. This document is designed to survive that failure
mode, not just to add a feature.

---

## The gate

Healing is only *considered* — not performed, considered — when every rule
below holds. Each rule cites what broke this week that it exists to prevent.

| # | Rule | Why |
|---|------|-----|
| 1 | Every candidate in the chain was exhausted (this is already true by construction — the gate only ever sees a `LocatorResolutionError`, which `SmartLocator.resolve()` only throws after the last candidate fails) | Not a new check, but worth stating: nothing here fires on candidate 0 failing if candidate 1 would have worked. That's what the chain is for. |
| 2 | The page is confirmed authenticated at the moment of failure | Finding 3: 27 failures were misdiagnosed as locator bugs before `SessionExpiredError` existed to catch this. A dead session makes *every* locator on the page unresolvable — healing one would be nonsense, and if the healer ever got this far it would be strong evidence the session-detection itself regressed. |
| 3 | The key has not resolved successfully earlier in the same test | If `users.form.submit` resolved fine at t=2s and fails at t=8s in the same test, the candidate isn't wrong — something about the *page's state* changed. That's Finding 7's whole distinction (never-present vs. present-then-unresolvable): healing only ever makes sense for the first kind. |
| 4 | A DOM snapshot was captured, and it is not truncated | `captureDomSnapshot()` caps at `maxElements` (`packages/execution-engine/src/dom/snapshot.ts:24`) and silently stops — the array reaching that cap proves nothing about whether the target element exists past the cut-off. Proposing a candidate, or *failing* to find one, from a truncated view is a coin flip dressed as evidence. |
| 5 | The failure is not explained by latency | A single failing candidate normally costs close to its own `candidateTimeout` on the way to throwing — `waitFor({ state: 'attached' })` polls to its deadline, it doesn't detect "this will never happen" early. So `durationMs` landing near the chain's own predicted `expectedBudgetMs` is the *ordinary* case, not evidence of anything. What this rule actually watches for is duration **exceeding** that predicted budget — latency the chain's own timeouts don't explain, e.g. a page still settling, or (Finding 5's real mechanism, see below) a candidate that was permanently wrong AND was compounding across repeated resolution attempts of the same broken key within one test, before the per-candidate timeout split existed to catch that shape. |

**On rule 5, the honest trade-off — and what it does NOT actually cost
today.** Duration alone cannot distinguish "genuinely absent" from "would
have matched with more time" — that is precisely what Finding 7 tried and
failed to solve with DOM-mutation quiescence, and it's why Finding 7 stayed
parked rather than shipped. This gate does not attempt to solve that either;
it resolves the ambiguity toward **not healing**. The natural example of the
cost this could impose is Finding 5/6 (the PUA-glyph `exact: true` bug) —
but **read the retrospective below before assuming that's a real false
negative**: in today's code, Finding 5/6 never reaches this rule, or this
gate, at all. `normalizeAccessibleName`'s automatic fallback (Finding 10,
already shipped, independent of anything in this design) resolves that bug
shape at the matching layer, before a `LocatorResolutionError` is ever
thrown. The honest cost rule 5 pays is real, but it is hypothetical — what
it would refuse if a Finding-5-shaped bug existed without Finding 10's fix
in front of it — not a demonstrated loss against this week's actual
history. See "Finding 5 / 6, re-verified against today's code" for the full
account, including the one real trade rule 5 does make.

**A failure that fails any rule is not silently dropped.** It's reported —
"not eligible for healing: `<rule>` — `<why>`" — as part of the run's output.
That reason list is itself the useful artifact for a while: it tells you
what fraction of failures even have a chance of being locator problems, which
is a number worth watching over time.

### A gap this gate exposes: failure telemetry doesn't carry what the gate needs

`SmartLocator.resolve()`'s final throw (`smart-locator.ts:196`) passes
`{ description, url }` into `LocatorResolutionError`'s `details`. It does
not carry `durationMs` or a per-candidate breakdown — because nothing needed
that before. Rule 5 needs it. This is a small, precise addition: the
`durationMs = Date.now() - startedAt` already computed on the success path
just needs to also be attached on the throw path. No behavior changes.

Rule 3 needs the test's `locatorTelemetry` (already collected by the
`locatorTelemetry` fixture, `fixtures/index.ts:32`) cross-referenced against
the failing key. That fixture and the `diagnostics` fixture (where the DOM
snapshot is captured, `fixtures/index.ts:63`) currently don't share data —
they need to, so gate evaluation has both in one place at teardown.

---

## Where healing runs: teardown gate, out-of-band proposal — not `onHealRequested`

The existing socket — `SmartLocatorOptions.onHealRequested` (declared
`smart-locator.ts:43`, called from inside `resolve()` at line ~176 when every
candidate has failed, and stubbed for wiring at `fixtures/index.ts:59`) — is
built for exactly the thing this design forbids: it's called *inside* the
resolution path, and whatever it returns is immediately `waitFor`'d and
handed back as *this test's* live locator. That is live healing by
construction, independent of what the healer itself does internally. **This
socket is not used by v1** and should be removed rather than left dormant —
dead code that does the one thing this whole design exists to prevent is a
liability, not a convenience for later.

Healing moves to two places instead, mirroring how RCA is already split
between "capture while the page is alive" and "analyze later, out of band"
(`docs/phase-2-plan.md`, steps 1–2):

**1. Teardown (page still alive, zero LLM calls).** In the same `diagnostics`
fixture teardown that already captures the DOM snapshot on failure
(`fixtures/index.ts:120-133`), when the failure is a `LocatorResolutionError`:
evaluate the gate (pure logic — no network, no LLM) and attach the verdict.
If eligible, *also* capture a richer artifact than the standard 150-element
snapshot: a full CDP accessibility-tree dump of the page (`Accessibility.getFullAXTree`),
the same technique used by hand for Findings 10 and 11 this week. This is the
one piece of context an LLM proposal genuinely needs that the lightweight
snapshot doesn't carry — real computed accessible names, not the heuristic
`accessibleName()` approximation in `captureDomSnapshot`. Bounded cost: this
extra capture only happens for failures that already passed every free,
LLM-free gate check, which the shakedown suggests is a small minority.

**2. Out-of-band pass (`pnpm heal`, mirrors `pnpm rca`).** Reads
`run.json` after the run completes. For each eligible failure — deduped, see
below — calls the LLM once with the rich context to propose one candidate,
verifies it deterministically (no LLM) against the captured accessibility
tree, and writes a `HealingProposal` into `run.json` if verification passes.
Nothing here runs while a test is executing. A slow or rate-limited LLM
provider cannot make the suite slower, exactly the guarantee RCA already
gives.

---

## The proposal record

```ts
interface HealingProposal {
  id: string;
  runId: string;
  testId: string;              // TestResult.id that surfaced this
  key: string;                 // LocatorSpec.key, e.g. "users.form.submit"
  description: string;         // LocatorSpec.description
  existingCandidates: LocatorCandidate[]; // the chain as it stood — for the reviewer's diff

  candidate: LocatorCandidate; // in the EXACT LocatorSpec candidate format — nothing bespoke

  verification: {
    matchCount: number;        // MUST be 1 — see below
    role: string;
    accessibleName: string;
    visible: boolean;
    enabled: boolean;
    verifiedAgainst: 'ax-tree-snapshot';  // states plainly this is not a live browser check
    verifiedAt: string;
  };

  rationale: string;           // plain language, one or two sentences
  confidence: number;          // 0..1

  provenance: {
    source: 'healed';
    runId: string;
    generatedAt: string;
    model: string;             // "provider/model", same shape RCA already uses
  };

  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
}
```

`Run` (`packages/shared/src/types/run.ts`) gains one field:
`healingProposals: HealingProposal[]`. Same pattern RCA uses for
`TestResult.error.rca` — attached data, not a new persistence layer, so it
round-trips through the same `run.json` read/write `pnpm rca` already does.

**A proposal is always appended, never substituted.** `existingCandidates`
stays untouched; `candidate` is added as a new, lowest-priority entry at the
end of the chain. Locators are ordered data — Finding 5's fix pattern
(demote the broken exact-match, promote a working fallback) depended on that
ordering meaning something, and healing must respect it, not fight it.

---

## The verification step

Before a proposal is written — not before approval, before it's written at
all — the candidate is checked:

1. **Uniqueness.** Match the candidate's role + name against the captured
   accessibility-tree snapshot. `matchCount` must be exactly `1`. Both real
   bugs this week that came from a non-unique match (`option()`'s unscoped
   `.first()` hypothesis for Finding 8, and the `.first()` pattern audited
   across the codebase in general) make this non-negotiable — 0 or 2+
   matches means the proposal is **discarded**, not written with a caveat.
2. **State.** Pull the matched node's role, accessible name, visibility and
   enabled state straight from the snapshot and attach them — this is what
   the human reviewer actually reads, not the raw candidate syntax.
3. **Format.** The candidate must be a valid `LocatorCandidate` — same
   `role`/`css`/`text`/etc. strategies already in use, nothing new invented
   per-proposal.

**The honest limitation: this verifies against a snapshot, not a live
page.** By the time the out-of-band pass runs, the browser from the failing
test is gone. Two ways to get a "live" check instead were considered and
rejected:

- Re-open a fresh page at the same URL and query it live. Rejected: most of
  what's targeted here are *transient* states — an open dialog, an open
  context menu, a specific wizard step (exactly what Findings 8, 11 and 14
  are about) — and a fresh navigation reproduces none of that. A "verified"
  result from a bare page load would be verifying the wrong thing.
- Skip verification and let the LLM's claim stand. Rejected outright — this
  is the one step in the whole design where a wrong answer is expensive, and
  it's also the cheapest one to actually check.

So: the snapshot check is real, and it does filter out non-unique or absent
candidates before a human ever sees them — but it cannot promise that what
was unique in a static accessibility-tree dump is still unique, or still
there, in a live browser at review time. `pnpm heal:review` (below) makes the
live check one copy-pasted line, not a research project, and the review flow
treats "snapshot said unique" as a pre-filter, not a certificate.

---

## Cost controls — reuse, don't rebuild

- **LLM gateway**: same `LlmGateway`, same `BudgetGuard`, same disk/memory
  cache, same mock-gateway fallback with no API key (`gateway/factory.ts`) —
  identical to how `LlmRootCauseAnalyzer` is wired. No second budget
  tracker: `pnpm heal` and `pnpm rca`, if run in the same process or CLI
  invocation, must share one `BudgetGuard` instance, or the effective spend
  cap silently doubles. If they run as separate processes, this is
  unavoidable without a shared external tracker — worth flagging in the
  README as "the cap is per-process, not per-run," not silently assuming
  otherwise.
- **Fingerprint + dedup, adapted from `rca/analyzer.ts`'s `fingerprint()`**:
  one heal proposal per distinct `(key, spec.description)` per run — *not*
  per error text. This has to differ from RCA's fingerprint: a
  `LocatorResolutionError`'s message is nearly identical every time for the
  same key regardless of cause ("Could not resolve locator X after N
  candidates"), so hashing the error text the way RCA does would over-merge
  unrelated failures. Multiple tests failing on `nav.fileExplorer` in one
  run produce exactly one proposal, reused across all of them — same
  cross-test collapsing RCA already does for cross-browser duplicates.
- **`HEAL_MAX_PROPOSALS` env var**, same shape as `RCA_MAX_FAILURES` — a
  hard cap on distinct LLM calls per run.
- **Cache key**: `fingerprint(key, description) : hash(ax-tree-snapshot)` —
  changing the app's DOM invalidates the cache the way RCA's payload hash
  invalidates on a changed error; an identical failure on an identical page
  state is one cached call forever.

---

## The approval flow: `pnpm heal:review`

```
pnpm heal:review                     # reviews artifacts/reports/run.json
pnpm heal:review --run <path>
```

Reads `run.json`, walks every `status: 'pending'` proposal:

```
[2/5] users.form.groups                                    confidence 0.82
  Key resolved via: users.page.ts (2 existing candidates)
  Test:   "the group picker stays disabled until a role is chosen"
  Rationale:
    The current candidates target a labelled control, but this element's
    accessible name is empty (no aria-label, no label-from-content on a
    combobox role). Matched instead on visible text via CSS, scoped to
    [role="combobox"] so it can't match a different element containing the
    same phrase.

  Suggested candidate (appended, not replacing anything):
    { strategy: 'css', value: '[role="combobox"]:has-text("Select a role first")' }

  Verified against captured accessibility snapshot:
    matches: 1   role: combobox   name: ""   visible: true   enabled: true

  Check it yourself before approving:
    page.locator('[role="combobox"]:has-text("Select a role first")')

  [a]pprove  [r]eject  [s]kip  [d]iff existing chain  [q]uit
```

**On approve:**

1. Resolve `key` → source file. Not a new field on `LocatorSpec` (that would
   touch every `locator()` call site for a review-time convenience) — grep
   `tests/**/pages/**/*.ts` for the literal key string (`'users.form.groups'`
   already appears exactly once, as the first argument to `locator(...)`, by
   the existing naming convention). Zero or multiple matches: **stop, ask
   the human for the path** — never guess.
2. Insert the candidate into that spec's `candidates: [...]` array via an
   AST-based edit (ts-morph or the TypeScript compiler API — not string
   splicing; a candidate array is a real object literal and regex edits on
   TypeScript source are exactly the kind of fragile shortcut this project
   has spent a week arguing against taking).
3. Run `tsc --noEmit` and `eslint --fix` on the touched file. **If typecheck
   fails, roll back the edit and mark the proposal `status: 'approved'` but
   `appliedError: '<message>'`** — never leave a page object in a broken
   state because an automated insert went wrong.
4. Write the updated candidate list back to the source file, and write
   `status: 'approved'`, `reviewedBy`, `reviewedAt` back into `run.json`
   (same read-mutate-write pattern `pnpm rca` already uses).

**On reject:** only `run.json` changes (`status: 'rejected'`) — nothing
touches the page object. A rejected proposal for the same `(key,
description)` is not re-proposed from cache on a later run — the cache key
change (rule: bump it) is a future refinement, not solved here.

`--auto-approve-confidence <n>` is deliberately **not** in this design.
Auto-approval is live healing with extra steps once the threshold is set low
enough by habit — the whole point of a human in the loop is that a person
looks at the evidence, not that a number does.

---

## Revised interfaces

**Current** (`packages/shared/src/types/ai.ts:83-89`) — returns something
for immediate use, which assumes live healing by its very shape:

```ts
export interface SelfHealingEngine {
  heal(input: { spec: LocatorSpec; snapshot: DomSnapshot }):
    Promise<{ candidate: LocatorSpec['candidates'][number]; rationale: string } | null>;
}
```

**Proposed** — split into the two things that actually happen at two
different times, neither of which returns anything a test could act on:

```ts
export interface HealingEligibility {
  eligible: boolean;
  /** Always populated, pass or fail — this list is itself the useful output. */
  reasons: string[];
}

export interface HealingProposal { /* see above */ }

export interface SelfHealingEngine {
  /**
   * Pure, synchronous, zero I/O. Safe to call from live test teardown —
   * it never touches the network and never blocks the run.
   */
  checkEligibility(input: {
    spec: LocatorSpec;
    error: LocatorResolutionError;
    telemetry: LocatorResolution[];
    snapshot: DomSnapshot;
    pageUrl: string;
  }): HealingEligibility;

  /**
   * LLM call + deterministic verification. Out-of-band only — never called
   * while a test is executing. Returns a fully-verified proposal or null;
   * null is the common case (rule 5 alone should reject most inputs from a
   * dataset like this week's).
   */
  propose(input: {
    spec: LocatorSpec;
    axSnapshot: AccessibilityTreeSnapshot; // the rich, teardown-captured artifact
    runId: string;
    testId: string;
  }): Promise<HealingProposal | null>;
}
```

### Other seams that assumed the live model

- **`SmartLocatorOptions.onHealRequested`** (`smart-locator.ts:43`) and its
  call site inside `resolve()` (~line 176–194): removed. `resolve()` goes
  back to doing exactly what it does today with no healer configured — walk
  the chain, throw. The commented-out wiring line in `fixtures/index.ts:59`
  is removed, not filled in.
- **`PendingSelfHealingEngine.heal()`** (`packages/ai-engine/src/phase2/pending.ts:33-38`)
  returns `null` "to make `SmartLocator` fall through to a normal failure" —
  that comment is the tell. Replaced by a `PendingSelfHealingEngine` whose
  `checkEligibility()` always returns `{ eligible: false, reasons: ['not implemented yet'] }`
  and whose `propose()` throws `NotImplementedYetError`, consistent with the
  other two pending engines in that file.
- **`DomSnapshot`** (`packages/shared/src/types/ai.ts:52-67`) has no
  `truncated` field — rule 4 needs one. Add
  `truncated: boolean` (`elements.length >= maxElements`, computed once
  inside `captureDomSnapshot`, `dom/snapshot.ts:129-136`) rather than
  requiring every caller to independently recompute it.
- **`LocatorResolutionError`**'s `details` (`smart-locator.ts:196`) — needs
  `durationMs`, per the gap noted under the gate.
- **`LocatorEvent`** (`infra/prisma/schema.prisma:68-81`) already models
  resolution history generically (`healed: Boolean`) but has no concept of a
  *pending, unapplied* proposal — it's shaped for "this is what happened,"
  not "this is what we're suggesting." A `HealingProposal` Prisma model
  (mirroring `GeneratedTestCase`'s `approved: Boolean` pattern) is the right
  future home once the DB is activated; v1 stays on `run.json`, matching how
  the API's run repository is still in-memory (`schema.prisma`'s own header
  comment).

---

## What could go wrong

1. **The latency gate (rule 5) could produce a false negative** — restated
   here because it's the design's most-discussed trade-off, not because
   this week's evidence shows it happening: a genuinely-broken,
   genuinely-fixable locator whose failure exceeds the chain's predicted
   budget gets refused, not proposed. This was originally illustrated with
   Finding 5/6, which was wrong — see the retrospective's correction. In
   today's code Finding 5/6 never reaches this rule at all
   (`normalizeAccessibleName` resolves it upstream), so the actual cost paid
   this week is zero, not "one real bug missed." The trade-off is still
   accepted, deliberately, for the hypothetical case it does apply to — just
   not demonstrated by anything in this document's own evidence.
2. **Snapshot verification isn't live-browser verification.** A proposal
   that shows `matches: 1` against the captured accessibility tree could
   still turn out non-unique, or gone, by the time a human reviews it
   against the real app. `pnpm heal:review` hands the reviewer a copy-paste
   check specifically so this gap has a two-second answer, not a trust-fall.
3. **Scope gap: raw locators are invisible to this whole pipeline.** Only
   `LocatorSpec`s resolved through `SmartLocator` ever reach the gate. Many
   page objects use plain `page.getByRole(...)` directly — Finding 10's own
   audit found 39 `exact: true` occurrences, and Finding 11's tree-row bug
   (`file-explorer.page.ts`'s `treeNode()`) was exactly one of these. This
   design does nothing for them, not because the gate rejects them, but
   because they never arrive. Converting a fragile raw locator into a
   `LocatorSpec` is what makes it heal-eligible — worth doing opportunistically
   as fragile ones are found, not a blocker for shipping this.
4. **Grep-by-key file resolution can fail.** A key string appearing in a
   comment, or constructed dynamically rather than as a literal, breaks the
   "exactly one match" assumption. Fails loud, asks the human — never
   guesses which file to edit.
5. **AST-based source edits can still go wrong in ways typecheck won't
   catch** — e.g. inserting a syntactically valid but semantically odd
   candidate ordering. The typecheck/lint gate in the approval flow catches
   syntax and type errors, not "this candidate is weird"; that judgment
   stays with the human reviewer, which is the entire premise of "propose,
   don't heal."
6. **Unbounded chain growth.** Proposals only ever append, never replace or
   prune — so a spec that gets healed repeatedly as an app evolves
   accumulates dead candidates the app no longer produces. `LocatorEvent`
   telemetry (which candidate index actually resolves, over time) is the
   right signal for a future "this candidate hasn't won in N runs, consider
   removing" cleanup pass. Not solved in v1.
7. **Two independent `BudgetGuard`s if `heal` and `rca` run separately.**
   Noted under cost controls — flag in docs, don't silently assume a shared
   cap across processes.
8. **A confident-sounding rationale is still just a rationale.** The
   proposal record's `confidence` score is the model's self-report, not a
   calibrated probability — treat it as a sort order for the review queue,
   never as a threshold for skipping review (which is exactly why
   auto-approve isn't in this design).

---

## Retrospective: would this design have healed anything it shouldn't have?

This is the actual test of the design. Every locator-shaped failure from
this week's shakedown, run against the gate:

| Failure | Reaches the gate at all? | Gate verdict | Correct? |
|---|---|---|---|
| **Finding 5 / 6** — see the re-verified row below. Superseded by empirical re-testing, not left as originally written — the "refused, false negative" conclusion first drafted here turned out to be wrong once actually run. | — | — | — |
| **Finding 11** — `treeNode()`'s `getByRole('treeitem', { name, exact: true })` never matching because the real name concatenates the row's nested "Expand"/"More options" button labels | **No — never reaches the gate.** `treeNode()` is a raw `page.getByRole()` call in `file-explorer.page.ts`, not a `LocatorSpec` resolved through `SmartLocator`. The failure surfaced as `expect(locator).toBeVisible()` timing out, not a `LocatorResolutionError`. | N/A — out of scope by architecture, not by gate logic. | Correct outcome (no bad heal proposed), for the reason called out in "what could go wrong" #3: this is exactly the scope gap, demonstrated live. |
| **Finding 12, item 3** — intermittent `LocatorResolutionError` on `nav.fileExplorer` / `nav.upload`, single candidate, recovers on the framework's own whole-test retry | Yes | **Refused — rule 5.** The candidate is the *primary* (only) one, so it gets the full `candidateTimeout` (2s) before throwing — right at the "did this take the whole budget" line. | **Correct refusal, and this time also the correct underlying call**: the locator itself was never wrong (confirmed — three clean full-suite runs afterward with zero code change to it). Healing here would have proposed a fix for something that wasn't broken. |
| **Finding 8** (retracted) / **Finding 14** — upload wizard: `goNext()` timing out clicking a `Next` button that resolved fine but was legitimately disabled; folder-step selection behaving inconsistently | **No — not a resolution failure at all.** The locator finds the button; Playwright's own actionability wait times out because the element is disabled. No `LocatorResolutionError`, nothing for the gate to ever see. | N/A | Correct — no candidate, however well-chosen, could fix "the button is correctly disabled and the test's model of the flow was wrong" or "the app's folder-selection state is inconsistent." Proposing a new locator is structurally the wrong tool for either. |
| **Finding 9** (retracted) — `toBeDisabled()` assertions against buttons that were never disabled by this app's design | **No — not a resolution failure.** The button resolves fine; the assertion about its state was wrong. | N/A | Correct — same reasoning as above. |

### Finding 5 / 6, re-verified against today's code, not asserted

The first draft of this table called Finding 5/6 "refused — false negative,"
reasoning from the historical 8-second timeout. Told to verify that
empirically against current behavior rather than assume it, because the
per-candidate timeout split (rule 5 depends on it) shipped *after* Finding
5/6 were fixed by hand. Two things needed checking, and both were run live
against `dmsuiv3.aitalkx.com`, not reasoned about in the abstract:

**1. Does the original bug even still fail?** Temporarily stripped
`UsersPage.submit` back to exactly its original single, impossible
`exact: true` candidate (removing the hand-written `\b`-regex fallback) and
ran the form-validation test. **It passed — no failure at all, 5.3s.**
Finding 10's automatic `normalizeAccessibleName` fallback inside
`SmartLocator`'s `build()` (`smart-locator.ts`) already resolves this exact
bug shape at the matching layer, independent of the healer. This class of
failure no longer reaches a `LocatorResolutionError`, so it no longer
reaches the gate either — not because the gate refuses it, but because
there's nothing left to refuse.

**2. If Finding 10's fix didn't exist, would the per-candidate timeout fix
alone change the *timing* verdict?** Isolated the question by additionally
disabling the `normalizeAccessibleName` fallback (one line,
`smart-locator.ts`), keeping only the original impossible candidate. **It
failed in ~2000ms** — matching today's `candidateTimeout` default exactly,
not the historical ~8000ms. Both changes were reverted immediately after
(`git checkout --`); nothing here shipped as a real behavior change, it was
a measurement.

| Failure | Reaches the gate at all? | Gate verdict | Correct? |
|---|---|---|---|
| **Finding 5 / 6, as they'd behave with only the timeout fix (no Finding 10)** | Yes | **Eligible — rule 5 passes.** `durationMs` (~2000ms) lands at, not beyond, the chain's own `expectedBudgetMs` (2000ms) — the ordinary exhaustion window rule 5 is designed to let through, not the "took longer than the chain's own timeouts predict" signature it exists to catch. | This is the retrospective's first genuine **true positive** — not from a synthetic mutation, from real history. A healer given the real accessibility tree (confirmed elsewhere this session via CDP: computed name is `" Create User"`, PUA glyph U+EB62 prefix) has exactly the evidence needed to propose a correct `role: button, name: "Create User"` candidate. |
| **Finding 5 / 6, as they actually exist in today's code** | No — Finding 10's fix already resolves it before any `LocatorResolutionError` is thrown | N/A — nothing to heal | Also correct: the bug is fixed at a more fundamental layer (normalizing the match itself) than a per-instance healed candidate would be. Healing was never going to be needed here once Finding 10 shipped. |

The original "honest false negative" framing was wrong on the facts, not
just imprecise — worth stating plainly rather than quietly rewriting
history. Corrected: rule 5's slack margin (`LATENCY_SLACK = 1.25` in
`packages/shared/src/healing/gate.ts`) is compared against the chain's own
predicted budget, not a fixed "small" constant, specifically because a
single candidate normally costs close to its *own* full timeout on
failure — that number was always expected to land near the budget, not
near zero. The false-negative concern from the first draft doesn't apply to
that design as actually built; it would have applied to a cruder "was
`durationMs` small" version that was never implemented.

**Summary, updated: zero of this week's real failures would have produced a
wrong heal proposal, and Finding 5/6 — read correctly — is this design's
best available true positive from real history, not a false negative.**
Finding 12 stays a correct refusal. Findings 8, 9, 11, 14 stay out of scope
by architecture, not gate logic. See "Eval set results" below for the
controlled, six-scenario version of this same question — the actual bar the
design is judged against, not the retrospective against one week's history.

---

## Eval set results

`pnpm eval:healing` (`scripts/eval-healing.ts`) — six controlled mutations
against the bundled demo app, offline and deterministic except for the LLM
call itself. Four true positives (a–d), two true negatives (e, f).

**First run: no API key configured, a–d correctly reported BLOCKED rather
than run against the mock and presented as a result** (see the git history
of this section for that run's table — preserved in spirit below, not
deleted, since "untested" is a real, distinct outcome from "passed").
**Second run, after a real `ANTHROPIC_API_KEY` was configured** (with two
bugs fixed along the way — see below) **and the model IDs confirmed live
against the API (`claude-sonnet-4-5`, `claude-haiku-4-5`, both HTTP 200,
not guessed from memory): 6/6, real model, real verification.**

| Scenario | Gate | Proposal | Result |
|---|---|---|---|
| (a) `data-testid` renamed | eligible | `role:button, name:"Login", exact:true` — confidence 0.95, verified matchCount=1 | **PASS** |
| (b) button label reworded | eligible | `role:button, name:"Sign In", exact:true` — confidence 0.95, verified matchCount=1 | **PASS** |
| (c) role changed, button → link | eligible | `role:link, name:"Login", exact:true` — confidence 0.85, verified matchCount=1 | **PASS** |
| (d) element moved to a new container | eligible | `role:button, name:"Save employee", exact:true` — confidence 0.98, verified matchCount=1 | **PASS** |
| (e) element genuinely deleted [negative] | eligible | refused (null) — `"Healer found nothing safe to propose"`, a real model decision this time, not a mock-parse artifact | **PASS** |
| (f) present but slow to render [negative] | eligible | refused (null), **before any LLM call** | **PASS** |

**All four positives got the semantically correct answer, not just *a*
answer** — (b)'s renamed label, (c)'s changed role, and (d)'s moved
container all produced the specific fix each mutation actually called for,
not a generic fallback. Confidence tracked plausibility sensibly too: (c)
scored lowest (0.85) — role changed to something not directly evidenced by
the description, the least certain inference of the four.

**(f) is still the strongest result, and remains independent of model
quality.** `propose()`'s pre-check — implemented specifically because this
scenario surfaced the need for it — re-checks each of the locator's
*existing* candidates against the freshly captured accessibility snapshot
before ever calling a model. In this scenario the button is injected 2.5s
after page load; the first resolution attempt genuinely fails at the 2s
`candidateTimeout` mark, exactly like a real "not yet rendered" case — but
by the time the (simulated) teardown gap elapses and the rich snapshot is
captured, the button has appeared, and the original
`role: button, name: "Login"` candidate matches it uniquely. `propose()`
recognizes the chain would actually resolve now and refuses — logged as
`"Not proposing — an existing candidate already resolves uniquely"` —
without spending a single token, this run or any run.

**(e) is now a genuine result, not the weak pass it was under the mock.**
With no existing candidate matching (the element is truly gone), `propose()`
called the real model, which correctly reasoned that nothing in the given
tree plausibly matches "Log out" and declined
(`"Healer found nothing safe to propose"`) — a real judgment call, not a
schema-validation accident.

### Third run — seven scenarios, including the icon-swap case, real cost measured

A seventh scenario was added: **(g) icon swapped, PUA glyph changes** —
simulating the actual DmsSynergy bug shape (Findings 5/6/10) via
`aria-label="<PUA glyph> Login"` on the demo app's submit button. This one
is structurally different from (a)–(f): the correct behavior is
`SmartLocator.resolve()` **succeeding outright**, via
`normalizeAccessibleName`'s automatic fallback — the gate and healer should
never be reached at all. That is "propose nothing" in its strongest form,
so the eval harness gained an `expectResolutionSuccess` flag rather than
forcing this case through the same "expects an initial failure" path as
everything else.

Run twice: once against a disk cache warmed by earlier scenario (a)–(e)
runs (reporting 0 real calls, all 5 served from cache — honest, but not
what "the real cost of the run" means), then again with the cache cleared
for a genuine cold measurement.

| Scenario | Result |
|---|---|
| (a)–(f) | Same as the six-scenario run above — all still PASS, (c)'s proposal came back at confidence 0.95 this time rather than 0.85 (same correct `role:link, name:"Login"` answer both times; temperature 0 is not byte-identical across separate API calls, which is expected and not a concern) |
| (g) icon swap | Locator **resolved successfully** — `"resolution succeeded — normalizeAccessibleName handled the PUA glyph automatically; the gate/healer were never reached"`. **PASS** |

**7/7, cold cache. Real cost: 5 LLM calls (a–e; f and g needed none), 4029
prompt + 546 completion tokens = 4575 tokens total, $0.0203.** No rule was
loosened to get here — every gate and verification path is identical to the
six-scenario run.

### Two real bugs found getting a real model wired up — neither was in the healer itself

1. **`createLlmGateway()` never actually loads `.env`.** It reads
   `process.env` directly; nothing calls `loadEnvironment()` (or its
   internal `ensureDotenv()`) first unless something else in the same
   process already has. `scripts/analyze-failures.ts` (`pnpm rca`) had this
   exact gap already, unnoticed — its own comment says "Set
   `ANTHROPIC_API_KEY` in .env and run `pnpm rca` again," which never
   actually worked, because nothing in that script ever read `.env` in the
   first place. Fixed in both `scripts/eval-healing.ts` and
   `scripts/analyze-failures.ts` by calling `loadEnvironment()` before
   `createLlmGateway()`. Also added a confirmation log
   (`"Using the real LLM gateway"`, provider + both model IDs) to
   `packages/ai-engine/src/gateway/factory.ts` on the success path — before
   this, only the mock-fallback path logged anything, so "which gateway is
   actually in use" required inferring it from the *absence* of a warning.
2. **The `/login` gate bug** — see above, found by the same run that first
   surfaced (f)'s pre-check need.

Neither bug was in `checkHealingEligibility`, `propose()`, or the
verification logic — the core healing pipeline's design held up once it
could actually reach a real model. Both were plumbing: a config-loading gap
shared with an already-shipped command, and a gate rule that needed the
eval's specific pressure to expose.

**A real design bug, found by the eval, not asserted around.** The first
run of this harness failed (a)–(d) *and* (e) with `not eligible: page is on
/login` — rule 2, as first written, disqualified any failure whose
`pageUrl` contained `/login`, intended to catch a session-expiry redirect
(Finding 3). It instead caught every locator that legitimately targets an
element *on* a login page — which describes a login page's own tests by
definition, in this app and in DmsSynergy's (`tests/app/pages/login.page.ts`
also extends `BasePage`, not `AppPage`, for exactly this reason: there is no
session to have expired yet). Fixed by removing the URL check entirely —
the real guarantee is architectural, not a pattern match: `SessionExpiredError`
and `LocatorResolutionError` are different classes, and `AppPage.find()`
throws the former before `SmartLocator.resolve()` is ever entered, so a
session-expiry failure structurally never reaches `checkEligibility` on an
`AppPage`-based page in the first place. Full reasoning is now the comment
on rule 2 in `packages/shared/src/healing/gate.ts`. This is the kind of bug
a synthetic mutation eval exists to catch before it reaches the real
suite — this one would have quietly disqualified every locator failure on
DmsSynergy's own login page from ever being considered.

### The review CLI, verified mechanically

`pnpm heal:review`'s safety mechanics were exercised directly against a
synthetic proposal targeting a real key (`login.error` in
`tests/demo/pages/login.page.ts`), not just read for plausibility:

- **Refuses a dirty target file.** With an uncommitted change present on
  the target file, the CLI detected it via `git status --porcelain` and
  refused before ever showing a diff or asking for approval.
- **Diff preview, confirmation, insertion, typecheck-gated apply.** Against
  a clean file: showed the evidence, printed the exact insertion, asked for
  explicit `[a]pprove`, and only then wrote it.
- **Found and fixed a real cross-platform bug in the process**:
  `execFileSync('npx', ['tsc', ...])` fails with `ENOENT` on Windows (`npx`
  is a `.cmd` shim; `execFileSync` doesn't resolve those without
  `shell: true`) — which the CLI's own error handling correctly treated as
  "typecheck failed, roll back," the safe default, but for the wrong
  reason. Fixed by running TypeScript's compiler API in-process instead of
  shelling out at all — no shell-resolution question left to get wrong on
  any OS. A `prettier`-formatting pass (also in-process, same reasoning)
  runs after a successful apply, matching the design's item 3.
- **Reverted after testing** — the synthetic insertion was never a real
  proposal; `git checkout --` restored the file before this session ended.

---

## What's actually left before this touches the real suite

1. ~~A real `ANTHROPIC_API_KEY`~~ — **done.** 7/7 eval scenarios pass
   against a real model (`claude-sonnet-4-5`), cold cache, $0.02 for the
   whole run. The eval set's positive scenarios (a–d) and the icon-swap
   negative (g) are all synthetic demo-app mutations, though — they say the
   pipeline works, not that it will produce equally good proposals against
   DmsSynergy's actual component library, which has its own quirks (the
   tree-row name-concatenation pattern, Findings 11/14) the demo app
   doesn't reproduce.
2. ~~`pnpm heal` (the out-of-band pass)~~ — **done**, and verified against a
   real (temporary, synthetic) failure through the full stack — real test,
   real teardown, real reporter, real `run.json`, real proposal — not just
   the eval harness's own bypass of `fixtures/index.ts`.
3. `env.features.selfHealing` stays `false` for DmsSynergy. The eval
   passing is necessary, not sufficient — still want at least one real
   DmsSynergy failure to clear the gate, get a real proposal, and go
   through `pnpm heal:review` end to end before turning this on for real.
4. The teardown wiring (`fixtures/index.ts`) captures the rich accessibility
   snapshot only for gate-eligible failures today — worth watching its
   actual hit rate on a real run before assuming the cost is as bounded in
   practice as it is in theory.
5. ~~`pnpm rca`'s dotenv-loading bug... hasn't been re-verified~~ — the
   identical fix (`loadEnvironment()` before `createLlmGateway()`) was
   verified working in `pnpm heal` and `pnpm eval:healing` this session,
   which gives real confidence the same one-line fix works in
   `scripts/analyze-failures.ts` too — but `pnpm rca` itself, for its own
   purpose against a real run, still hasn't been run this session. Low risk,
   not zero.
