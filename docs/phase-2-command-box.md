# The AI Command Box

> Type a plain instruction, get a run and a report.

This is the feature the platform is named for, and the one thing that has never
been joined up. Every part exists: the matcher and gate, generation (door A), the
authored-sheet reader and resolver (door B), the executor, the report. This
document settles how they are joined **before** any of it is wired, because four
of the five decisions below shape code that would otherwise have to be unpicked.

---

## 0. What `/api/command` does today

**Partial, not a stub** — and the distinction matters, because "stub" would
license replacing it and "partial" means building from it.

|                                            | today                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| load the test inventory                    | **real** — `playwright test --list --reporter=json`, deduped across projects, cached only on success |
| tokenise and rank the command              | **real** — `tokenize()` + `rank()` from the shared matcher                                           |
| build a `--grep` and enqueue a run         | **real** — returns a `Run` immediately, so it is already non-blocking                                |
| `dryRun` to get the plan without executing | **real**                                                                                             |
| when nothing matches                       | **a message saying Phase 2 will handle it.** No generation.                                          |
| authored sheet rows (door B)               | **absent entirely**                                                                                  |
| the generation gate                        | **not used** — it calls `rank()` directly, so `suppressedBy` and `reason` are never produced         |

So roughly: the _existing-tests_ path is finished, and the two AI doors are not
connected. Notably it already satisfies part of requirement 3 (non-blocking) and
part of requirement 2 (it returns `keywords` and `availableTags`).

---

## 1. One endpoint, with a stated precedence

**Decision: ONE endpoint. It tries the doors in a fixed order, and the caller may
pin one.**

```
  existing tests  →  authored sheet rows  →  generation from a capture
```

### Why one endpoint

The human types one box. Two endpoints would force the person typing to decide,
_before_ they know whether anything matches, which source of truth their question
belongs to — and "has a QA already written a row for this flow?" is precisely
what they are asking the platform to find out. Two endpoints also duplicate the
matcher and the gate, which is where drift starts.

### Why NOT try both and merge

Door A and door B produce **different outcome sets with different owners**. Door B
has six row statuses and a three-way owner split (`app-team` / `qa` / `capture`);
door A produces proposals, refusals and grades. The report already keeps them
apart, and §9.3 exists because merging two kinds of failure produces a report
useless to both audiences. Merging them at the entry point would recreate that
error one layer up.

### Why the sheet beats generation — the load-bearing decision

**Rule 4.** A QA sheet row is an EXTERNAL source of truth: a human wrote what
this flow should do, before and independently of anything the platform observed.
A generated case's expectations come from the system under test.

So if a human has already written the expectation and we generate one instead, we
have preferred the model's reading of the application over the person's statement
of intent — with theirs sitting unread. That is rule 4 violated by _preference
order_ rather than by a bad test, which makes it harder to see.

Generation is therefore the **fallback**, never the default. It answers "nobody
has written this down anywhere" and nothing else.

### Why existing tests come first

Unchanged from the gate's existing reasoning: the most expensive generation is
the one that recreates a test we already have, and the check is free.

### The override

`source: 'auto' | 'existing' | 'sheet' | 'generate'`, default `'auto'`.

A deliberate choice must be expressible — a QA who wants to run their sheet rows
specifically should not have to phrase a command that fails to match anything
first. But `auto` is the default, and **the response always names which door
answered and why the earlier ones did not.**

---

## 2. A command that matches nothing says what it looked in

> "No tests found" and "no tests matched these three words in this capture" are
> different answers with different next steps.

The service switches from bare `rank()` to **`checkGenerationGate()`**, which
already produces `keywords`, `suppressedBy` (with scores) and a one-line
`reason` — built and unit-tested, and currently unused by the API.

Every response carries a `searched` block naming the corpus of each door:

```jsonc
"searched": {
  "keywords": ["employee", "registration"],   // after stop-word removal
  "existingTests": 438,                        // what rank() ranked over
  "sheetRows": null,                           // null = no workbook configured
  "captureStates": ["dashboard", "files"],     // what generation could ground in
  "capturedAt": "2026-09-04T06:24:46.947Z"
}
```

Three distinct nothing-answers, which must not collapse into one:

| situation                         | what the caller is told                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| every word was a stop word        | `keywords: []` — nothing was searched for, rephrase                                 |
| keywords matched nothing anywhere | the corpus sizes above: _these words, this many tests, these capture states_        |
| keywords matched an existing test | `suppressedBy`, with titles and scores — so a suppression that was wrong is visible |

The third is the one the gate's own header warns about: keyword matching will
sometimes suppress generation for a genuinely new flow, and the only symptom is
that nothing was produced. Naming the suppressor turns an hour of confusion into
one line.

`availableTags` stays — it is the one field that answers "what could I have said
instead".

---

## 3. Nothing blocks on a run

Already the shape and it is kept: `interpret()` returns after `enqueue()`, so the
response carries a run id and the caller does not hold a connection for minutes.

**No new path is invented.** Status comes from `GET /api/runs/:id`; live progress
from `GET /api/events/stream/:runId`; the report lands where reports already land
under `artifacts/`.

### The one thing this exposes: two kinds of run

A door-A or existing-tests run is `npx playwright test --grep=…` — a spawned
process, which `RunnerService` already does. **A door-B run is not.** Executing
resolved sheet rows is `executeAuthoredRows()` in-process, against a browser the
API drives.

So `RunnerService` needs a second execution strategy rather than a second
endpoint. Both emit to `/api/events` and both produce a `Run` with the same
lifecycle, because the caller must not have to care which door answered in order
to poll for the result.

---

## 4. Safety: one thing is new, and one thing is already broken

### Unchanged

`ALLOW_WRITES` stays off, and **no request body can turn it on.** There is no
field for it, and adding one would be the thing this rule exists to prevent. A
sheet cannot escalate its own privileges (§9.4); neither can an HTTP client.

### New: command text is untrusted input arriving over HTTP

Sheet cells and capture content were untrusted but LOCAL — they arrived from a
file on disk or a page we drove. Command text arrives from outside the process,
from whoever can reach the port. Same rules, new entry point, and it belongs in
the injection section of `phase-2-generation.md`:

> **A command string is never a file path, a shell argument, a locator, or
> anything executable.** It reaches `tokenize()` and is stored on the run record
> for display. Nothing derived from it is interpolated into a command line.

### Already broken, found while specifying this: shell injection via `grep`

`RunnerService.execute()` spawns with `shell: process.platform === 'win32'`, and
under `shell: true` **Node concatenates the arguments into one command string
without escaping them** — its own `DEP0190` warning says so. `buildArgs()` emits
`--grep=${request.grep}`, and `grep` is a caller-supplied field on
`runRequestSchema`.

Demonstrated in isolation:

```
spawnSync('node', ['-e','console.log(1)', '&', 'echo', 'INTERPRETED'], { shell: true })
  -> "1\nINTERPRETED"      the & was interpreted by cmd.exe
  -> with shell:false: "1"  the & was a literal argument
```

So `POST /api/runs {"grep": "@smoke & whoami"}` runs `whoami` on Windows. This
predates the Command Box, but the Command Box enqueues through the same path, and
requirement 4 is exactly this subject — so it is fixed here rather than recorded
for later.

**Boundary validation was tried first, and it cannot work here.** The plan was to
reject shell metacharacters at the schema. `|` defeats it: it is both a shell
metacharacter and regex alternation, and `CommandService` builds every
multi-test grep by joining test titles with `|`. Rejecting it breaks the
product's own generated greps; allowing it keeps the injection open. The
legitimate character set and the dangerous character set genuinely intersect, so
there is no set to admit.

> **When validation would have to separate two sets that actually overlap, the
> answer is to remove the interpreter, not to write a cleverer filter.** A filter
> over intersecting sets can only trade false rejections against real holes.
> There is no setting of it that gives neither.

**So the shell is gone.** `shell: true` was there for one reason — `npx` is a
`.cmd` shim that `spawn` cannot execute directly on Windows. Resolving
Playwright's own CLI entry point and running it under THIS node removes the shim,
and with it the need for a shell:

    const playwrightCli = require.resolve('@playwright/test/cli');
    spawn(process.execPath, [playwrightCli, ...args], { cwd, env });

No shell means no concatenation, which means every argument is passed literally.
`--grep=@smoke & whoami` reaches Playwright as ONE argv element that happens to
contain an `&`, and nothing executes it. This also holds for every future
argument, which the boundary approach never could.

Recorded as a security finding in its own right in
[`docs/security-findings.md`](security-findings.md) (SEC-1), with the demonstration,
the mutation that holds it, and the reasoning about overlapping character sets —
so it survives independently of this spec. Held by
`tests/unit/no-shell-spawn.spec.ts`.

What remains on the schema is a length bound and a control-character check —
defence in depth for some future caller that does reach a shell, and cheap either
way. Deliberately NOT a metacharacter blocklist, which would fail exactly as
above.

---

## 5. Every run states its target

> A green run against the demo app must never read like one against a customer
> system.

`environment` already exists on `RunRequest`. It is not enough on its own: it is
a key (`local`, `qa`, `app`), and a reader three weeks later does not know which
URL that resolved to.

So every run records, and every response returns:

```jsonc
"target": {
  "environment": "local",
  "baseUrl": "http://127.0.0.1:4173",
  "isDemoApp": true
}
```

`isDemoApp` is computed, not declared — a boolean a reader cannot mistake, which
is the same reason the triage report carries its provenance block rather than
leaving the qualifier in prose. This follows the rule §11 established: a result
that could be mistaken for a stronger result must carry its own qualifier at the
point of measurement.

**Exercised against the demo app and the captures already on disk. No DMS
needed** — which is also the honest limit of what a green run here proves.

---

## 6. Swagger, and the demo

The endpoint is documented with `@ApiOperation` and typed response DTOs so
`/api/docs` shows the request shape, the three nothing-answers and the run id —
`pnpm api:dev` and open `http://localhost:3001/api/docs`.
