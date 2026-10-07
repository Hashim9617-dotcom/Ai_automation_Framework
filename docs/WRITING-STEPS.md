# How to write a step the framework can run

One page. Everything below is **proven**, not illustrative:
`tests/demo/writing-steps.spec.ts` parses this file, feeds every example through the
real reader, resolver and executor against the bundled demo app, and asserts the
verdict printed beside it. An example that stopped being true would fail the suite.

That is deliberate. The last time this repo put a remedy in a message without running
it, the remedy was wrong and read more convincing than the clause it replaced (§AG).

---

## The one rule that matters most

> **Put the control's name in quotes.**

`clicks the "Save employee" button` resolves. `clicks the Save employee button` is a
coin toss: the framework has to guess where the name ends, and when it guesses wrong
it either refuses your row or — worse — resolves to something else.

A quoted name is trusted **exactly as written**, whatever its shape. Long composite
names are fine:

```
clicks the "Go to location PDF report_2 (2).pdf Updated 27/08/2026" link
```

Quoting also avoids a real misread: in `enters Jane in First name`, the word
**First** is read as the ordinal "first", and the row is refused for naming a
position rather than for the verb it was actually about.

### But only ONE name per clause

A clause carrying **two** quoted names is refused — `qualifier-not-supported`,
before anything looks at the verb — because the framework addresses one element and
has nowhere to put the second:

```qa-row refused qualifier-not-supported
When: User enters "Jane" in the "First name" field
Then: verify "Employee directory" is visible
```

That is the rule, not a limitation of typing: `verify the "Notes" field equals "10"`
is refused the same way. One clause, one quoted name, one element.

---

## Rows that run

A row needs a **When** (something to do) and a **Then** (something to check). A When
alone can be performed and proves nothing.

```qa-row passed
Then: verify "Register employee" is visible
```

```qa-row passed
When: clicks the "Log out" button
Then: verify "Sign in" is visible
```

```qa-row passed
Then: verify "Employee directory" is visible
```

### What a Then can check

Four properties, and no others: **present**, **enabled**, **selected**, **checked**.

```qa-row passed
Then: verify "Save employee" is enabled
```

Absence works too, and is checked properly rather than being read as "the element
exists":

```qa-row passed
Then: verify "Payroll summary" is not visible
```

---

## Actions the framework can perform

**A click, and nothing else.** `click`, `clicks`, `press`, `presses`, `tap`, `taps`
all mean the same thing.

**Typing is not supported. Selecting from a dropdown is not supported. Uploading a
file is not supported.** A row that needs one of those is refused by name, so it
appears in your report with the verb it was waiting for — it is not silently skipped:

```qa-row refused action-not-supported
When: User enters "Jane" in the name field
Then: verify "Employee directory" is visible
```

The refusal names the verb (`enters`), and the row will run unchanged on the day that
action exists. There is nothing for you to rewrite.

**Do not try to phrase around it.** There is no wording that makes a typing clause
run today, and the refusal you get depends on how you wrote it rather than on what is
missing: name both the value and the field and you get
`qualifier-not-supported` (two quoted names); leave the field unquoted and
`First name` is read as an ordinal. Write it the way it reads best, and let the
report tell you the capability is absent.

---

## Rows that are held rather than run

A row whose click would create, modify or delete data is **held**: reported, with its
reason, and not run. `ALLOW_WRITES` is never set in this kit.

```qa-row held
When: clicks the "Save employee" button
Then: verify "Employee directory" is visible
```

Held is not a defect in your row. Nothing needs changing.

---

## Rows that are refused, and what to do about each

### The clause names no element

```qa-row refused no-readable-target
Then: verify the record was created successfully
```

This is the most common refusal on a real sheet, and the fix is always the same:
**name the control.** The sentence describes an outcome, and "record" is a word from
it, not a thing on the screen. Of the clauses that land here on the DMS sheet,
**none** carried a quoted name the framework had failed to read — they named nothing.

### The clause names a position or a region

```qa-row refused qualifier-not-supported
When: clicks the second "Save employee" button
Then: verify "Employee directory" is visible
```

The framework addresses an element by role and name only. An ordinal ("the second
Edit"), a containing region ("in the row for Jane") or a second quoted name has
nowhere to go — and this was measured against a real browser before it became a
refusal: a clause scoped to one row clicked a **different** row and reported a pass.

Give the control a name that is unique on the screen, or say which one you mean in a
way that does not depend on position.

### The name matches more than one element

The row is refused and the candidates are listed. Say which one you mean. The
framework will not pick, because picking succeeds — the run goes green or red against
an element nobody chose, and nothing ever asks again.

### The column is blank

Every clause needs a **Given**, **When**, **And** or **Then** column. Without one,
nothing has said whether the sentence is something to _do_ or something to _check_,
and guessing wrong makes a test that passes having verified nothing.

---

## What the columns mean

| Column    | What goes in it                                                          |
| --------- | ------------------------------------------------------------------------ |
| **Given** | where the row starts. Context — never resolved as an element, never run. |
| **When**  | the action. A click.                                                     |
| **And**   | a second action or check; the framework reads which from the verb.       |
| **Then**  | the check. One of the four properties above.                             |

The column **always wins** over the sentence. If a Then clause starts with `clicks`,
the row is refused rather than reinterpreted — a column is a human saying what the
clause is, and no mechanism gets to overrule that.

---

## Before you write a hundred rows

Run `pnpm triage "<your workbook>" --app <app>` first. It reports, row by row, which
rows would run and which would not, with the reason and who can act on each. It needs
no browser and writes nothing.

The honest number for the DMS sheet today is **0 of 470 rows**, and the reason is
mostly this page: the sheet almost never quotes a control name — 5 clauses out of
1452 — so there is nothing for the framework to look for. That is what this page is
for.
