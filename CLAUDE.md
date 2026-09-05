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

### A discriminating property needs a discriminating fixture

> **A test of a DISCRIMINATING property is only real if its fixture would
> produce a different result under the wrong behaviour.**

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
- **Scan changed files for invisible characters before committing** — NUL bytes
  and Private Use Area glyphs have repeatedly crept into source here, and a NUL
  makes git treat a source file as binary.
- **Captures and traces are gitignored and stay that way.** They contain live
  session tokens and real customer data. See `docs/WHERE-WE-ARE.md`.
