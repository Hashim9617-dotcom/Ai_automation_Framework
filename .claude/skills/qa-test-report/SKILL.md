---
name: qa-test-report
description: Turn raw QA test-run output — run logs, pass/fail lists, defect notes, or automation output — into a clean one-page weekly QA report. Use whenever the user pastes raw test results and wants them summarized into a shareable report.
---

# QA Test Report

Turn raw test-run output into a clean, consistent one-page QA report that says
only what the input can back.

## When to use

The user pastes raw test results — a run log, a pass/fail list, defect notes,
automation output, or rough notes — and wants a report they can send.

## Steps (follow every time)

1. Read the raw results once, top to bottom, without editing. For structured
   output (e.g. `run.json`), read each failure's context too — page errors and
   DOM snapshots often settle whether a failure is the product or the
   environment.
2. For each run, establish **what it was**: the suite that actually ran (unit,
   API, UI…), the environment label, and the target URL. A label is not a
   target: a run can be labelled with the application's environment and run
   nothing that touches the application.
3. Pull the numbers **per suite**: total, passed, failed, flaky, skipped.
   Count tests, not result rows — a retry repeats a test. Check that passed +
   failed + skipped equals the total; if it does not, say so in the Summary.
4. Find **what did not run**. Tests behind a failed setup step are often absent
   from the output entirely — not counted as skipped or blocked, just missing.
   Name them, and say "count unknown" when the input does not give it.
5. Group failures by area, not run order. For each: what failed, the evidence,
   severity, status, and whether it is product, environment, or undetermined.
6. Write into the fixed format below.

## Output format

```
# QA Test Report — [Product under test] — [Date or date range]

## Summary
[Suite] · [env label] → [target, or "target not recorded"]: [P]/[N] passed ([X]%), [F] failed, [K] flaky, [S] skipped — [date of run, "latest of n"]
(one line per suite and target, from its most recent run — never a rate pooled
across suites, and not one line per run: earlier runs that differ are covered
under Failures or Notes)
Did not run: [what, why, count or "count unknown"] — or "nothing known to be missing"
Release status: [Go / No-go / At risk / Not assessable] — one-line reason naming the evidence.

## Failures by area
### [Area]
- [What failed] — [evidence, one clause] — Severity: [as stated, or TBD] — Status: [as stated, or TBD] — [Product / Environment / Undetermined]

## Environment / flaky
- [What] — [the evidence that makes it environment or flaky]

## Action items
- [Owner, or TBD] — [what needs to happen] — [due, or TBD]

## Notes
- Context worth carrying to next week.
```

## Rules (hold constant)

- **A pass rate names its denominator: one suite, one target, a test count.**
  Never pool suites into one rate. The test platform's own unit tests are not
  evidence about the application under test, whatever environment the run is
  labelled with.
  _Measured 2026-09-17: pooling a week's five runs put "99.0% pass rate" in the
  Summary. 465 of the 482 tests were the platform's unit tests; the
  application's figure was 4/6, and its logged-in suite never ran at all._
- **Never recompute a rate with environment or flaky failures removed.** List
  them separately and leave the rate as measured. Moving a failure out of the
  denominator only ever makes the number better.
- **Environment / flaky needs evidence from the input**, cited inline:
  connection refused, an unreachable target, a retry that passed. Without
  evidence the failure is "Undetermined" and stays under Failures.
- **"Did not run" is always stated.** Missing results are not passes, and "no
  results" is never reported as "no failures". If the input is truncated,
  unreadable or empty, the report says that and nothing else.
- **Release-blocking is about impact, not a severity label.** A failure is
  release-blocking if it is stated Critical/High **or** it stopped other tests
  from running. Either way it goes in the Summary. Use "Not assessable" when
  the tests that would decide release did not run and no failure is known to be
  real; "No-go" needs a failure that is.
- **Severity, status, owner and due date come from the input or are "TBD".**
  Never infer "New" from the earliest run you were given — an archive has a
  retention window, so the first run you can see is not when a failure started.
  "Fixed" items do not belong under Failures.
- **Record the target next to the label for every run.** If only an error
  message reveals the target, say so. If the label and the target disagree,
  that goes in the Summary.
- **Use only the input given.** Anything drawn from elsewhere (git history,
  tickets, memory) is labelled with where it came from.
- Keep it to one page. When it overflows, cut Notes first, then per-test detail
  on passing suites. Never cut the Summary's rate, Did-not-run or Release lines.
  Neutral tone, no filler.
