# Phase 2, step 3 — test-case generation: design

**Status: design only. No implementation code exists yet, deliberately.**

Scope of step 3, held hard: a plain-language command plus a real page capture
produces structured `TestCase` records. Nothing executes. Nothing is written
into `tests/`. Turning a `TestCase` into an executable spec is step 4, and the
seam between them is the `TestCase` type that already exists
(`packages/shared/src/types/test-case.ts`).

---

## The central problem: there is no oracle

Self-healing (step 2) got away with a great deal because it had a mechanical
oracle. A proposed locator either resolves to exactly one node in the captured
accessibility tree or it does not. `matchAxNodes()` answers that in
microseconds, for free, deterministically, and the answer is not a matter of
opinion. The model proposes; deterministic code judges. That asymmetry is the
entire safety story of step 2.

Generation has no equivalent. "Does this test assert the right contract?" is
not mechanically decidable. A generated case that asserts the wrong contract
looks exactly like one that asserts the right one — same shape, same
plausibility, same confident tone. And if a wrong case happens to pass, it
becomes a permanent lie in the suite: a green test asserting something the app
does not actually guarantee. That is strictly worse than a red one. A red test
gets investigated. A green test gets trusted, and then gets cited as evidence
the behaviour is covered.

We know the failure mode is real and not hypothetical, because **we made it
four times by hand**, with human judgment and the app open in front of us:

| # | What we asserted | What the app actually does | Where |
| --- | --- | --- | --- |
| 1 | Create buttons stay `disabled` until required fields are filled | Validates on click: no network call, dialog stays open, inline per-field errors | Finding 9 |
| 2 | Choosing a workspace selects it; you then click `Next` | Choosing a workspace **auto-advances** to the Folder step | Finding 8 |
| 3 | Selecting all results puts a `Download File` action on every row | One consolidated `Download Selected (N)` button appears | `global-search.spec.ts` |
| 4 | A tree row's name is its visible label (`treeitem` name `ABCD`) | Real computed name is `Collapse ABCD More options` | Finding 11 |

Every one is the same error: **encoding what we assumed the app should do
instead of what it does.** Three are assertion errors, one (#4) is a locator
error, and that distinction matters below. A model will make this class of
mistake faster, more fluently, and at scale, because a plausible-sounding DMS
contract is exactly what a language model is best at producing.

So the design question is not "how do we make the model correct." It is:

> **How does a generated case stay tethered to observed behaviour, and how do
> we make the untethered parts impossible to mistake for tethered ones?**

---

## The core move: verify provenance, not truth

We cannot mechanically check whether an assertion is *true*. We can
mechanically check whether it is *grounded* — whether every element and state
it refers to can be traced to a specific node in a specific capture.

That is the same architectural shape as healing, pointed at a different
question:

| | Healing (step 2) | Generation (step 3) |
| --- | --- | --- |
| Model produces | a candidate locator | a draft test case |
| Deterministic judge | `matchAxNodes` — resolves to exactly 1 node? | `checkGrounding` — every referenced node present in capture? |
| What the judge proves | the locator is unambiguous | the case is not invented |
| What the judge cannot prove | that it's the *right* element | that the contract is *correct* |
| Residual risk handled by | human approval in `heal:review` | human approval in `generate:review`, per assertion |

Provenance is not truth. A grounded assertion can still be wrong. But every one
of our four by-hand mistakes was, at root, an **ungrounded** claim asserted as
though it were grounded — and ungroundedness *is* mechanically detectable. That
is the leverage this design has, and it is the only leverage available.

**The model's own label is never trusted.** The model is asked to tag each
assertion `observed` or `assumed`, but that tag is treated as a *claim to be
checked*, not as an answer. `checkGrounding()` re-derives the tag from the
capture independently and overrides the model. A model that labels an invented
assertion `observed` gains nothing by lying. This mirrors healing exactly: the
model's `confidence` field is advisory; `verification.matchCount` is
authoritative.

---

## Three grades, not two — the argument for `CONTRADICTED`

Your starting position proposed two grades, OBSERVED and ASSUMED. I'd argue for
three, and the third is where most of the safety actually comes from.

- **`OBSERVED`** — every element and state the assertion refers to is present
  in the capture, with matching role, name and state.
- **`ASSUMED`** — the capture is *silent*. It neither supports nor refutes the
  claim (typically: the state was never captured).
- **`CONTRADICTED`** — the capture positively *disagrees*. The assertion says
  disabled; the captured node says `enabled: true`.

Why the split matters: **Finding 9 is a `CONTRADICTED`, not an `ASSUMED`.** If
the capture includes the open create-role dialog, it contains a node
`{ role: 'button', name: 'Create', enabled: true }`. An assertion of
`toBeDisabled` against that node is not an open question for a human to
adjudicate — it is refuted by evidence already in hand. Collapsing it into
ASSUMED would dump it onto a reviewer alongside dozens of genuinely open
questions, and reviewers under volume approve things.

So the rule is:

- `CONTRADICTED` assertions are **dropped by the generator and never shown as
  proposals.** They are logged (with the contradicting node) as a generation
  diagnostic, because a high contradiction rate is a signal the prompt or the
  capture is wrong.
- `ASSUMED` assertions are **never inlined into a case's steps.** They are
  carried in a separate `openQuestions` list on the proposal.
- `OBSERVED` assertions are the only ones eligible to become case steps.

**A case with zero observed assertions is not a case.** It is a question, and
it is emitted as one — into a separate bin, in question form ("Does choosing a
workspace advance the wizard, or require a Next click?"), never as a
`TestCase` with a title that looks ready to approve. Agreed with your starting
position; this design just makes it a type-level distinction rather than a
convention, so it cannot be forgotten:

```
generate() → {
  proposals: TestCaseProposal[]   // ≥1 observed assertion; assumed ones quarantined
  questions: OpenQuestion[]        // no observed anchor at all
  contradictions: Contradiction[]  // dropped, kept for diagnostics
}
```

---

## Sequencing: prerequisites first, generator last

Two prerequisites came out of this design, and the second is bigger than the
feature it unblocks. They are built and verified **before** the generator, in
order. Building the generator against a capture that cannot support it would
mean generating from bad input and then blaming the model for the output — and
we would have no way to tell a prompt problem from a capture problem.

| | What | Blocks | Verified by |
| --- | --- | --- | --- |
| **P1** | AX-tree capture in `pnpm inspect` | mistake #4 being prevented at all | fixture score: #4 moves to *caught* |
| **P2** | State-oriented capture with declared transitions | mistake #2 being prevented at all | fixture score: #2 moves to *caught* |
| **P3** | The generator itself | — | full eval, four axes |

**P2 is not a cost of this feature.** A state-oriented capture library is an
asset in its own right, and generation is merely the thing that finally
justifies building it:

- **Healing** currently captures its accessibility snapshot at teardown, from
  whatever state the failure happened to leave the page in. A library of known
  good states gives the healer something to compare *against* — "this is what
  `admin.create-role.empty` looked like when it worked" — which is strictly
  more than it has now.
- **RCA** gets the same: a diff between the failing state and the last known
  good capture of that state is a far stronger prompt input than the failing
  state alone.
- **Hand-written authoring** gets the most immediate benefit. Every one of our
  four mistakes was a human writing an assertion without checking the real
  state. A browsable, named state library with real computed accessible names
  is the reference that would have prevented three of them, independent of any
  model.

If generation were cancelled tomorrow, P1 and P2 would still be worth having.
That is the test for whether a prerequisite is really a prerequisite or just
scope creep, and these pass it.

---

## P1 — the capture must be the accessibility tree

**This is a blocker, and it changes what step 3 depends on.**

The framing this design started from said "the accessibility tree from `pnpm
inspect`". `pnpm inspect` does not capture an accessibility tree.
`scripts/inspect-app.ts` calls
`captureDomSnapshot(page, { maxElements: 400 })`, and that snapshot's `name`
comes from `accessibleName()` in `packages/execution-engine/src/dom/snapshot.ts`
— an `aria-labelledby` → `<label>` → `innerText` heuristic.

That heuristic is *the exact thing that produced mistake #4*. `innerText` does
not include the PUA icon glyph (Findings 5/6/10) and does not concatenate
nested control names (Finding 11). A generator grounded in today's `pnpm
inspect` output would read the workspace row as `treeitem "ABCD"` and emit
`getByRole('treeitem', { name: 'ABCD', exact: true })` — reproducing Finding 11
byte for byte, with full confidence, and marked `OBSERVED`, because as far as
that capture is concerned it *is* observed.

The type system already warns about this. `AccessibilityNode` in
`packages/shared/src/types/ai.ts` carries the comment: *"a heuristic snapshot
can't see that divergence because it's built from the same heuristics that got
fooled the first time."*

So step 3 depends on a capture upgrade:

- `pnpm inspect` captures `AccessibilityTreeSnapshot` (via
  `captureAccessibilityTree`, which already exists and is already used by
  healing) **alongside** the existing `DomSnapshot` — not instead of it. The
  DomSnapshot carries `testId`, `placeholder` and `value`, which the AX tree
  does not, and those are useful for step 4's locator synthesis.
- Grounding checks run **exclusively against the AX nodes.** The DomSnapshot is
  never a grounding source; it is supplementary metadata only.

Without this, the design's central claim is false. With it, mistake #4 is
prevented by construction.

### P1 as built (2026-09-03), and what it found immediately

`pnpm inspect` now captures the CDP accessibility tree alongside the
DomSnapshot, and `report.md`/`pages.json` carry both plus a **name divergence
table** — every element whose visible label and computed accessible name
disagree. Grounding (step 3) will read only the AX nodes; the divergence table
exists for the "hand-written authoring" benefit claimed in the sequencing
section, and it earned that claim on its first real page.

Two things had to be fixed to make the capture trustworthy, both found by
running it rather than by reading it:

- **It captured empty pages.** Capturing straight after `domcontentloaded` on
  this SPA recorded 0 interactive elements and 1 AX node — an empty shell,
  written to the report as though it were the page. A human never sees this
  because typing a label takes seconds; piped input hits it every time. Now
  bounded-waits for interactive elements *and* network idle (the shell paints
  before the workspace tree arrives, so the first check alone still captured 21
  buttons and zero tree rows), and warns loudly if a capture is still empty.
  An empty capture is worse than no capture: it looks like data.
- **The divergence column was wrong in a way that would have cried wolf.** The
  first version asked "does `normalizeAccessibleName` reconcile the two
  strings", which is not what SmartLocator does. Its Finding 10 fallback is
  `primary.or(...)` filtering on **`hasText`** — *text content*, not the
  accessible name. Modelling the wrong mechanism flagged the login page's
  `Sign In` button as fatal when it resolves fine.

**Measured on the real app:**

| Page | Divergences | Notes |
| --- | --- | --- |
| `/login` | 2 | `Sign In` → `"ﱶ Sign In "`; `Sign in with SSO` → `" Sign in with SSO"` |
| `/files` | 25 | every workspace row: `ABCD` → `Collapse ABCD More options` |

Two findings worth carrying, neither of which we knew:

1. **An icon glyph outside the Private Use Area.** The `Sign In` button carries
   **U+FC76**, in Arabic Presentation Forms-A, not the U+E000–U+F8FF range
   `normalizeAccessibleName` strips. Finding 10's stripping does *not* cover it.
   (It resolves anyway — see below — but the assumption that icon glyphs live
   in the PUA is false for this app.)
2. **Finding 10's fallback also rescues Finding 11's family.** Verified live
   with a throwaway probe: raw `getByRole('treeitem', { name: 'ABCD', exact: true })`
   matches **0** elements, and the same candidate **resolves through
   SmartLocator**. Both families leave text content clean — the chevron and
   "More options" contribute to the *accessible name* via `aria-label` but not
   to `innerText` — so the text-content fallback matches. Finding 11's regex
   fix in `treeNode()` is therefore belt-and-braces today rather than
   load-bearing.

The second finding narrows P1's justification, so the honest version replaces
the original claim: grounding in the DomSnapshot would **not** produce a
hard-failing locator today, because SmartLocator would rescue it at runtime. It
would still produce a **false observation** — asserting a `treeitem` named
`"ABCD"` when the observed name is `"Collapse ABCD More options"` — labelled
`OBSERVED`. That is still disqualifying for a design whose entire safety
property is that `OBSERVED` means *seen*, and it still breaks the moment step 4
compiles to raw Playwright or a human writes a spec by hand. But it is a
correctness-of-evidence argument, not a runtime-failure argument, and the doc
said runtime failure. Corrected.

---

## The capture must record states, not pages — and this is the design's real limit

Here is the honest structural limitation, and it is the one that decides how
much step 3 can actually deliver.

**A static capture records state. It cannot record transitions.**

Mistake #2 (the upload wizard auto-advancing) is a transition fact. No capture
of the Workspace step, however complete, contains the information that clicking
a tile advances to the Folder step. The nodes present tell you what exists; they
say nothing about what happens next. A generator working from a single-state
capture will produce the same flow model a human produced from the same
evidence — *choose workspace, click Next, expect Folder* — because that is the
conventional wizard pattern and nothing in the capture refutes it.

The mitigation is not cleverer prompting. It is a richer capture.

### The v1 shape: human-declared transitions, not automatic recording

`pnpm inspect` is already interactive and human-driven — the operator drives
the browser and presses Enter to capture. That existing property is worth more
here than any automation, because the property we need is **observed rather
than inferred**, and a human who just performed the click is the most reliable
observer available.

So v1 is:

1. The operator names each capture as a **state**, not a page:
   `upload.workspace-step`, `upload.folder-step`, `admin.create-role.empty`.
   Several states per URL is normal and expected.
2. After a capture, inspect notices whether the AX tree or URL changed since
   the previous capture, and if so asks one question: **"What did you do to get
   here?"** The operator answers in plain language — `clicked the ABCD
   workspace tile`.
3. That produces a declared transition:
   `{ from: 'upload.workspace-step', action: 'clicked the ABCD workspace tile', to: 'upload.folder-step' }`.
4. An assertion about post-action state is `OBSERVED` **only if** a declared
   transition covers it. No inference from the action's name, ever.

The mechanical part is only *detecting that something changed* and prompting;
it never infers what the action was. That split is deliberate: change detection
is reliable, action inference is not.

**Is this sufficient?** For step 3, yes — and I'd argue it is better than
automatic recording, not merely cheaper. Automatic recording would have to
infer which element was clicked from an event stream and decide when the
resulting state has settled; both are guesses, and a wrong guess produces a
*confidently wrong transition*, which is precisely the failure this whole
design exists to prevent. Human declaration gives intent directly, with no
inference layer to be wrong.

Two honest limits:

- **The operator can forget or mislabel.** Forgetting is mostly handled by the
  change-detection prompt; mislabelling is not, and a wrong declared transition
  is a wrong ground truth. This is acceptable for the same reason we accept
  hand-written tests at all — but it means a transition is only as good as the
  person who declared it, and the fixture (below) is what catches systematic
  error.
- **The action string is prose, not a replayable instruction.** Step 3 only
  needs to know *that* the transition was observed, so prose is enough. **Step
  4 will need more** — an action it can compile into a click on a specific
  locator. Carrying that forward as a step-4 requirement rather than
  over-building it now; if it turns out step 4 needs structure, the natural
  upgrade is to have inspect record the locator alongside the prose while the
  operator is still on the page.

Automatic recording stays on the table if the manual version proves tedious in
practice. It should not be built before we know that.

### `checkGrounding()` is state-aware, by construction

Once states exist, a grounding check that only knows "the capture" is actively
dangerous: an assertion observed in the Folder step would silently ground a
claim about the Workspace step. Designing that in now rather than retrofitting:

- Every captured node belongs to exactly one `stateId`. There is no global node
  pool to check against, and no API that offers one.
- Every assertion carries the `stateId` it is claimed to hold in.
- `checkGrounding()` walks the case's steps maintaining a **state cursor**,
  starting at the case's declared entry state. Each assertion is graded against
  **the current state's nodes only.**
- An action step advances the cursor **only if a declared transition matches
  `(currentState, action)`**. If none matches, the cursor becomes `unknown`.
- Once the cursor is `unknown`, **every downstream assertion is `ASSUMED`**,
  regardless of what any state contains. The only thing that re-anchors it is
  an explicit `navigate` step to a URL matching a captured state.
- A node that exists in some *other* state does not ground anything. If it
  conflicts with a node of the same role+name in the *current* state, that is
  `CONTRADICTED`.

This is what makes the prerequisite chain mechanical rather than aspirational.
Before P2, no transitions exist, so the cursor goes `unknown` at the first
action step and mistake #2's assertions are all `ASSUMED` — a question. After
P2, the declared transition matches, the cursor moves to `upload.folder-step`,
and the assertion grounds against that state's real nodes. **The same code
produces "not caught" before P2 and "caught" after it, with no change to the
grader.** That is the acceptance test described below.

Consequences, stated plainly:

1. With single-state captures, **flow tests are almost entirely questions.**
   That is the correct output, not a failure — but it means step 3's initial
   yield on multi-step flows will be low, and the value shows up only as the
   captured state library grows.
2. Capture becomes a real human investment. That is a cost this design imposes
   and should be judged on — though see the sequencing section: the library
   pays for itself in healing, RCA and hand authoring regardless.
3. The one thing this buys, which matters more than yield: the generator can
   never silently invent a transition. It either has the evidence or it asks.

---

## Where generation fires: only when we don't already have it

`apps/api/src/modules/command/command.matcher.ts` already does keyword ranking
of a command against the existing test inventory, with no I/O and no NestJS —
`tokenize()` then `rank()`, returning `[]` when nothing scores.

Generation fires **only on `rank() === []`**. This is free, already built,
already unit-testable, and does three jobs at once:

1. **Cost control.** The most expensive generation is the one that recreates a
   test we already have. Never paying for it is better than deduplicating after.
2. **Suite hygiene.** Prevents near-duplicate cases accumulating.
3. **The eval's coverage-gap axis** falls out of the same function (below).

One caveat I want on the record: `rank()` is keyword matching, so it will
sometimes match a test that shares vocabulary but not intent ("download" in
both "bulk download" and "download template"), suppressing a legitimate
generation. That failure direction is the safe one — we lose a case we might
have wanted rather than paying to generate a duplicate — and the reviewer sees
the matched tests and can force generation with an explicit flag. Not worth
solving with embeddings in step 3.

---

## Cost, capture bounding, and the cache key

Budget assumption: ~$0.05 per generation, roughly five times a healing call.
Healing's measured cold-cache run was 4,561 tokens across 5 calls (~900
tokens/call). Generation's prompt is dominated by the capture, so bounding the
capture *is* bounding the cost.

**Bounding the capture sent to the model**, in order of application:

1. **Select states by command, don't send the library.** Reuse the matcher's
   `tokenize()` on the command, score it against state names and their node
   names, and send only the top-scoring states (proposed cap: 3 states, plus
   any state reachable by one recorded transition from them). A 24-page
   library must never go into one prompt.
2. **Drop unnameable nodes.** A node with an empty `name` cannot be targeted by
   a `role + name` locator and cannot ground an assertion. `captureAccessibilityTree`
   already drops `none`/`generic`/`InlineTextBox`; this drops the rest.
3. **Collapse repeated siblings.** Finding 11 observed 25 workspace rows all of
   shape `(Expand|Collapse) <name> More options`. Sending 25 near-identical
   nodes is pure waste. Send one exemplar plus a count and the shape:
   `{ role: 'treeitem', pattern: '(Expand|Collapse) <name> More options', count: 25, examples: ['ABCD', 'test 123'] }`.
   This is likely the single largest saving on list-heavy pages, and it also
   makes the repeated-row *shape* explicit to the model, which is exactly the
   information that would have prevented mistake #4.
4. **Hard node cap per state** (proposed: 150 after the above, truncation
   flagged). If truncated, the capture is marked `truncated: true` and **every
   assertion grounded in that state is downgraded to `ASSUMED`** — the same
   conservative posture as healing's gate rule 4, which refuses to reason from
   a truncated snapshot.

These numbers are proposals to be measured on the first real capture, not
tuned constants to be defended.

**Cache key.** Healing's lesson is that the key must include everything that
changes the answer, or you serve a stale one. Key is a hash of:

```
promptVersion + normalizedCommand + captureDigest + existingCaseTitlesDigest
```

- `promptVersion` — bump invalidates everything; non-negotiable when the prompt
  changes, or the cache serves answers to a question we no longer ask.
- `normalizedCommand` — lowercased, stop-worded via the matcher's `tokenize()`,
  sorted. "test the upload flow" and "Upload flow test" hit the same entry.
- `captureDigest` — hash of the **post-bounding** node set actually sent. This
  is the one that is easy to get wrong: if the app changes and the capture is
  re-taken, the cache **must** miss. Keying on the command alone would serve a
  proposal grounded in an app that no longer exists — the generation equivalent
  of the stale-session bug from Finding 1.
- `existingCaseTitlesDigest` — adding a test changes what "we don't have this
  already" means.

---

## The output record

Mirrors `HealingProposal`'s shape and its discipline: evidence travels *with*
the proposal, so the reviewer never has to go and find it.

```
TestCaseProposal {
  id, runId, sourceCommand, generatedAt, model
  case: TestCase                    // only OBSERVED assertions become steps
  grounding: [{
    stepIndex, assertion,
    grade: 'observed',
    evidence: { stateId, capturedAt, node: { role, name, enabled } }
  }]
  openQuestions: [{                 // ASSUMED — never inlined into steps
    question,                       // phrased as a question, not an assertion
    whyUngrounded: 'no capture of the post-click state' | 'state not captured' | 'capture truncated',
    wouldAssert                     // what it WOULD assert if confirmed
  }]
  matcherResult: { rankedZero: true, nearMisses: [...] }
  status: 'pending' | 'approved' | 'rejected'
}
```

Every observed assertion cites the exact node and the exact state it came from.
That is what makes review fast: the reviewer checks a claim against a quoted
node, not against their memory of the app.

---

## Review: `pnpm generate:review`, reusing the `heal:review` pattern

Same flow, same guarantees, for the same reasons — and `scripts/heal-review.ts`
has already been exercised end to end, so the pattern is proven rather than
speculative:

- Evidence first, then the proposal, then the diff, then explicit per-item
  confirmation. No bulk approve.
- Refuses to touch a file with uncommitted changes (with the stash/commit hint
  added after the first real run).
- Writes only on explicit `[a]pprove`.

Three deliberate differences:

1. **Approval is per-assertion, not per-case.** A reviewer must be able to
   accept a case while rejecting one of its assertions. Whole-case approval is
   how a wrong assertion rides in on the back of four right ones.
2. **Open questions are a separate pass**, shown after the proposals, so a
   reviewer answering questions is in a different mode from one approving
   cases. Mixing them is how ASSUMED items get waved through.
3. **Approval writes a `TestCase` record, not a spec file.** Step 3 output lands
   in `artifacts/generated/cases.json`. Nothing under `tests/` is touched. That
   line is the scope boundary and the review CLI enforces it by construction —
   it has no code path that writes a `.spec.ts`.

---

## The eval, designed now

No synthetic-mutation trick is available here — there is no equivalent of
"rename a testid and see if it heals". But we have something better: **45
hand-written DMS tests built from a real capture, with four documented wrong
assumptions among them.** That is a labelled dataset.

Run generation against the same flows the 45 tests cover, with the matcher gate
disabled (otherwise it suppresses everything by design), and compare three ways.

### Axis 1 — what it found that we missed (the upside)

Generated cases with ≥1 observed assertion and `rank() === []` against the
existing suite.

**Grading:** human adjudication into `real gap` / `duplicate in disguise` /
`trivial`. No mechanical grader is honest here — "is this worth testing" is a
judgment call and pretending otherwise would be exactly the kind of fake
oracle this design exists to avoid. Report the count of `real gap`, with the
cases listed, and let a human read them. This axis is the *point* of the
feature, so it gets reported prominently even though its grader is subjective.

### Axis 2 — what we have that it missed (coverage gap)

Mechanical: for each of the 45 existing tests, did generation produce a case
covering it? Reuse `rank()` in reverse — score each existing test's title
against generated case titles.

**Grading:** diagnostic, not pass/fail. Expect a large miss rate, and expect it
to be concentrated in multi-step flows, for the structural reason above. The
useful output is the *shape* of the misses: if they cluster on transitions,
that confirms the state-capture limitation and quantifies what richer capture
would buy. If they cluster somewhere unexpected, that is a finding.

### Axis 3 — what it invented (the dangerous one)

This is the axis with a real mechanical grader, and the only one with a hard
gate.

**Definition:** an assertion the model labelled `observed` that
`checkGrounding()` independently grades `assumed` or `contradicted`.

**Grading:** fully mechanical, because the grader is the provenance checker run
as a judge over the model's own labels. **Target: zero. Any non-zero result is
a release blocker for step 3**, in the same way a healing eval negative-control
failure would have been. An invention rate above zero means the model can smuggle
an ungrounded claim past the grade system, which is the entire threat model.

Report separately, as a quality (not safety) metric: assertions correctly
labelled `assumed` that a human judges false. These are not dangerous — they
surface as questions — but their rate is the review burden, and if it is high
the feature is annoying enough not to be used.

### Axis 4 — the four-mistake fixture, which is also the prerequisites' acceptance test

The four by-hand mistakes become permanent fixtures, the way healing's seven
scenarios did. For each: capture the relevant state, run generation, assert the
generator does **not** emit the known-wrong assertion as `OBSERVED`. That is a
true negative-control set, checkable on every future prompt change.

But it is doing a second job that matters more during the build, and it is the
reason the sequencing above is safe:

> **The fixture is the acceptance test for P1 and P2.** Each prerequisite has a
> specific mistake it exists to move from *not caught* to *caught*. If it lands
> and the score does not move, the prerequisite did not deliver what it was
> built for — and we find that out immediately, on the thing we built it for,
> rather than discovering it much later as a disappointing generator.

Run the fixture after **each** prerequisite and record the score. Expected
progression, written down in advance so it can be wrong:

| Stage | #1 admin `toBeDisabled` | #2 upload auto-advance | #3 bulk download | #4 tree row names | Expected total |
| --- | --- | --- | --- | --- | --- |
| Before P1 (DomSnapshot, page-oriented) | question | question | question | **generated wrong, marked OBSERVED** | 0/4 — and one silently false |
| After **P1** (AX tree) | question | question | question | **caught** | 1/4 |
| After **P2** (states + transitions) | **caught** | **caught** | **caught** | caught | 4/4 |
| Design's honest claim (retrospective) | caught | caught | caught | caught | 4/4 with both prerequisites |

Two things this table makes falsifiable:

- **P1's job is #4, and only #4.** If #4 still generates wrong after P1, the AX
  capture is not being used as the grounding source and nothing downstream will
  save it.
- **P2's job is #2 above all.** #1 and #3 also depend on capturing a specific
  *state* (the empty dialog; the post-select-all list), which is P2's other
  half — but #2 is the one that is impossible without declared *transitions*,
  so it is the sharpest test. **If #2 does not move to caught after P2, P2
  failed**, regardless of how good the state library looks.

Note the first row: before P1 the fixture does not merely score 0/4, it scores
*worse* than useless on #4, because that mistake is generated with an `OBSERVED`
label at full confidence. A 0/4 with one confident wrong answer is exactly the
state this design says must never ship, and it is why P1 was a blocker rather
than an improvement. **P1 landed 2026-09-03**; the row above it is now history
rather than the current state, and #4's expected score is `caught` pending the
fixture actually being built and run.

---

## Retrospective: would this design have made our four mistakes?

The instruction was to be honest rather than optimistic, and a design claiming
to catch all four would be lying. It catches two, and converts two into visible
questions without producing the right answer.

### Mistake #1 — `toBeDisabled` on the admin create forms (Finding 9)

**Prevented, mechanically — conditional on capture state.**

If the capture includes the open create-role dialog with an empty form, it
contains `{ role: 'button', name: 'Create', enabled: true }`. `toBeDisabled`
against that node grades `CONTRADICTED`, is dropped, and never reaches a
reviewer. This is the design working exactly as intended.

**The honest caveat:** it depends entirely on *which state* was captured, and
`enabled` is state-specific in a way that is easy to get wrong. If the captured
dialog had required fields filled, `enabled: true` there does not contradict
"disabled when empty" — different state, no contradiction, and the grade
correctly falls back to `ASSUMED`. If the dialog was never opened during
capture, there is no `Create` node at all and the whole assertion is `ASSUMED`
→ a question.

So: **caught outright in the good case, downgraded to a question in the likely
case.** Neither produces a green lie. But the mechanical catch is not free — it
is bought by capturing the empty-form dialog specifically, which is exactly the
kind of state a page-oriented capture would skip. This is the strongest
argument for state-oriented capture, and I'd treat "capture the empty form
state" as a required fixture rather than hoping an operator thinks of it.

### Mistake #2 — the upload wizard's auto-advance (Finding 8)

**Not prevented. The design would have made the same mistake — visibly rather
than silently.**

This is a transition fact and the capture is static. Given a Workspace-step
capture, the generator sees workspace tiles and a `Next` button, and the
conventional model — *select, then Next* — is the one any reasonable reader
produces. Nothing in a single-state capture refutes it. The humans who made this
mistake had *more* information than the generator would have and still made it,
twice, across two rounds of investigation.

What the design does buy: the assertion "clicking Next advances to the Folder
step" has no recorded transition backing it, so it grades `ASSUMED` and is
quarantined into `openQuestions` rather than becoming a step. The output is
*"Does choosing a workspace advance the wizard, or require a Next click?"* —
which is precisely the question that, asked out loud, would have saved two
rounds of wrong root-causing.

But that is a weaker claim than "prevented", and I want it stated plainly: **on
multi-step flows, without recorded transitions, this design mostly produces
questions rather than cases.** Only the transition-recording capture upgrade
turns this into a real catch. If step 3 ships with page-oriented capture, this
class of mistake is contained but not solved.

### Mistake #3 — the global-search bulk download

**Half prevented, and the other half is out of scope.**

The invented per-row `Download File` affordance: if the capture is of the
post-select-all state, it contains the consolidated `Download Selected (28)`
button and no per-row `Download File` node. An `OBSERVED`-labelled assertion
about a per-row download action would fail grounding and be dropped. Good.

If the capture is pre-select-all, neither node exists, everything is `ASSUMED`,
and it becomes a question. Contained, not solved — same pattern as #2, and for
the same reason (select-all is a transition).

**The half that is out of scope:** the original bug also compared a `.nth(0)`
accessor's count — which can only ever be 0 or 1 — against `resultCount()` of
28, a comparison that could never pass regardless of app behaviour. That is a
defect in the *compiled locator semantics*, not in the case's contract. Step 3
emits `TestCase` records with human-readable targets; it never sees `.nth(0)`.
**This class of bug belongs to step 4 and this design does not address it** —
worth carrying forward as a step-4 requirement rather than quietly leaving it.

### Mistake #4 — tree row accessible names (Finding 11)

**Prevented by construction — and only because of the AX-tree prerequisite.**

With the capture upgrade, the node reads
`{ role: 'treeitem', name: 'Collapse ABCD More options' }`, and any generated
target is grounded against that string. The sibling-collapsing step even makes
the shared shape explicit.

**Without the upgrade, this design reproduces the bug exactly**, marked
`OBSERVED`, with full confidence — because the DOM heuristic that produces
`"ABCD"` is the same heuristic that fooled us the first time. This is the single
strongest reason the AX-tree prerequisite is a blocker and not a nice-to-have.

### Retrospective summary

| Mistake | Outcome | Depends on |
| --- | --- | --- |
| #1 admin `toBeDisabled` | Mechanically dropped (`CONTRADICTED`) | **P2** — capturing the empty-form dialog as its own state |
| #2 upload auto-advance | **Not caught** — becomes a question | **P2** — declared transitions; impossible without them |
| #3 bulk download | Dropped if post-action state captured; else a question. Locator-semantics half is step 4's | **P2** — post-select-all as its own state |
| #4 tree row names | Prevented by construction | **P1** — AX-tree capture (blocker) |

**Two of four mechanically prevented. Zero of four become green lies. Only one
(#4) would have been generated *correctly*.**

Note what the dependency column says about sequencing: **every one of the four
depends on a prerequisite, and three of them on P2.** A generator built before
P1 and P2 does not score 2/4 — it scores 0/4 with one confident wrong answer.
The retrospective's honest claim is a claim about the *finished* chain, and
quoting it while skipping the prerequisites would be quoting it dishonestly.

That last number is the honest measure of this design's ambition. It is not a
system that writes correct tests; it is a system that refuses to write
confident wrong ones, and asks a question instead. Given that the alternative
is a permanent lie in a green suite, that is the right trade — but it should be
sold as what it is.

---

## What could go wrong

- **The model labels an invented assertion `observed`.** Handled: labels are
  claims, `checkGrounding()` is the judge, and eval axis 3 gates on exactly
  this with a target of zero.
- **The capture goes stale and proposals are grounded in an app that changed.**
  Handled by `captureDigest` in the cache key. This is the failure mode with
  the least visible symptom, so it gets a test.
- **Review fatigue.** A reviewer facing 40 open questions approves things.
  Mitigated by separating proposals from questions, per-assertion approval, and
  the matcher gate keeping volume down. If question volume is high in the eval,
  that is a signal to invest in capture rather than to raise the limit.
- **Grounded but wrong.** The residual risk this design does not eliminate: an
  assertion can cite a real node and still assert the wrong contract about it.
  Human approval is the only control. Worth being explicit that this remains.
- **Capture becomes a chore nobody does.** The design's yield is a function of
  capture richness. If state capture is tedious, the library stays thin and
  generation stays mostly questions. This is the most likely way the feature
  quietly fails, and it is a UX problem in `pnpm inspect`, not an AI problem.

---

## Interfaces this revises

`TestCaseGenerator` in `packages/shared/src/types/ai.ts` was stubbed in Phase 1
and does not survive contact with this design, in two ways:

```ts
export interface TestCaseGenerator {
  generate(input: {
    command: string;
    snapshot?: DomSnapshot;      // wrong capture type — see the prerequisite
    existingCases?: TestCase[];
  }): Promise<TestCase[]>;       // nowhere to put grounding, questions, or contradictions
}
```

- `snapshot?: DomSnapshot` must become the AX-tree-based state capture. Leaving
  it as `DomSnapshot` is what reproduces Finding 11.
- `Promise<TestCase[]>` has no room for provenance. A bare `TestCase[]` cannot
  express "these three assertions are grounded, these two are questions, and
  one was dropped as contradicted" — and flattening that away is precisely how
  an assumed assertion becomes a silent green lie.

Both are revisions to a Phase 1 socket, in the same way step 2 revised
`onHealRequested` out of existence once the design showed it was the wrong
seam. Exact signatures belong with the implementation, not this document.

---

## What step 3 does not do

Stated so the boundary survives contact with a later session:

- Does not execute anything.
- Does not write to `tests/`.
- Does not synthesise locator candidate chains — that is step 4, and it is
  where mistake #3's `.nth(0)` class of bug must be addressed.
- Does not decide whether a case is worth having. It proposes; a human decides.
