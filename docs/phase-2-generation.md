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

### P2 design: state-oriented capture with declared, cross-checked transitions

`pnpm inspect` is already interactive and human-driven — the operator drives
the browser and presses Enter to capture. That existing property is worth more
here than any automation, because what P2 needs is **observed rather than
inferred**, and a human who just performed the click is the most reliable
observer available.

But it introduces a risk the project has not had before. Until now, everything
downstream was grounded in a capture, and a capture cannot lie — it is a
mechanical record of what the browser computed. P2 makes a *human's
description* into ground truth, and step 3 will build on it confidently.
Nothing catches an operator who mislabels a state or misdescribes an action at
six o'clock on a Friday. So the design pairs every human declaration with a
mechanical check, the same asymmetry healing uses — there the model proposes
and deterministic code judges; here the human declares and the AX delta judges.

#### What a state is

**URL is not identity.** The upload wizard's three steps share
`/upload-files`, and that flow is precisely what P2 exists for. Nor is the
capture's content identity: the workspace list changes between sessions, so
two captures of the same logical state hash differently.

So identity is a **human-assigned label**, and the tool's job is to check it
rather than to derive it:

```
stateId   = slug(label)            // "upload.folder-step" — the primary key
label     = human-supplied         // proposed by the tool, confirmed or edited
url       = captured              // recorded, but NOT identity
signature = structural fingerprint // the cross-check, not the key
```

Two captures are **the same state** when they carry the same `stateId`. That
is deliberately a human judgement, because "same state" is a question about
the application's model, not about bytes — the Folder step with two folders
listed and the Folder step with fifty is the same state, and no content hash
will agree.

The **signature** is what stops that judgement going unchecked. It is
computed over the structural, non-data part of the AX tree: the multiset of
roles, plus the names appearing in chrome roles (`heading`, `tab`, `button`,
`link`) and explicitly *not* in data roles (`treeitem`, `row`, `cell`,
`option`, `listitem`). Workspace names change; "Select destination folder"
does not. On a re-capture the tool compares:

- **same label, very different signature** → "you labelled this
  `upload.folder-step`, but it looks nothing like the `upload.folder-step`
  captured on 20 Aug. Same state?"
- **different label, near-identical signature** → "this looks like
  `upload.workspace-step`, which you already captured. Same state?"

Neither blocks. Both are asked at capture time, while the operator is still
looking at the page and can answer cheaply.

**The signature's data/chrome split is a heuristic, and it inherits exactly the
weakness that made redaction not worth doing:** nothing mechanically separates
"Accounting Department" (a workspace, data) from "Advanced Search" (a control,
chrome). The role a name appears under is a good proxy and not a guarantee — an
app that renders navigation as `listitem`, or data as `heading`, defeats it.

That is acceptable here, and only because of *what the signature is for*. It is
a **check, not ground truth**: it never writes a fact, it only decides whether
to ask a human a question. So the design constraint is that a
misclassification must fail toward **asking**, never toward silence:

| Misclassification | Effect | Cost |
| --- | --- | --- |
| Data treated as chrome (a workspace name enters the signature) | The signature is more volatile than it should be, so re-capturing the same state after the data changed looks *different* → the tool asks "same state?" when it needn't have | A spurious question. Cheap, visible, answered in one keystroke. |
| Chrome treated as data (a real heading excluded) | The signature is *coarser* than it should be, so two genuinely different states can look alike → the tool asks "is this the same state you already captured?" | Also a question — and in the direction that catches mislabels. |

Both directions produce a question, which is the whole point: the failure mode
is *noise*, never a silently-accepted wrong state. Nothing in the signature
path may ever auto-accept a label, auto-merge two states, or suppress a
prompt — a signature that agreed would simply not raise a question, leaving
the human's label to stand on its own, which is exactly where it stood before
the signature existed. The signature can only ever add scrutiny, never remove
it.

#### The capture must record selection state — and acceptance depends on it

**This is P2's version of P1's blocker, and it is load-bearing for the
acceptance criterion.**

`captureAccessibilityTree` keeps `{ role, name, enabled }` and reads exactly
one CDP property, `disabled`. It drops everything else. Meanwhile the fixed
test for mistake #2 asserts:

```ts
await expect(upload.step('Folder')).toHaveAttribute('aria-selected', 'true');
```

That is a **selection-state** assertion, and the capture contains no selection
state. So with transitions but without this, the generator still could not
ground "the Folder tab is selected" — the fact is simply not in the evidence —
and **mistake #2 would not move to caught.** P2 would have shipped and missed
its one acceptance test.

So the AX capture gains the properties that carry step/selection semantics:
`selected`, `expanded`, `checked`, and `level` where present. All four come
from the same `node.properties` array already being read for `disabled`, so
this is a few lines and no new CDP round trip.

Worth being precise about what this buys, because there are two routes to
catching #2 and only one needs it:

- **Via node presence** — "after choosing a workspace, the heading *Select
  destination folder* is present" grounds from the transition alone, no
  selection state required.
- **Via selection** — "the Folder tab is selected" needs `selected`, and it is
  the more precise contract, the one our own fixed test chose, and the one a
  wizard's semantics actually turn on.

Capturing selection is what makes the second available. Without it P2 could
still claim #2 "caught" on the weaker route, which would be true but would
quietly narrow what the generator can express about every wizard in the app.

#### What a transition records

```
{
  from: stateId,
  to:   stateId,
  action:   "clicked the ABCD workspace tile",   // human, required
  declaredAt,
  observed: {                                    // tool, mechanical
    nodesAdded, nodesRemoved, nodesChanged,      // counts + samples
    urlChanged: boolean,
    selectionChanged: [{ role, name, from, to }] // now available
  },
  crossCheck: { verdict: 'consistent' | 'suspect', reasons: [...] }
}
```

The human supplies `action`. The tool computes `observed` by diffing the two
AX trees it already holds. Then it cross-checks them against each other:

| Check | Fires when | Why it catches a real mistake |
| --- | --- | --- |
| **Empty delta** | the action is declared but the trees are materially identical | "I clicked Next" when the click did nothing — the operator saw a page that looked the same and assumed it advanced |
| **Named element absent from `from`** | the declaration quotes a name no node in `from` carries | "I clicked the ABCD tile" recorded while standing on the Folder step — a mislabelled `from` |
| **Named element unchanged in `to`** | the quoted element is still present and nothing around it moved | the click missed, or hit a disabled control |
| **Delta implausibly large** | near-total node replacement for a declared in-place action | a navigation or session expiry happened mid-capture, not the action described |

**The cross-check fires immediately, at the moment of declaration** — in the
same prompt cycle as the label and signature checks, before the next state is
captured, while the browser is still open on the resulting page and the
operator still remembers what they clicked. This is not a reporting feature
and must never become one. The entire advantage of human-declared capture is
that the human is *right there*; a suspect transition surfaced in a report the
next morning is a suspect transition nobody resolves, because resolving it
means reconstructing a browser state and a memory that are both gone. Same
moment, same reason as the label/signature questions: the only cheap time to
fix a wrong declaration is the second after making it. `suspect` does not block the
recording — the human may be right and the heuristic wrong — but the verdict
is stored on the transition, and step 3 treats a `suspect` transition as **not
grounding**: it can support a question, never an `OBSERVED` assertion. A
transition nobody can vouch for is exactly the input this design exists to
refuse.

Note what this cross-check costs: nothing. Both AX trees are already captured,
the diff is a set comparison, and the name lookup is a substring scan over
nodes already in memory. It is the cheapest guard in the system and it covers
the failure mode P2 introduces.

#### Ergonomics: the typical flow in 11 keystrokes

If this is tedious it will not be used, and P2 becomes shelfware. Most
transitions are "I clicked X", so that case has to be nearly free.

The tool proposes; the human confirms. Labels are proposed from the page's own
heading and URL (`upload-files` + "Select destination folder" →
`upload.folder-step`). Actions are proposed from the delta: the tool lists
nodes that were present in `from` and are plausible click targets, ranked by
whether they vanished, and offers them as a numbered menu.

```
  captured "upload.workspace-step" — 45 elements, 131 ax nodes

  [drive the browser, come back, press Enter]

  Looks like a new state.
    label? [upload.folder-step]                    <- Enter accepts
    You went from "upload.workspace-step" to "upload.folder-step".
    What did you do?
      1) clicked "ABCD"
      2) clicked "Next"
      3) something else
    > 1                                            <- 1, Enter
    ✓ consistent: "ABCD" was present before, absent after; 38 nodes changed
```

A three-state flow with two transitions:

| Step | Keystrokes |
| --- | --- |
| capture state 1, accept proposed label | `Enter` = 1 |
| capture state 2, accept label, pick action | `Enter` `Enter` `1` `Enter` = 4 |
| capture state 3, accept label, pick action | `Enter` `Enter` `1` `Enter` = 4 |
| finish | `q` `Enter` = 2 |
| **total** | **11** |

Typing it all as prose instead — three labels at ~20 characters, two actions at
~30 — is roughly 130 keystrokes. The proposal machinery is worth about a 12×
reduction, which is the difference between a tool that gets used on a Friday
and one that does not.

**One hazard to be explicit about:** offering a guess biases the human toward
accepting it, and a wrongly-accepted action becomes ground truth. Mitigations:
never pre-select an option, always keep "something else", only offer candidates
when the delta actually implicates them, and run the cross-check on whatever is
chosen — including the chosen suggestion. The menu speeds up agreement; it is
not allowed to manufacture it.

#### The capture file, and why `checkGrounding()` can be state-aware

One session writes one directory (P1's retention already does this), and the
file is state-keyed throughout:

```
{
  sessionId, capturedAt, baseUrl,
  states: [ { id, label, url, signature, domSnapshot, axTree, nameDivergences } ],
  transitions: [ { from, to, action, observed, crossCheck } ]
}
```

The structural guarantee is what is *absent*: **there is no flattened,
all-states node list, and no accessor that returns one.** A grounding check
cannot accidentally match against the wrong state's nodes because it cannot
reach them without naming a state first. That is what makes the state cursor
described earlier enforceable rather than aspirational — an assertion observed
in `upload.folder-step` cannot ground a claim about `upload.workspace-step`,
because the two node sets never meet.

#### Acceptance: mistake #2 must move to caught

Re-run the four-mistake fixture the moment P2 lands, and record the score in
the table above. The mechanism by which #2 moves:

1. The capture holds `upload.workspace-step` and `upload.folder-step` as
   distinct states with distinct node sets and distinct tab selection.
2. A declared transition connects them with the action *clicked the ABCD
   workspace tile* and a `consistent` cross-check verdict.
3. `checkGrounding()`'s cursor, standing in `upload.workspace-step`, sees an
   action step matching that transition and advances to `upload.folder-step`.
4. The assertion "the Folder tab is selected" is graded against
   `upload.folder-step`'s nodes, finds `tab "Folder" selected=true`, and
   grades `OBSERVED`.
5. The wrong assertion — *click Next to advance* — finds no transition from
   `upload.workspace-step` whose action is a Next click, so the cursor goes
   `unknown` and every downstream assertion grades `ASSUMED`. It becomes a
   question, never an observation.

**If #2 does not move, P2 failed** regardless of how good the capture library
looks, and that is the point of fixing the criterion in advance.

The honest caveat, stated once plainly: step 4 above grounds because *a human
said so*. The cross-check makes a careless mistake unlikely, not impossible. A
determined mislabel still becomes ground truth, and the only remaining defence
is that generated cases go to review before they become tests.

#### Does P1 carry through to multi-state sessions?

Mostly yes; one thing needs rework.

- **`findNameDivergences(snapshot, axTree)` needs no change.** It already
  takes exactly one snapshot and one tree, which is what a single state is.
  It runs per state and the results attach per state.
- **`nameTruncated` needs no change.** It is a per-element flag inside a
  per-state snapshot, so it travels with its state automatically.
- **The report does need rework.** It currently renders one section per
  captured *page*, keyed on the label, and prints that state's divergence
  table. With several states sharing a URL that is still correct but becomes
  repetitive: the 25 workspace-row divergences on `/files` will re-appear
  identically in every `/files` state captured. Left alone, a ten-state
  session buries its two interesting divergences under two hundred repeats.
  So the report gains a **session-level rollup** — divergences grouped by
  shape across the whole session, with the states each shape appears in,
  which is the form the P1 audit already found most readable — and per-state
  tables list only what is new to that state.
- **A known detector weakness gets worse with more states.** Substring
  containment mispaired the row named `test` with `Expand Automation testing
  789101112 More options`. One session, one page, one bad row; ten states,
  ten copies of it. The rollup makes it visible rather than fixing it, and
  tightening the pairing rule (prefer the shortest containing name, require a
  word boundary) is worth doing when the noise justifies it — not before.


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
scenarios did.

**"Caught" is two conditions, not one.** The first draft of this fixture asked
only that the generator *not* emit the known-wrong assertion as `OBSERVED` —
and that criterion is satisfied **before P2 lands**, because with no
transitions recorded the cursor goes `unknown` at the first action step and
grades the wrong assertion `ASSUMED` anyway. A fixture that already passes
proves nothing, and we would have discovered that only after building P2 and
congratulating ourselves. So each mistake is scored on both halves:

| | Condition | What it protects |
| --- | --- | --- |
| **Safety** | the known-**wrong** assertion must NOT grade `OBSERVED` | no green lie enters the suite |
| **Capability** | the known-**right** assertion MUST grade `OBSERVED` | the capture can actually express the true contract |

`caught = safety && capability`. Safety is expected to hold at *every* stage,
including today — it is the property the whole design exists for, and a
regression in it is an emergency. Capability is the half that moves when a
prerequisite lands, which makes it the half that actually measures whether P1
and P2 did their job. Reporting only safety would show 4/4 from the start and
mean nothing.

#### The property every criterion here must have

The first draft failed for a reason worth naming, because it generalises:

> **A criterion that can be satisfied by knowing nothing is not a criterion.**

Refusing to assert anything is free. A system that knows nothing asserts
nothing, so any criterion phrased as an *absence* — "does not claim X", "emits
no false positive", "never says Y" — is passed perfectly by ignorance. This is
the same shape as Finding 15 (`docs/dms-findings.md`): there, an absence claim
needed a completeness guarantee; here, a pass criterion needs positive
evidence. Both are the rule that **you cannot conclude anything from a system
that hasn't looked.**

So every half of every criterion below is positive — it names a grade the
capture must actively *reach*, which an empty capture cannot:

| | "Caught" means | Why ignorance cannot satisfy it |
| --- | --- | --- |
| **#1** admin `toBeDisabled` | wrong assertion graded **`contradicted`**, right assertion graded **`observed`** | Both require the dialog state to be captured and to contain `button "Create" enabled=true`. An empty capture grades both `assumed` and fails both halves. |
| **#2** upload auto-advance | wrong assertion graded `assumed`, right assertion graded **`observed`** | Safety here is genuinely *not* positive, and cannot be: nobody captured what `Next` does, so `assumed` is the honest grade and an empty capture would match it. **#2 therefore rests entirely on capability**, which requires a declared transition *and* `tab "Folder" selected=true`. Neither exists in an empty capture. |
| **#3** bulk download | wrong assertion graded **`contradicted`**, right assertion graded **`observed`** | Contradiction requires the post-select-all state to be captured *and complete* — absence is only evidence in a complete view (Finding 15). Ignorance yields `assumed`. |
| **#4** tree row names | wrong assertion graded **`contradicted`**, right assertion graded **`observed`** | Same: the bare name must be positively absent from a complete capture, and the concatenated name positively present. |

Safety is scored against that **specific expected grade**, not against "anything
but observed" — which is what makes the safety half unreachable by ignorance
for #1, #3 and #4. For #2 it is unreachable via capability instead. Two
different guards, because the two halves fail to ignorance in two different
ways:

- `expectedWrongGrade` stops **safety** being satisfiable by silence.
- The ignorance check (below) stops **capability** being satisfiable by silence.

**The fixture proves this about itself on every run.** It grades all four
mistakes against a deliberately empty capture and asserts the score is 0/4,
printing `ignorance check: an empty capture scores 0/4 — the criterion needs
positive evidence. ok`. If that ever scores above zero, the criterion has
rotted back into something ignorance can pass, and the run fails rather than
reporting a comfortable number.

The fixture grades **deterministically, with no LLM.** Its input is the
historical wrong assertion and the historical right one, hand-written from
`docs/dms-findings.md`; its judge is `checkGrounding()`. That is deliberate:
what P1 and P2 change is whether a *capture can ground a fact*, which is a
property of the capture and the grader, not of the model. Whether the model
actually produces these assertions is a different question, measured by eval
axes 1–3 once the generator exists.

But it is doing a second job that matters more during the build, and it is the
reason the sequencing above is safe:

> **The fixture is the acceptance test for P1 and P2.** Each prerequisite has a
> specific mistake it exists to move from *not caught* to *caught*. If it lands
> and the score does not move, the prerequisite did not deliver what it was
> built for — and we find that out immediately, on the thing we built it for,
> rather than discovering it much later as a disappointing generator.

Run the fixture after **each** prerequisite and record the score. Expected
progression, written down in advance so it can be wrong:

> ### What a green score here does and does not prove
>
> **It proves the mechanism works.** The capture path, the AX properties, the
> grader, the state cursor, the transition cross-check — all genuinely
> exercised, by the real functions, end to end.
>
> **It does not prove any of it works against DmsSynergy.** The fixture runs
> against `tests/fixtures/generation/four-mistakes.html`: a synthetic offline
> page, ~60 nodes, no icon-font glyphs, no async loading, no session expiry, no
> 25-row workspace tree, no truncation. The real app has every one of those,
> and each has already broken an assumption at least once (Findings 5, 6, 10,
> 11, and the truncation false positive found in P1's own audit).
>
> These are two different claims and the second is the one that matters for
> the suite. **A 4/4 here means "the machinery is sound", never "the DMS suite
> is covered."** Anyone reading this score six months from now should assume
> the weaker claim unless they find a live measurement alongside it.
>
> What *has* been checked live, separately from this fixture: P2a's selection
> capture against the real upload wizard (`tab "Workspace" selected=true`,
> `Folder`/`Upload` false) and the transition cross-check against the real
> dashboard (it correctly flagged a fabricated transition as `suspect`). Those
> are two spot-checks, not coverage.

**Measured, 2026-09-04.** The prediction below it was wrong, and the fixture is
what found that out:

| Stage | #1 admin `toBeDisabled` | #2 upload auto-advance | #3 bulk download | #4 tree row names | Score |
| --- | --- | --- | --- | --- | --- |
| *empty capture (ignorance check)* | not caught | not caught | not caught | not caught | **0/4** |
| **After P1** (AX tree; measured baseline) | caught | **not caught** | caught | caught | **3/4** |
| **After P2a** (selection captured) | caught | **not caught** | caught | caught | **3/4** |
| **After P2** (states + transitions) | caught | **caught** | caught | caught | **4/4** |

**The `baseline` and `p2a` rows are identical for a reason, and it is not
coincidence — but it did hide a hole.** Re-verified 2026-09-05: the two stages
produced *byte-identical* output. The degradation was working correctly (the
raw capture carries `selected` on four nodes; baseline stripping removes all
four), but **no mistake could observe the difference**. #2 is the only case
touching `selected`, and it dies at the transition step — `assumed: cursor
unknown` — long before any node lookup. So the `p2a` row measured nothing the
`baseline` row did not, and was unfalsifiable on its own.

Worth stating plainly, because it corrects an intuition that looks right:
**#2's blocking reason does not shift from "missing property" to "missing
transition" between those stages.** It is the *transition* at both, because
the cursor walk fails first. #2 can never expose P2a's contribution at any
stage.

Fixed by adding a **prerequisite probe** — an assertion that isolates one
prerequisite, reported separately from the four-mistake score. P2a's probe
asserts `tab "Workspace" selected=true` in the workspace state, needing no
transition at all:

| Stage | P2a probe |
| --- | --- |
| baseline | `FAIL — assumed: the capture does not record "selected" for tab "Workspace"` |
| p2a | `PASS — observed: tab "Workspace" has selected=true` |
| p2 | `PASS` |

Deleting P2a now visibly breaks that line instead of hiding behind #2. Probes
gate only at the full stage, since failing at an earlier one is exactly what
they are there to show.

Every row is reproducible: `AITP_FIXTURE_STAGE=baseline|p2a|p2 pnpm eval:generation`.
Each earlier stage is recreated by *removing* exactly what that prerequisite
added — selection properties for P2a, declared transitions for P2 — so these
numbers stay checkable rather than being a one-off measurement taken on trust.
The 0/4 row runs on every invocation regardless of stage.

*Predicted in advance, for comparison:* after P1 → 1/4, with #1 and #3 also
waiting on P2.

**Where the prediction was wrong.** #1 and #3 were already caught at the P1
baseline. The claim that they needed P2 assumed the old tooling could not
capture a dialog or a post-select-all list as its own state — but it always
could: a human navigates there, types a label, and captures. What the old
tooling genuinely lacked was **transitions**, and only #2 depends on those. So
P2's real scope is narrower than this document originally claimed: it moves
exactly one mistake, not three.

That is a smaller win than predicted, and it is still the right thing to have
built, because #2 is the one that is *impossible* by any other route — no
static capture of any number of states can establish what an action causes.

**P2a moved nothing on its own, and that is not a failure.** The score is 3/4
before and after it, because #2 fails at the *transition* step long before it
reaches the selection assertion. Its contribution was isolated by forcing a
transition into the capture and running the fixture at each stage:

| | transition present, `selected` not captured | transition present, `selected` captured |
| --- | --- | --- |
| #2 capability | **FAIL** — `the capture does not record "selected" for tab "Folder"` | **PASS** — `tab "Folder" has selected=true` |

So P2a is **necessary but not sufficient**, demonstrated rather than argued.
Either prerequisite alone leaves #2 not caught; together they carry it. That is
precisely the reading the staged run was designed to produce, and it would have
been invisible in a single combined jump at the end.

Two things this table makes falsifiable:

- **P1's job is #4, and only #4.** If #4 still generates wrong after P1, the AX
  capture is not being used as the grounding source and nothing downstream will
  save it.
- **P2's job is #2 above all.** #1 and #3 also depend on capturing a specific
  *state* (the empty dialog; the post-select-all list), which is P2's other
  half — but #2 is the one that is impossible without declared *transitions*,
  so it is the sharpest test. **If #2 does not move to caught after P2, P2
  failed**, regardless of how good the state library looks.
- **#2 has two routes to "caught", and they are not equally good.** Node
  presence ("the *Select destination folder* heading appears") grounds from
  the declared transition alone. Selection ("the Folder tab is selected") is
  the contract our own fixed test asserts, and needs the AX capture to record
  `selected` — which it does not today. Scoring #2 caught on the presence
  route while selection is ungroundable would be technically true and
  quietly misleading, so the fixture asserts the **selection** route. See
  "The capture must record selection state" above.

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
