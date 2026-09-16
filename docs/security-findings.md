# Security findings — our own code

Vulnerabilities found in **this platform**, not in the application under test.
Issues living in the target app go in [`dms-findings.md`](dms-findings.md), whose
scope is deliberately the opposite of this one's.

Each entry records what was reachable, how it was demonstrated, what was changed,
and the reasoning worth reusing. A fixed vulnerability whose reasoning is not
written down gets reintroduced by the next person who finds the fix inconvenient.

---

## SEC-1 — shell injection in the run API, reachable unauthenticated over HTTP

**Status: fixed** (2026-09-11). Found while specifying the AI Command Box, in
code that predates it.

### What was reachable

`RunnerService.execute()` spawned the Playwright CLI with
`shell: process.platform === 'win32'`. Under `shell: true` Node **concatenates
the arguments into a single command string without escaping them** — its own
`DEP0190` deprecation warning states exactly this — and `buildArgs()` emits
`--grep=${request.grep}` from `grep`, a caller-supplied field on
`runRequestSchema`.

So on a Windows host:

    POST /api/runs {"grep": "@smoke & whoami"}

ran `whoami`. Arbitrary command execution, as whatever user the API runs as, from
anyone who could reach the port — the endpoint has no authentication. The
attacker-controlled value crosses no trust boundary on its way from the HTTP body
to the command line.

Demonstrated in isolation before being believed, rather than argued from the
docs:

    spawnSync('node', ['-e','console.log(1)', '&', 'echo', 'INTERPRETED'], { shell: true })
      -> "1\nINTERPRETED"       the & was interpreted by cmd.exe
      -> with shell:false: "1"  the & was a literal argument

### Why validation was the wrong fix — the part worth keeping

The first fix attempted was a boundary check: reject shell metacharacters on
`grep` at the schema. **It cannot work here, and the reason generalises.**

`|` is a shell metacharacter. `|` is also regex alternation — and
`CommandService` builds every multi-test grep by joining test titles with `|`.
So the character that must be rejected to close the hole is a character the
product itself generates in normal operation. Rejecting it breaks the feature;
allowing it leaves the vulnerability open.

> **When validation would have to separate two sets that genuinely intersect, the
> answer is to remove the interpreter, not to write a cleverer filter.** A filter
> over overlapping sets can only trade false rejections against real holes; there
> is no setting of it that gives neither.

Escaping fails from the other direction: an escape has to be correct for every
shell it might ever meet, which is a bet renewed on every platform and every
Node change. Both approaches leave you reasoning about a parser you do not
control.

### What changed

The shell is gone. It existed for exactly one reason — `npx` is a `.cmd` shim
that `spawn` cannot execute directly on Windows. Resolving Playwright's own CLI
entry point and running it under **this** node removes the shim, and the need for
a shell with it:

    const playwrightCli = require.resolve('@playwright/test/cli');
    spawn(process.execPath, [playwrightCli, ...args], { cwd, env });

No shell means no concatenation, which means every argument is passed literally.
`--grep=@smoke & whoami` reaches Playwright as one argv element that happens to
contain an `&`, and nothing executes it. The property holds for every future
argument too, which no boundary filter could promise.

What remains on `runRequestSchema` is a length bound and a control-character
check. That is defence in depth for some future caller that _does_ reach a shell,
and cheap either way — deliberately **not** a metacharacter blocklist, which
would fail exactly as described above.

### How it is held

`tests/unit/no-shell-spawn.spec.ts`:

- A grep carrying shell metacharacters and a file-writing redirect is passed
  through the spawn path; the child must receive **one literal argument** and the
  redirect must **not** have executed.
- The test reads the shell setting **out of `runner.service.ts`** rather than
  hard-coding `shell: false`. A test that hard-codes it proves only that Node
  behaves as documented and would stay green while someone restored `shell: true`
  in the runner.
- A positive control runs the same payload _through_ a shell and requires the
  sentinel file to appear — otherwise "no file appeared" proves nothing.

Verified by mutation: restoring `shell: process.platform === 'win32'` fails the
test with _"the grep payload EXECUTED — the runner is spawning through a shell"_,
which is a behavioural failure rather than a source-text assertion.

### Related

- [`phase-2-command-box.md`](phase-2-command-box.md) §4 — the specification work
  that surfaced it.
- [`phase-2-generation.md`](phase-2-generation.md) — the injection-surface rules;
  command text over HTTP is the third entry point added to that list. The rule
  "untrusted text is never a shell argument" was already written there. What was
  missing was noticing that **a field on an HTTP schema is untrusted text** — the
  rule had been protecting only the inputs someone had already thought of as
  inputs.

---

## SEC-2 — an ambient `BASE_URL` silently redirected every environment, including `local`

**Status: fixed** (2026-09-11), held by tests and a mutation run (2026-09-16).
Found while building the AI Command Box, in code that predates it.

### What was reachable

`loadEnvironment()` applied its `process.env` overrides unconditionally:

    if (process.env.BASE_URL) overrides.baseUrl = process.env.BASE_URL;

`BASE_URL` lives in `.env`, which `ensureDotenv()` loads on every run, so this
was not an exotic CI-only condition — it was the normal state of a developer
machine. The override was applied **after** the environment file had been read,
so it replaced the `baseUrl` of every key: `app`, `qa`, `staging`, and `local`,
whose file says

    "baseUrl": "http://127.0.0.1:4173"

in plain text. A run explicitly requested against the bundled demo app therefore
drove a real browser against the **live customer system**, and nothing in the
request could have prevented it. The caller had no way to say "no, I meant the
demo app" — `local` already said that, as a literal, and lost.

No writes can have occurred: `ALLOW_WRITES` has never been set, so the three
`@write` tests stay skipped. The exposure is navigation and login traffic against
a customer system from a run labelled as local.

### What it defeated, and why that is the interesting part

This project had already built the safety property that should have caught it:
**every run prints its resolved environment and baseUrl on the first line of
output.** That property did not fail because it was missing, or because nobody
read it. It failed because the override corrupted the value the statement was
derived FROM — the run announced its target perfectly accurately, and the target
was wrong.

The archive shows the second half of the same mistake. `aitp-reporter.ts` records

    environment: process.env.TEST_ENV ?? 'qa'

— a label read from the same ambient environment that redirected the run — and it
records **no `baseUrl` at all**. So the one pairing that would have made the
mismatch visible after the fact, label next to target, was never written down.

> **A label read from the source that could redirect it cannot check the
> redirection.** A run stating its own target is only meaningful if the target is
> resolved independently of whatever could redirect it — and if the label and the
> target are recorded TOGETHER, because either alone is unfalsifiable.

### What changed

A `baseUrl` the file pins as a **literal** is no longer overridden; one written
as an interpolation still is:

    const pinnedLiteral = typeof rawBaseUrl(raw) === 'string' && !rawBaseUrl(raw)!.includes('${');
    if (process.env.BASE_URL && !pinnedLiteral) overrides.baseUrl = process.env.BASE_URL;

The override was never needed for the files it was written for. `app`, `qa` and
`staging` consume `BASE_URL` through `${BASE_URL}` placeholders, so interpolation
already applies it to them. It changed the outcome ONLY for a file pinning a
literal — exactly the file whose author was saying "this environment IS this
URL". Ambient state does not overrule a value someone wrote down on purpose.

### How it is held

`tests/unit/environment.spec.ts`, six tests, both directions: a literal survives
an ambient `BASE_URL`; a placeholder takes it; a defaulted placeholder takes it;
with no ambient value the default still fires.

Verified by mutation on 2026-09-16, with the three controls this repo requires
(known-CAUGHT, known-SURVIVING, known-VOID all correct, so the verdicts stand):

| mutation                                               | verdict    | caught by                  |
| ------------------------------------------------------ | ---------- | -------------------------- |
| override ALWAYS wins (the original bug)                | **caught** | `a LITERAL baseUrl wins…`  |
| override NEVER wins                                    | **caught** | `…names ANOTHER variable…` |
| rule inverted (literal overridden, placeholder pinned) | **caught** | both directions            |
| a DEFAULTED placeholder counts as pinned               | **caught** | `…names ANOTHER variable…` |

**Two of those survived the first run, and that is the finding worth keeping.**
Every environment file in this repo writes `${BASE_URL}`, so interpolation
already substitutes the ambient value — which means the placeholder tests passed
**with the override line deleted outright**. They asserted the right thing about
data that could not tell the two mechanisms apart. Only a file interpolating a
DIFFERENT variable makes interpolation and the override disagree, so that is now
the fixture that carries the placeholder half of the rule.

### Did it ever happen? What the archive can and cannot say

Asked of `artifacts/runs/`: did any run carry a `local`/`demo` label while its
traffic went to a non-loopback host?

**Zero.** The honest qualifier belongs next to the number, because the corpus
mostly cannot answer the question:

|                                                |                                                             |
| ---------------------------------------------- | ----------------------------------------------------------- |
| record files scanned                           | 24                                                          |
| carrying any environment label                 | 9 (5 `demo`, 2 `live`, 2 `app`)                             |
| carrying a label **and** any URL               | **2** — both `app`, both to the customer domain, consistent |
| suspect (local/demo label + non-loopback host) | **0**                                                       |

The seven `demo`/`live` authored-run records name their target in prose and
contain no URL at all, so for them the pairing cannot be checked. And
`archiveIfNotClean()` archives a Playwright run only when it failed or flaked, so
passing runs — the ones that would have gone quietly to the wrong host — leave no
record whatsoever. Zero is the result, and it means _no evidence was found in a
corpus that is structurally unable to hold most of it_, not _it never happened_.

From 2026-09-16 every `run.json` records its target, so the same question asked
of future archives is a real one. The failures-only archiving policy still limits
which runs are kept at all.

### The second half, fixed (2026-09-16): run.json records where the run went

`run.json` now carries `target: { environment, baseUrl, isDemoApp }` — the
Command Box's `RunTarget`, not a second shape — and `request.environment` is
taken from that same object instead of from `process.env.TEST_ENV`.

It is resolved **once**, in `playwright.config.ts`, from the same `env` that sets
every browser's `use.baseURL`, and handed to the reporter. The reporter does not
resolve anything itself: a second resolution could disagree with the first, and
reading `process.env` there would be this finding again.

A reporter given no target writes `target: null` and warns — not an omitted
field, which `JSON.stringify` would produce from `undefined`. The two mean
different things: `null` is a misconfigured producer, fix the config; absent is
an archive written before this field existed, unanswerable.

Held by `tests/unit/reporter-target.spec.ts` (R1–R4), checked by mutation with
the three controls correct:

| mutation                                     | verdict                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| label read from `TEST_ENV` before the target | caught (R1, R2)                                                          |
| target never recorded                        | caught (R1, R2)                                                          |
| missing target omitted instead of `null`     | caught (R3)                                                              |
| config records a URL other than the one used | caught (R4)                                                              |
| config records the wrong environment NAME    | caught (R4) — **survived the first version**, which checked only the URL |
| config re-reads `BASE_URL` separately        | survives, **declared in advance**                                        |

The declared survivor is a real limit, not an oversight: on this machine
`app.json` is `${BASE_URL}`, so a separately re-read value equals the resolved
one and no equality check can see provenance. The guarantee there is structural
— one `env` object feeds both — and R4 says so.

Verified end to end, not only in tests: a real run through the real config wrote
`{"environment":"app","baseUrl":"https://dmsuiv3.aitalkx.com","isDemoApp":false}`.
One trap on the way, worth knowing: **`--reporter=…` on the command line replaces
the config's reporters entirely**, so any run invoked that way writes no
`run.json` at all.

### Related

- [`phase-2-command-box.md`](phase-2-command-box.md) — the specification work that
  surfaced it; this is its requirement-5 hazard inverted, and the more dangerous
  direction.
- SEC-1 above — same week, same source: a field nobody had classified as input.
