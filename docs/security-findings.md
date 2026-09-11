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
