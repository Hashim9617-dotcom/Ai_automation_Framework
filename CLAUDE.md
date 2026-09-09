# Working conventions for this repo

Start with [`docs/WHERE-WE-ARE.md`](docs/WHERE-WE-ARE.md) — it exists so a
session with no memory of this project can resume without reconstructing
context from git log.

---

## A script must assert its own effect before reporting success

**This rule was earned twice in two sessions, both times by a script that
printed a success message while doing nothing:**

- A string-replacement script reported `wired in` while matching nothing. The
  function it was supposed to call was defined and never called, and all three
  stages of a staged measurement returned an identical score. Caught only
  because identical numbers across stages looked wrong.
- A scan script reported `scan clean` while reading zero files — a `slice(3)`
  that `trim()` had shifted by one character, so every path was mangled.
  Caught only because the mangled path happened to throw `ENOENT`. A path that
  merely *missed* would have printed `clean` forever.

Both would have been caught by one rule:

> **Any script that edits or scans must assert its own effect before reporting
> success.** A replacement asserts its match count is what it expected. A scan
> asserts it found a non-zero number of files. A splice asserts the anchors it
> found are the ones it meant.

Failing loudly beats a comfortable message. `throw new Error('replaced 0 of an
expected 1')` is worth more than any amount of care taken while writing it.

**This applies to throwaway scripts too — especially those.** A one-off script
in the scratchpad is the one nobody reviews, run once, its output believed
because there is no reason to doubt it. Both near-misses above were throwaways.

---

## A test suite that passes first time has not yet been checked

Rule 4 in [`docs/phase-2-generation.md`](docs/phase-2-generation.md) says a
test's expectations must come from an external source of truth, never from
reading the implementation — because the process that wrote the bug writes the
test and asserts what the code *does* rather than what is *correct*.

Stating that rule does not make you obey it. **The verification is mutation
testing:** break each rule in the implementation deliberately, and confirm a
test fails for each break. A suite that passes both the correct implementation
and a broken one is not testing what it claims to test — it is rule 3
("a stage that measures nothing") wearing a different hat.

Done for `checkGrounding()` on 2026-09-05: six mutations, one per design rule,
all caught (state isolation by 4 tests, unrecorded-property silence by 2). The
throwaway mutation script asserted its own effect at three points — the anchor
matched exactly once, the file actually changed, and the original was restored
byte-for-byte afterwards.

### The hardest mutation is usually the most important one

State isolation — the most important safety property in the generation design —
was nearly skipped in that pass, because breaking it needed a structural
rewrite of the lookup rather than a one-line flip like the others. That is not
a coincidence and it will recur:

> **A property that is hard to break is one that is deeply woven into the
> implementation — which is exactly the property you most need to confirm is
> load-bearing rather than incidental.**

The ease of writing a mutation is a measure of how superficial the property is,
so ranking mutations by convenience tests the design in precisely the wrong
order. When one mutation is awkward and the rest are easy, do the awkward one
first. It caught four tests where the easy ones caught one apiece.

### The mutation harness is subject to its own rule

**A mutation run needs two controls before its number means anything.** Learned
on 2026-09-07: three mutations were reported SURVIVED because the harness's
`tsc` parser filtered on lines containing `error TS`, and TypeScript puts the
missing property name on the *continuation* line. The mutations had been caught;
the instrument was broken.

That direction is the lucky one. A false survivor is loud — it demands
investigation, which is how it was found. **The inverse is silent:** a matcher
that fails to match, a renamed test, a dropped parse can just as easily report
CAUGHT when nothing caught anything, and

> **a harness that reports everything CAUGHT looks perfect.**

That is rule 2 again — a criterion satisfied by knowing nothing — pointed at the
tool doing the measuring. So every run proves itself first, both ways, the way
the invisible-character scan proves 2/2 planted hits before reporting clean:

- a **known-CAUGHT** control (a mutation that must be detected); if it is not,
  detection is broken and every CAUGHT in the run is meaningless;
- a **known-SURVIVING** control (a comment, or another genuinely cosmetic
  change); if it is reported caught, the harness is flagging noise, so every
  CAUGHT could be noise rather than the mutation.

If either control comes out wrong the run is **void and reports nothing**. A
number from an unverified instrument is worse than no number, because it gets
believed.

#### Three outcomes, not two: "did not compile" is not "was caught"

The controls run once at the start. They prove the harness *can* detect and
does not *always* claim detection — they say nothing about a per-mutation
verdict reached for the wrong reason, and a mutation that never compiled is
exactly that. So each mutation declares what should catch it:

| Verdict | Meaning |
| --- | --- |
| **caught by a test** | it compiled, and a named test failed. Report which. |
| **caught by the type system** | declared per mutation, for one whose whole point is that it CANNOT BE EXPRESSED. |
| **void** | it did not compile and was not declared structural. Not a pass — the mutation needs rewriting before it means anything. |

**Measured here, because the failure mode is not the obvious guess:** Playwright
transpiles without typechecking, so a *type* error in a mutation is invisible
and 203 tests still pass; a *syntax* error aborts Babel before any test runs,
leaving an empty failure list. Both read as SURVIVED, which sends someone
hunting for a missing test that is not missing. The false-CAUGHT direction shows
up on the structural side, where any `tsc` error merely *containing* the expected
string counts.

**This found a live one on 2026-09-07.** The `writeRisk: always hold` mutation —
reported CAUGHT, and cited as the verification that the classifier was tested —
inserted an early `return` that made the loop below unreachable, so TypeScript
stopped narrowing the discriminated union and the file did not compile. It ran
anyway under transpile-only and the right test did fail, so the *conclusion* was
correct; but it was reached from code `tsc` rejects, and nothing could tell that
apart from a genuine catch. Rewritten to widen the word list instead, which is
the same mutation expressed so it compiles.

Add a **third control** alongside the other two: a deliberately non-compiling
behavioural mutation that must be reported VOID. Otherwise the void path itself
can be silently broken, and malformed patches go back to being counted.

Two harness bugs were caught by these controls rather than by inspection, which
is the argument for having them: the `tsc` parser dropped continuation lines, and
`expect.every()` over an empty array is vacuously true, so a mutation declared
*expected to survive* read as caught.

**And keep one harness, current and correctly named.** A stale second copy left
beside it will eventually be run by someone, against source it no longer
matches, and hand them a verdict that means nothing.

### Behavioural mutations change behaviour, not control flow

**Three mutations in one week came back VOID for the same authoring mistake:**
an early `return` inserted at the top of a function makes the code below
unreachable, TypeScript stops narrowing there, the file does not compile, and
the verdict is void. Every one was wasted effort on a known pattern.

- `writeRisk: always hold` — `return 'creates-data';` before a loop over a
  discriminated union; `step.description` and `step.role` both stopped
  narrowing.
- `resolve an ambiguous step to the first match` — `if (false) {` around a
  block ending in `continue`.
- `treat an action on nothing as an app finding` — the same.

> **A behavioural mutation must change BEHAVIOUR without changing CONTROL
> FLOW.** Widen a list, flip a boolean, alter a constant, swap a comparison
> (`> 1` becomes `> 999`, `=== 0` becomes `< 0`). Never insert an early return,
> and never wrap a block in `if (false)`.

Two corollaries:

- **Never delete a field to test coverage.** That tests the serialiser's
  tolerance of a missing field, not the property you meant — the K4 pass hit
  this and had to be rewritten to MUTATE each field instead.
- **A control is a mutation too**, and gets the same rule. A known-CAUGHT
  control written as `[].push(...)` infers `never[]` and does not compile; the
  void gate duly reported it, which is the harness catching a bad control.

### A discriminating property needs a discriminating fixture

> **A test of a DISCRIMINATING property is only real if its fixture would
> produce a different result under the wrong behaviour.**

**State the counterfactual AT AUTHORING TIME, in the test.** Discovering it when
a mutation survives is discovering it too late — the test has already been read,
reviewed and trusted by then.

> **Every test that proves a property carries a one-line `// wrong:` comment
> saying what THIS fixture would produce under the WRONG behaviour** — written
> when the test is written, not when a mutation survives.
>
> **If you cannot write that sentence, the fixture is wrong.** That is what
> makes the rule cheap: the sentence is not documentation, it is the check.
> Being unable to finish it is the finding.

Enforced by `tests/unit/counterfactual.spec.ts`, whose file list is the honest
record of which suites have been through this — extending that list is a
visible act, not a silent assumption.

#### Two species, and they need different fixes

The distinction matters because reaching for the wrong fix wastes the
discovery:

| Species | Symptom | Fix |
| --- | --- | --- |
| **The fixture cannot discriminate** | the test runs the right code with data that gives the same answer either way | **the input is too weak — change the input** |
| **The guard sits where nothing can trigger it** | no input can reach the failing case at all | **the input cannot help — extract the guard somewhere a test can hand it the failing case** |

The second is the nastier one because it looks identical from outside: the guard
is there, it is correct, it runs on every call, and **it would read as working
forever.**

Both species, found on 2026-09-08 in one mutation pass over the report writer:

- *First species* — E1 built its fixture from only PASSING rows, but the passed
  list prints `rowId` directly while every other section goes through a shared
  heading. The fixture never reached the code under test. Fixed by adding a
  failing row.
- *Second species* — E6's missing-row check and its read-from-disk both lived
  inside `writeAuthoredReport`, and **no input can make the renderer omit a
  row**, so nothing could ever make either fire. No fixture would have helped.
  Fixed by extracting `verifyReportOnDisk()`, which a test can hand a file with
  a row deleted.

The four, because the mechanism differs each time and only the shape repeats:

| # | Property | Why the fixture could not tell | Fix |
| --- | --- | --- | --- |
| 1 | gate ranks matches best-first | every score was tied, and a reversed list of ties equals its own sort | give the candidates different scores |
| 2 | a transition's `verdict` is in the digest | compared a capture with NO transitions against one with a `suspect` transition, so they still differed on `from>to:action` | compare `consistent` against `suspect`, alike in all else |
| 3 | a collapsed group's `examples` are in the digest | same shape, against a capture with no collapsed groups | vary only `examples` |
| 4 | `parseCsv` strips the BOM | asserted through `readSheet`, which trims every header — and `String.trim()` already removes U+FEFF | assert on `parseCsv` directly, at the observation point where the strip is the only thing that could matter |

#3 and #4 differ in an instructive way. In #2 and #3 the **baseline** was wrong.
In #4 the fixture and baseline were both fine and a **downstream transformation
masked the difference** — so the counterfactual has to be stated about the
OBSERVATION POINT, not only about the input. *"What would this expression
evaluate to if the code were wrong?"* is the question, and it must be asked
where the assertion actually looks.

This is *not* rule 4, and the difference matters. Rule 4 is asserting the wrong
thing. This is asserting exactly the right thing about data that cannot tell
the difference — so no implementation, correct or broken, could ever fail it.

Found on 2026-09-05 in the generation gate. The assertion was right:

```ts
expect(scores).toEqual([...scores].sort((a, b) => b - a)); // best-first
```

The fixture was not. Every match scored the same, and a reversed list of tied
scores still equals its own sort. Reversing the ordering in the implementation
broke nothing. The test passed, read sensibly, and proved nothing — invisible
to review, caught only by the mutation surviving.

**Ordering, precedence, selection, tie-breaking and ranking are all this
shape**, and so is anything that bounds, filters or prioritises. For each,
ask the fixture question directly: *would this data give a different answer if
the behaviour were wrong?* If every element is identical, every score tied, or
every candidate equally eligible, the answer is no and the test is decorative.

The same idea runs through the design docs, where it was learned three separate
times (see "Three rules this project keeps re-deriving the expensive way" in
[`docs/phase-2-generation.md`](docs/phase-2-generation.md)): you cannot
conclude anything from a system that hasn't looked, a test that cannot fail, or
a stage that measures nothing. A script reporting success without checking its
own effect is the same error in miniature.

---

## Other standing conventions

- **`ALLOW_WRITES` is never set.** Three `@write` tests create real records in
  a live customer system and stay skipped. Don't set it without deciding that
  on purpose.
- **Prove a push landed** with `git log origin/master -1 --oneline` and
  `git status -sb`. A `git push` exit code is not proof.
- **Invisible characters are guarded by a test, not by remembering to scan.**
  `tests/unit/invisible-characters.spec.ts` runs on every unit run over every
  tracked source file. Deliberate instances live in its allow-list with the
  reason they must stay; anything else fails.

  It replaced a hand-run script on 2026-09-08, after a literal **U+FEFF** got
  into `packages/shared/src/authored/sheet.ts` — written by the very code that
  strips a BOM. **The file was in scope and the scan did run afterwards**, so
  neither scope nor ordering was at fault: the detector's set was NUL plus the
  PUA range, and U+FEFF is in neither. Its planted-hit control reported a
  confident 2/2, because *a control can only validate the classes someone
  thought to plant*.

  > **A detector built from a list of bad characters is bounded by the
  > imagination of whoever wrote the list.** Use the structural definition
  > instead: Unicode categories `Cf`, `Co`, `Cs` and `Cc` (less tab, newline,
  > carriage return) are what "invisible character" means, and they cover the
  > BOM, the soft hyphen, the bidi overrides and the zero-width joiners without
  > anyone naming them.

  Same lesson as the app-agnostic audit, where a keyword list was replaced by
  deleting `tests/app/` and rebuilding: when a check depends on a list you
  wrote, find the structural version of the question.
- **Captures and traces are gitignored and stay that way.** They contain live
  session tokens and real customer data. See `docs/WHERE-WE-ARE.md`.

### A rule that refuses everything is as empty as one that accepts everything

Rule 2 says a criterion satisfied by knowing nothing is not a criterion. It is
usually met as a rule that accepts too much. **On 2026-09-09 it arrived
reversed**, and the reversed form is harder to see:

> **A rule that refuses everything can also be satisfied without knowing
> anything about the page.** It just fails safe while doing it, so nothing ever
> draws attention to it.

The resolver refused a target matching more than one node — a good rule. But a
flattened accessibility tree lists every visible label TWICE, the control and
the text on its face, so the count was almost always two and almost everything
was refused. On the bundled demo app that was **every addressable control
without exception: 0 of 28 names could produce a runnable row.**

A refusing rule looks safe in review precisely because nothing wrong gets
through. Ask of any refusal the same question rule 2 asks of any acceptance:
**what input would come out the other way?** If the honest answer is "almost
none", the rule is measuring nothing.

The fix was not to relax the refusal — that puts guessing back. It was to stop
miscounting: use the role the human already wrote, collapse a control and its
own text into one control, and only then count.

### A rule is not known to be correct until a SECOND target has seen it

The collision above was in the DMS numbers all along — 11 ambiguous clauses,
small enough to read as noise. It became undeniable only when the demo app was
substituted for DMS during an outage, where it accounted for 43% of all names.

> **A single application cannot distinguish "this rule is right" from "this rule
> happens to fit this app."** Same shape as a stub that cannot falsify itself,
> and a fixture that cannot discriminate.

This is the standing argument for capturing a **second real application** before
any evaluation whose conclusions depend on the rules being right. Here it paid
out by accident, at the cost of one forced substitution. After an eval it would
have cost every conclusion that eval produced.

**And measure the change on both targets, before and after.** The same pass
found a bug review had missed — `extractRole` reading a role word out of the
target's own NAME — only because one name regressed from resolving to matching
nothing. It also showed the fix barely moves the DMS number, because ambiguity
was never DMS's binding constraint. Both halves get reported: *the fix is right
AND this application's problem is elsewhere.* Saying only the first would be the
more comfortable half of a true statement.

### Check the denominator before concluding from a ratio

"96.5% of clauses match nothing in the capture" was reported on 2026-09-09 as
evidence that the resolver could not resolve. It was measuring something else:
every clause had been matched against the DASHBOARD capture, while the sheet
spans seventeen modules and its first column says which one each row belongs to.
A File Explorer row cannot match a dashboard capture however good the resolver
is.

Re-paired per module the figure fell to 86% and unique resolutions doubled —
and, far more usefully, it exposed the thing the bad denominator had hidden:
**nine modules, 45% of the sheet, have no capture at all.** That is the largest
actionable item on the path and it was invisible while everything was being
compared against one page.

> **A ratio is a claim about its denominator as much as its numerator.** Before
> reporting one, ask what population it is over and whether every member of that
> population could in principle have come out the other way. If some could not,
> the ratio is measuring the pairing, not the thing.

The failure direction is the dangerous one: **the broken denominator made the
result look WORSE, and an alarming number gets repeated.** A flattering one
invites scrutiny; a damning one gets believed and acted on.

Related, same pass: **succeeding is not the same as being right.** `extractTarget`
"parsed" 83% of Then clauses, which read as health until the extractions were
looked at — 22% were sentences longer than four words, and others were `"system"`
and `"ui"`. A permissive parser inflates its own success rate, so measure what it
PRODUCED, not how often it returned something.

### An element's own name is not a description of it

`extractRole` read the word "select" out of `"Select department"` — an option's
own name — and concluded the QA had named a combobox. The clause said nothing
about a role; the target did.

> **When reading an attribute out of a sentence, exclude the quoted name from
> the scan.** The moment a real application has a button called "Link", a field
> called "Field" or a menu item called "Select", a name and a description of a
> kind become indistinguishable.

Found by measuring the change, not by reviewing it: one name regressed from
resolving to matching nothing. No amount of reading the diff would have shown it.

### A permissive parser inflates its own success rate

`extractTarget` "parsed" 83% of Then clauses, which read as health until the
extractions were looked at: 22% were sentences longer than four words, and
others were `"system"` and `"ui"`. Gating it on what an accessible name actually
looks like — thresholds measured from real captures, not chosen — moved that
column from 17% failing to 31%.

> **Measure what a parser PRODUCED, not how often it returned something.** A
> lenient parser is indistinguishable from a good one by success rate alone.

And the failure is worse than a missed extraction: a confident wrong result
travels downstream and fails somewhere it cannot be classified, so the honest
diagnosis never happens at the point where it was still cheap.

### Decide MEANING before checking resolvability

A sheet-triage pass first asked "does this clause resolve to an element?" and
then "what is it saying?". That order put the automation ceiling at 46.4%. The
right order put it at **29.8%**.

The cause: `extractTarget` slices `"record"` out of *"the record should be
created successfully"* and `"ui"` out of *"the ui should show a colour change"*.
Both look like element names. Neither is one.

> **When a cheap syntactic test and an expensive semantic one disagree, run the
> semantic one first.** Otherwise the syntactic test silently decides the
> classification, and it decides it in the flattering direction.

### Some rows are not automatable, and saying which IS the deliverable

A QA sheet written for humans legitimately contains things only a human can
check. *"the ui should show a colour change proper response and animations"* is
not automatable by anyone and never will be. Measured on the real sheet: **29.8%
of rows have nothing structural in the way.**

> **The report's value is not only the rows it runs. It is telling the QA, row by
> row and with a reason, which rows can never be automated and why.**

Three reasons, three different actions, three different people — no capture for
the module (someone captures the screen), describes an outcome not an element
(buildable, our work), too vague to verify (the row needs rewriting, QA work).
Kept apart for the same reason `failed` and `refused` are: merged, the list is
useless to all three because nobody can act on it.

**And a headline number belongs where it stays current.** The ceiling is
recomputed from the sheet on every run and rendered into the report. A number
that lives in a summary someone wrote once goes stale in silence.

### A downstream mechanism must not decide what an upstream one already knows

**Seen twice now, in different clothes**, which is why it is written as a rule
rather than a note on either instance:

| | what was asked | why it could not answer |
| --- | --- | --- |
| **Clause kind** | should the MODEL classify this clause? | the QA already wrote `Given`/`When`/`Then` in a column. Any tie-break makes the model the authority over the person who wrote the sheet. |
| **Clause meaning** | does `extractTarget` find a name here? | it slices `"record"` out of *"the record should be created successfully"*. It is a string matcher; it cannot know that "record" is the object of an outcome. |

> **When an upstream source already knows something, or a downstream mechanism
> is not qualified to judge it, the downstream mechanism does not get a vote.**

The two failure modes are worth naming separately because they feel different in
the moment:

- **The upstream source already knows.** Deciding again downstream creates a
  disagreement, and *every rule for settling it takes authority away from the
  source*. The answer is not a better tie-break; it is not holding the election.
- **The downstream mechanism cannot know.** It will still ANSWER — that is the
  trap. `extractTarget` returns a plausible-looking string with no way to signal
  "I have no idea", and its confidence is read as information. The answer is to
  ask the question that IS answerable first, and only then let the mechanism run.

Both are cheap to get right and expensive to find later: the second one put the
automation ceiling at 46.4% when it is 29.8%, in the flattering direction, and it
was invisible until the outputs were read one by one.

**The tell:** ask what a mechanism would return for input it has no business
judging. If the answer is "something that looks fine", it is being asked the
wrong question — and asking it earlier in the pipeline will not help.

### Weld a headline number to the assumption it was measured under

`29.8%` is the automation ceiling of one QA sheet — measured with **8 of 17
modules captured**, where "no capture for this module" is itself one of the
exclusion reasons. It is not the ceiling of the approach; it is the ceiling of
today's capture coverage. With every module captured the same rules give
**48.5%**.

An alarming number is the dangerous kind to leave unqualified: it gets repeated,
where a flattering one would have invited scrutiny. So both are computed, both
are rendered, and each carries the coverage it assumed.

> **If a number will be quoted, the qualifier belongs AT THE POINT OF
> MEASUREMENT — in the same struct, the same row of the same table — not in the
> prose around it.** Prose does not survive being copied into a slide.

And a pair of numbers is a prediction: today's figure should move towards the
second as the assumption is removed. **Re-measuring after it is removed is the
falsifier.** If it moves as predicted the diagnosis holds; if it barely moves,
the real constraint is somewhere nobody has looked — which is worth more than
being right.

### A mock is a claim about a system you have never called

The generation engine ran for weeks on mock and counting gateways written by the
same author as the code. The first real API call, on 2026-09-09, found **five
differences**, four of them places tests had been asserting fiction:

- `completeJson` appends a schema message the mock never records — so every
  prompt-content assertion was measuring a string the provider never saw;
- the real model fences its JSON and the real gateway strips it; the mock throws
  on the same payload, so the strip was never exercised;
- `provider`/`model`/`costUsd` are placeholders in the mock, and one of them is
  written into a proposal's provenance;
- the mock has **no cache**, so a cache test written against it passes with the
  cache removed;
- the model returns a top-level field the engine never reads.

> **Until it has been called for real, a mock encodes what you BELIEVE the
> system does.** Both can be wrong together, and the suite cannot tell you —
> for the same reason a stub cannot falsify itself and a single application
> cannot validate a rule.

**The fix is not to distrust mocks. It is to pin the differences.** A local HTTP
server exercises the real client class — request body, retries, parsing, error
paths — at zero cost and no provider, and fails when the two drift apart. That
suite is worth more than the smoke that found the divergences, because it runs
every time.

**And a smoke must assert its own premise.** The first run bounded its capture
to zero states, so the model was asked about an empty page and answered "I have
no data". Reported as-is that is a finding about the engine; it was a fact about
the command. Any script that sets up an input before measuring must check the
input arrived — the same rule as asserting a script's own effect, applied to
what goes IN rather than what comes out.

**A cost estimate is a measurement too.** The smoke was estimated at $0.08 and
cost $0.027 — 3x high. An unchecked over-estimate buys budget nobody needed; the
same arithmetic in the other direction trips the budget guard mid-run and
presents as a failure of the thing being measured.
