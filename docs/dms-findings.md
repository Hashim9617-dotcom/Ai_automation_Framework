# DmsSynergy findings

Issues observed in the target application (`https://dmsuiv3.aitalkx.com`) while
running the test suite in `tests/app/`, captured here because they live in the
app, not in our code. Not fixed — just documented with evidence.

---

## Finding 1 — `refresh_token` TTL is shorter than `access_token` TTL

**Observed.** Decoding the JWTs in the session saved by `pnpm auth`
(`artifacts/auth/app.json`, cookies/localStorage — values withheld, this is
timestamps only):

| Token | Location | Issued (`iat`) | Expires (`exp`) | TTL |
| --- | --- | --- | --- | --- |
| `access_token` | localStorage, JWT | 2026-08-20T10:40:21Z | 2026-08-20T11:40:21Z | 60 min |
| `refresh_token` | localStorage, JWT | 2026-08-20T10:40:21Z | 2026-08-20T10:55:21Z | **15 min** |
| `refresh_token` | cookie | — | 2026-08-27 | ~7 days |

The localStorage `refresh_token` — the one a silent-refresh flow would use to
mint a new `access_token` — expires in a quarter of the time the
`access_token` it's meant to renew stays valid. A refresh token is supposed to
outlive the access token it renews; here it's the reverse. Once 15 minutes
have passed since login, there is no live `refresh_token` left to use, so any
attempt to silently renew the session past that point cannot succeed —
independent of whether the `access_token` itself has expired yet.

**Suspected consequence.** Any user session — human or automated — that stays
active past the 15-minute mark loses the ability to silently renew. What
happens next likely depends on which `refresh_token` the client falls back to
(the longer-lived cookie one, if the client even reads it) and how the app
reacts to a failed refresh.

## Finding 2 — sessions observed dying mid-run, independent of test concurrency

**Observed.** A 45-test run of `tests/app/` was executed twice back-to-back
against the same saved session: once with `workers: 4` (the configured
default) and once with `--workers=1` (fully serial, no concurrent browser
contexts). Both runs produced an identical result — **15 passed / 27 failed /
3 skipped** — with the same 27 tests failing in both. If concurrent workers
were invalidating each other's session (e.g. via refresh-token rotation), the
serial run should have shown fewer failures. It did not, which rules out
worker concurrency as the mechanism.

The execution-engine's diagnostics fixture captures an accessibility snapshot
of the page (`context.domSnapshot`, including the page URL) at the moment of
every test failure. Every one of the 27 failures in the serial run — 27 out of
27 — was captured with:

```
url: https://dmsuiv3.aitalkx.com/login
```

i.e. by the time each failure was captured, the browser had already been
bounced to the login page, unprompted by the test. This happened across
unrelated features (admin forms, file explorer, global search, navigation,
upload) and was not clustered at one point in the run — failures started as
early as 40 seconds in and continued through to the 19-minute mark, interleaved
with tests that passed.

**Working theory, tying Finding 1 and Finding 2 together.** The session used
for this run was not freshly authenticated at the start of the run — enough
wall-clock time had elapsed since the last `pnpm auth` (across earlier runs
and manual investigation) that the 15-minute `refresh_token` window in
Finding 1 had already lapsed before this run began. If the app performs a
silent-refresh check on actions that hit its API (rather than on every route
change), that would explain the interleaving: navigation-only interactions
appear to keep working off the still-valid `access_token`, while
API-dependent actions trigger a refresh attempt that fails and forces a
hard redirect to `/login`. This is consistent with everything observed so far,
but has not been isolated to a single API call or confirmed with the app
team — it is the leading hypothesis, not a confirmed root cause.

**Not fixed.** This lives in the application's auth/token-issuance logic, not
in `tests/app/`. Recommend the DmsSynergy team either lengthen the
`refresh_token` TTL to safely exceed the `access_token` TTL, or confirm what
the intended behavior is if that asymmetry is deliberate.

## Finding 3 — the full suite cannot outlive one session, even a fresh one

The full `tests/app/` run takes roughly **19 minutes**. The `refresh_token`
TTL in Finding 1 is **15 minutes**. A session that is perfectly fresh at the
moment a run starts will still cross that 15-minute line before the run
finishes — so this is not only a "someone forgot to re-authenticate" problem.
Structurally, no single saved session — however recently obtained — can carry
a full run to completion under the current TTL, since the session dies partway
through purely from the run's own duration.

This is why the fix on our side (`tests/app/auth.setup.ts`, wired via
`dependencies` in `playwright.config.ts`) only buys a fresh *start*, not
immunity for the whole run — later tests in a full run can still legitimately
hit this expiry. That is exactly what `AppPage`'s `SessionExpiredError` guard
(`tests/app/pages/app.page.ts`) is for: when it happens, the run must call it
what it is — an environment/session failure — rather than let it be misread as
a locator bug, which is what consumed most of the effort chasing this down.
The durable fix is still on the application side: shortening the gap between
runtime and TTL doesn't fix the inversion in Finding 1.

## Finding 4 — `pnpm rca` would very likely have caught this on the first run

`RCA_AUTO=true` by default and the DMS environment ships with
`aiRootCause: true` (`config/env/app.json`), so root cause analysis runs
automatically after any failed run — *if* `ANTHROPIC_API_KEY` is set in
`.env`. It was not set during this investigation, so every RCA pass was
silently skipped (the platform logs and skips rather than writing empty
verdicts — see `README.md`, "Root cause analysis").

Had a key been configured, the very first failing run would have handed the
analyzer exactly the evidence that eventually solved this by hand:
`domSnapshot.url` sitting on `/login`, an empty accessibility snapshot, and
(per `docs/architecture-decisions.md` ADR-007 style cost control) one
LLM call per distinct failure fingerprint rather than one per test. The
`environment` category exists in the analyzer's taxonomy specifically for
this — a correctly-categorized verdict on run one would have pointed straight
at session expiry instead of the several hours spent manually distinguishing
27 "locator failures" from a dead session across multiple runs.

**Recommendation:** set `ANTHROPIC_API_KEY` before the next investigation of
this kind. It is a $ cost per run (bounded by `LLM_BUDGET_USD`), not a
one-time fix, so this is a process note, not something to "fix" once.

## Finding 5 — RETRACTED: root cause #2 was our own latency plus a real naming bug, not app instability

**Retraction.** Everything below this line was wrong about the mechanism,
though right that this wasn't a rendering-timing gap. Two follow-up
investigations settled it:

1. **The exact name was permanently unmatchable, not just stale.** The CDP
   accessibility tree showed the button's real computed name is a Private Use
   Area icon-font glyph (U+EB62, Tabler Icons) + space + "Create User" —
   `exact: true` against `"Create User"` could never match, at any point,
   under any timing. This is a locator bug, plain and simple — fixed by
   adding non-exact and `\b`-anchored regex fallback candidates (see
   `tests/app/pages/admin/users.page.ts` / `user-roles.page.ts`).
2. **The "present, then unresolvable" signature was our own latency, not the
   app.** With the impossible `exact: true` candidate still present as
   candidate 0, every resolution burned a full `LOCATOR_CANDIDATE_TIMEOUT`
   (8s) before falling through — so `expectCreateFormOpen()` followed by
   `expectCreateDisabled()` meant the second query started ~20–25s after the
   dialog opened, deep into whatever window Finding 2/3's session instability
   operates on. Once the dead candidate was removed and the working one
   promoted to the front, resolution became reliable and fast (consistently
   under 100ms, including repeated queries of the same key in the same test).
   There was no detaching, no remounting, nothing for `ElementDetachedError`
   (Finding 7) to catch here — it was never given a fair, fast test until
   this fix.

Net effect: this was two mundane, fixable problems stacked on top of each
other, not application instability. See admin.spec.ts's current pass rate
for the result.

**Original (superseded) text below, kept for the record:**

**Observed.** `UsersPage.expectCreateFormOpen()` / `UserRolesPage.expectCreateFormOpen()`
check the field above the submit button first (`username` / `name`), then the
submit button (`users.form.submit` / `roles.form.submit`). Telemetry
confirms the field above resolves quickly and reliably every time — the form
genuinely renders. The submit button then fails to resolve.

Two explicit-wait attempts were made directly on the submit button locator,
independent of `SmartLocator`'s own budget: 45 seconds
(`env.timeouts.navigation`), then 15 seconds (`env.timeouts.expect`). **Both
timed out**, and the failure screenshot for the 45-second attempt shows the
page reverted to the plain, undecorated list view — no dialog at all. The
create-form was open moments earlier (the field-above check proves it) and
was gone by the time either wait gave up.

**Conclusion: this is not "hasn't rendered yet."** A rendering-timing gap
predicts that waiting longer eventually succeeds. It did not, twice, at two
very different durations. Something makes the form become unavailable again
before the submit button is ever queried a second time. Root cause #2 is
genuine — the user's read on this was correct — but "genuine" here does not
mean "wrong candidate name" either: the name (`"Create User"` /
`"Create Role"`, `exact: true`) is confirmed correct at every point the button
has been observed. There is no candidate-chain fix available; adding a
"better" candidate cannot fix an element that briefly exists then doesn't.
Both explicit-wait attempts were reverted; the page objects are back to their
original state.

## Finding 6 — the trigger conclusion holds; the "present but unresolvable" framing doesn't (see Finding 5)

**Update.** The trigger-is-not-broken conclusion below is still correct and
was the right catch. But the "same present-but-unresolvable pattern as
Finding 5" framing inherited Finding 5's mistake — this was also a `Create`
button sitting on the identical PUA-icon-glyph naming bug, fixed the same
way (`tests/app/pages/file-explorer.page.ts`'s `dialogCreate`, non-exact +
`\b`-regex fallback candidates, impossible exact candidate removed). Re-ran
clean afterward: `file-explorer.spec.ts`'s create-workspace dialog test
passes.

**Observed (original investigation, still accurate for the trigger question):**
The hypothesis going in was that `files.dialog.create` fails
because the upstream trigger (`files.newWorkspace`, the "+ New workspace"
button) never actually opens the dialog. Telemetry from a clean run
contradicts this:

| Locator key | Result | Duration |
| --- | --- | --- |
| `files.newWorkspace` (trigger click) | resolved | 4728ms |
| `files.dialog.name` (name field inside the dialog) | resolved | 10ms |
| `files.dialog.create` (Create button) | **`LocatorResolutionError`** | timed out |

The trigger click succeeds, and the dialog opens fast enough that its name
field resolves in 10ms — proof the dialog is open, not merely attempted. The
failure captured in the same test's `domSnapshot` at teardown shows both
`"Create"` and `"Cancel"` buttons present, `enabled: true`, sitting right next
to each other in the element list.

**Conclusion (superseded by the update above): the trigger is not the broken
locator.** This part held up. The rest of this paragraph did not — see the
update at the top of this finding for what the real cause was and how it was
fixed.

## Finding 7 — PARKED design note: SmartLocator's third state was not observed in practice

**Status: not implemented, not being implemented.** State 3
(`ElementDetachedError`, below) was designed against a failure that, once
the actual cause was found (Finding 5), turned out to be ordinary locator
latency compounding our own resolution timing — not an element detaching or
a subtree remounting. Every admin-form submit button this design was built
around resolves in under 100ms, repeatedly, once the impossible `exact: true`
candidate and its 8-second timeout were out of the way. State 3 has never
been confirmed to occur on this app. `smart-locator.ts` stays untouched.

This section is kept as a design note, not a queued change: the reasoning
about *why* a resolution-history-based signal beats DOM-mutation quiescence
for telling "present, then unresolvable" apart from "never present" is still
sound, and worth having on file if a genuine instance of that failure mode
ever turns up. It should not be built speculatively against a symptom that
had a mundane explanation once actually investigated.

**Revision history.** The first draft of this proposal collapsed "not yet
rendered" and "present, then unresolvable" into one `NotYetRenderedError`,
distinguished from genuine absence by DOM-mutation quiescence. A trace-level
investigation of a live failure (below) showed that collapse — and the
quiescence signal — are both wrong. This version replaces both. (That
trace-level failure was itself later explained by Finding 5's latency +
naming bug, which is why this whole finding is now parked rather than queued
for implementation.)

**The problem.** `SmartLocator.resolve()` (`packages/execution-engine/src/locators/smart-locator.ts`)
walks each candidate with `waitFor({ state: 'attached', timeout: candidateTimeout })`
and, if every candidate fails, throws one undifferentiated `LocatorResolutionError`.
That single error class covers three situations, not two, and they call for
different responses:

1. **Never present.** Wrong role, wrong name, the app changed. Flag it, and —
   in Phase 2 — let `onHealRequested` try a replacement.
2. **Not yet present.** The region is still loading; every candidate will
   eventually match. Do not heal — nothing is wrong with the candidate, it
   just hasn't arrived.
3. **Present, then unresolvable.** The element existed — findable by name,
   correctly labeled — and later resolution attempts against the identical
   candidate fail. Do not heal here either, and for a sharper reason than
   state 2: healing this looks *successful* (something will match) while
   silently replacing a correct locator with one that happens to match
   whatever transient state is on screen at that instant. That candidate will
   rot on the very next run, now with no history explaining why it was ever
   added.

**Evidence forcing three states instead of two — from a trace, not a live
probe.** Per instruction, this revision is grounded in `pnpm exec playwright
show-trace` evidence for one reproduced failure
(`admin.spec.ts › the group picker stays disabled until a role is chosen`),
parsed directly from the trace's JSONL (`test.trace`, `0-trace.network`) and
its screencast frames — not another round of live probing.

- **Timeline:** click "New User" at `T+0`; the create-form's Username field
  resolves in 10ms; the wait for the "Create User" button starts and times
  out at exactly `candidateTimeout` (8000ms), throwing `LocatorResolutionError`.
- **Network** (`0-trace.network`): the last API call finishes *before* the
  wait even starts. Nothing fires for the full 8 seconds. No background
  refresh triggers this failure — that hypothesis is now ruled out for this
  case.
- **Screencast frames** (real pixel screenshots, not the trace's
  delta-encoded DOM snapshots — those turned out to reference shared/deduped
  subtrees and are unsafe to raw-text-search): the dialog fades in by 65ms
  after the click, fully settles ~1.7s in, and **produces zero new frames for
  the remaining 6+ seconds** — Chrome's screencast only emits on repaint, so
  this means the page was visually static. The frame at the moment of timeout
  is pixel-identical to the one 6 seconds earlier: dialog open, "Create User"
  button visible, blue, unchanged.
- **Markup** (chased through the trace's node references to the literal
  definition): a plain `<button type="button">` containing an icon and the
  text "Create User" — no `aria-hidden`, no role override, nothing
  structurally unusual.

So for this failure, specifically: the element did not detach, did not get
covered, and the page did not visibly churn during the window
`SmartLocator` was waiting. It was there, stable, standard markup, the whole
time — and still never resolved. That rules out "still rendering" (state 2)
just as firmly as it rules out "genuinely absent" (state 1). It is state 3,
but **not because the subtree was churning** — the opposite: it was
motionless. (A *separate*, earlier experiment — an explicit 45-second wait on
this same locator — did show the dialog fully closed by the time it gave up.
Whether that is the same mechanism running slower, or a second issue on a
longer timescale, is not something this trace resolves. Both possibilities
are worth keeping in mind, not collapsed into one story.)

**Why this kills the quiescence signal.** The original design proposed:
recent DOM mutations → still rendering → state 2; no recent mutations →
settled → state 1. That maps churn to "not yet rendered" and quiet to
"genuinely absent" — and this trace shows a state-3 case that is quiet, not
churning. Under the original design, this exact failure would have been
classified as state 1 and handed straight to the healer — precisely the
failure mode we're trying to prevent, produced by the mechanism meant to
prevent it.

**Revised design (still not implemented — for review before any code changes):**

*Phase 1 — unchanged.* Walk candidates exactly as today, one
`waitFor({ state: 'attached', timeout: candidateTimeout })` per candidate in
order. Fast path, covers the overwhelming majority of resolutions.

*Phase 2 — new, entered only if every candidate in Phase 1 failed.*

1. Take a lightweight "was this ever findable in this test?" reading before
   deciding anything: `SmartLocator` already reports every successful
   resolution via `onResolved` (`LocatorResolution`, keyed by `spec.key`). If
   *this exact key* resolved earlier in the same test — not a different key,
   not a guess, the actual telemetry record — and now every candidate fails,
   that is direct, structural evidence for state 3: it does not depend on
   inferring intent from mutation timing at all, and it is exactly what
   happened here (the create-form's other fields resolved; this key did not,
   after having every reason to). Throw `ElementDetachedError` immediately in
   this case; do not run the grace-period race.
2. Otherwise (never resolved this key before in this test — so state 3's
   "was findable" precondition cannot apply): race every remaining candidate
   together against one additional bounded budget (`renderGraceMs`, mirroring
   `LOCATOR_CANDIDATE_TIMEOUT`'s existing env-override pattern). If anything
   resolves, return it — log a warning that it needed the grace window.
3. If the grace window also expires: run one supplementary check with a
   *looser* query than the exact candidate — same role, substring name match
   instead of exact, or (falling back further) a plain
   `document.querySelectorAll` text/tag scan in the style of
   `captureDomSnapshot`. If something plausible turns up under the loose
   query that the strict query never matched, that is a live presence
   mismatch, not silence — the same signature this trace found by hand.
   Throw `ElementDetachedError`.
4. If even the loose check finds nothing: genuinely never there.
   `LocatorResolutionError`, exactly as today; `onHealRequested` may fire.

This drops mutation-quiescence entirely — it distinguished the wrong axis.
States are now told apart by *resolution history and presence-under-a-looser-query*,
not by whether the page was moving.

**New error classes:**
- `NotYetRenderedError extends PlatformError` (code `NOT_YET_RENDERED`) — state 2.
- `ElementDetachedError extends PlatformError` (code `ELEMENT_DETACHED`) — state 3.

Both carry the same `key` / `description` / `url` context `LocatorResolutionError`
does today. `onHealRequested` must only ever be reachable from the
`LocatorResolutionError` branch — never from either new class. The
reporter/RCA analyzer should file both under an `environment`/instability
category, the same treatment `SessionExpiredError` needs, not `selector`.
`ElementDetachedError`'s message should say so plainly: "the app reported
this instance as gone, not that the locator is wrong" — this is a report of
suspected application instability, matching how Finding 6's "Create" button
and Finding 8's workspace tile behaved.

**What this would have told us, retroactively:** the original tree-row
failures would very likely still come back `NotYetRenderedError` (never
resolved that key before in-test; genuinely still populating, per `pnpm
inspect`). This trace's group-picker failure would now correctly come back
`ElementDetachedError` via the resolution-history check in step 1 — not
`LocatorResolutionError` misclassified as either of the other two.

**Open questions, unchanged in kind, updated for the new design:**
- The resolution-history check (step 1) needs the per-test telemetry list
  threaded into `SmartLocator` itself, or a small per-key cache alongside it
  — currently `onResolved` is fire-and-forget outward to the fixture, not
  readable back.
- The loose-query fallback (step 3) needs its own small implementation
  (nearest to `captureDomSnapshot`'s heuristic) — worth confirming it stays
  cheap, since it only runs after Phase 2 already failed, not on every call.
- `renderGraceMs` still needs a default and an env override
  (`LOCATOR_RENDER_GRACE_MS`?).
- Still open: *why* the accessibility-tree/role query fails to resolve a
  structurally unremarkable, visually stable button. Nothing in this
  proposal explains that — it only makes sure the resulting error is
  reported honestly instead of being misread as a bad locator. Getting to
  the actual mechanism likely needs Playwright-internal or CDP-level
  investigation, or the DMS team's input on their modal implementation.

Not implemented. Flagging for review before writing any code against
`packages/execution-engine/src/locators/smart-locator.ts`.

## Finding 8 — RETRACTED (fully): the workspace tile was never broken; the wizard auto-advances and the test/page-object model was wrong

**This finding is retracted in full, following two more rounds of scrutiny.**
Everything in this entry's history — the original "clicking does nothing"
claim, and the "click registers but state-binding is broken" update that
followed it — was wrong about the mechanism. Kept below for the record, in
the same spirit as Finding 5/6/9's retraction history.

**What actually happens, confirmed live, cleanly, reproducibly.** Clicking
the workspace tile with a normal `locator.click()` (no raw mouse events, no
special handling) makes the wizard **immediately advance to the Folder
step** — not "select the workspace and wait for a manual Next." Confirmed
three independent ways in one session:

1. The wizard's own tab state: `getByRole('tab', { name: 'Workspace' })`'s
   `aria-selected` flips from `"true"` to `"false"`, and `Folder`'s flips to
   `"true"`, within ~1.5s of the click.
2. The page itself: `getByText('Select destination folder')` (the Folder
   step's own heading) becomes visible.
3. A full-page screenshot after the click, showing the wizard's breadcrumb
   at step 2 ("Folder"), with a folder list ("ABCD (root)", "auto Test 123")
   already rendered.

**Why every earlier round missed this.** Both the original investigation
and the "state-binding bug" update stared exclusively at the tile's own
checkmark and the page's *first* `Next` button — never at which step the
wizard was actually on. Once the workspace step auto-advances, `.ti-check`
inside the old (now-departed) workspace grid genuinely does become
unqueryable — not because of a state-binding failure, but because that
whole grid is gone, replaced by the Folder step's UI. And `Next` staying
"disabled" after the click was real, but it was the **Folder step's** Next
(correctly disabled, no folder chosen yet) being re-queried by a generic
`getByRole('button', { name: 'Next', exact: true })` locator that has no
way to know the step changed underneath it. Every symptom in both earlier
write-ups is explained by this, with no state-binding defect required.

**What was actually broken: the test's model of the flow, not the app.**
`upload.spec.ts`'s three failing tests all called `chooseWorkspace()`
*and then* `goNext()` (or asserted `expectNextEnabled()` on what they
assumed was still the workspace step) — an extra, unnecessary advance that
either hung for the full action timeout clicking a legitimately-disabled
Folder-step Next, or asserted the wrong step's button state entirely.
**Fixed** in `upload.spec.ts`: the redundant `goNext()`/`expectNextEnabled()`
calls immediately after `chooseWorkspace()` are removed, and the "will not
advance" test now asserts the real contract — `Next` stays disabled with no
workspace chosen, and choosing one advances the wizard to the Folder step
(`step('Folder')`'s `aria-selected` becomes `"true"`) — rather than
asserting a same-step `Next` enablement that was never the actual UX.

**Confirmed.** Two of the three previously-failing `upload.spec.ts` tests
now pass reliably (2 repeats, both clean): "will not advance until a
workspace is chosen, and auto-advances once one is", and "Back returns to
the previous step". See Finding 14 for the third.

**Not reported to the DMS team — because there is no longer a claim to
report.** This is now a fixed test, not an app defect.

**Original entries, both wrong about the mechanism, kept for the record:**

*Original claim ("clicking the workspace tile has no observable effect"):*
The scoping hypothesis (`option()`'s unscoped `.first()`) was tested and
ruled out — one correct, unambiguous match every time. Clicking it, tried
three ways, "succeeded" with no error but produced no observable change in
the checkmark or `Next`'s disabled state over a 10-second poll.

*First update ("the click registers but state-binding is broken"):* Tested
against Finding 11's wrapper-vs-inner-control hypothesis via CDP and ruled
it out (the tile is a single atomic `<button>`, no nested control). Then
instrumented the click and found it fires a real, workspace-scoped network
request — interpreted as "the handler runs but never updates UI state."
Both the ruling-out of Finding 11's mechanism and the network-request
observation were correct and are still true; the interpretation built on
top of them (a state-binding defect) was not — the missing piece both times
was checking which step the wizard was actually on.

**Original investigation, still accurate below:**

**Hypothesis going in.** `UploadFilesPage.option(name)` —
`this.page.getByRole('button', { name }).first()` — has no container scope,
so the working theory was that `.first()` matches a same-named button
elsewhere on the page, "succeeding" without actually selecting anything.

**Tested directly against the live app, four ways:**

1. `getByRole('button', { name: 'ABCD' })` (exactly what `option()` uses)
   returns **1 match** on initial page load — no duplicate, no scoping
   collision. Its class (`syn-select-grid-card`) and full markup confirm it's
   the workspace tile, a plain `<button>` with no nested inputs to
   mis-target.
2. Its real accessible name is `"ABCDABCD"` — the display name literally
   concatenated with itself, no separator — not `"ABCD\nCODE"` as the
   existing code comment assumes. `option()`'s non-exact substring match
   still finds it correctly; this just means `exact: true` would not have.
3. Clicking that single, correctly-identified element — tried as a plain
   `.click()`, a `.dblclick()`, and a raw `page.mouse.click()` at the
   element's exact bounding-box center — **never changes the selection
   checkmark's color and never enables Next**, polled continuously for 10
   seconds after each attempt.
4. A second workspace ("CAD") matched an element with a completely different
   shape (a 956×47px full-width row vs. "ABCD"'s 76px-tall grid card) on a
   fresh page load — the picker's own layout is not consistent between
   loads, independent of anything the test does.

**Conclusion.** The scoping hypothesis is disproven — there was one, correct,
unambiguous match every time. The click reaches the intended element and
"succeeds" with no error, but produces no observable effect on selection
state, through three different click methods. This is not a locator problem
a page-object change can fix. It reads as either a genuine defect in this
picker's click/selection handling, or a difference between how Playwright's
automated click and a real pointer interaction register with whatever this
component listens for — worth investigating on its own, most likely by the
DMS team, before any test-side change is attempted here.

**Not fixed.** `tests/app/pages/upload-files.page.ts` is untouched.

## Finding 9 — RETRACTED: the admin create-forms were never missing validation; the tests were asserting the wrong contract

**What was assumed.** The original admin.spec.ts tests ("...will not submit
while empty") asserted that Create buttons stay `disabled` until required
fields are filled. Groups' button was observed enabled with an empty form
and — before Finding 5 was corrected — was read as a genuine validation gap,
distinct from Users/Roles' resolution failures.

**What was tested.** One deliberate, scoped action, run once, on the Roles
form only: opened the create-role dialog, left every field empty, clicked
Create, and captured network activity, on-screen state and dialog state
before touching anything else. No record was created — the dialog never
closed, so there was nothing to clean up.

**Observed:**
- **Zero network requests fired.** The click never reaches the backend with
  an empty form.
- **The dialog stayed open** — `.syn-doc-modal` count unchanged.
- **Inline validation appeared per empty required field:** "Name is
  required", "Code is required", "Portal is required", each in red beneath
  its field, confirmed both in the DOM text and visually (screenshot).

**Conclusion.** This app validates on click, not by disabling the submit
button ahead of time — a legitimate, common form-UX pattern, and a
completely different (and correct) contract from what `toBeDisabled()` was
checking for. The Create button being enabled on an empty form was never a
bug. It was our test's assumption about *how* validation should be
implemented, asserted as if it were the app's specification. Retracting the
Groups-specific "missing validation" reading entirely — there is no
inconsistency between the three admin forms; all three follow the same
validate-on-click pattern.

**Update — Users and Groups independently verified, not inferred.** A
follow-up pass repeated the same deliberate, scoped probe on both remaining
forms (still zero records created — both dialogs stayed open). The
mechanism is identical across all three (no network request, dialog stays
open, inline messages appear), but **the wording is not uniform**:

| Form | Required-field messages |
| --- | --- |
| Roles | "Name is required", "Code is required", "Portal is required" |
| Groups | "Group name is required" (not "Name"), "Portal is required" |
| Users | "Username is required", "Password is required", "First name is required", "Last name is required", "Email is required", "At least one user role is required", "At least one portal is required" |

Users' two multi-select fields (User Role, Portal) use an "At least one …
is required" phrasing distinct from the plain "<Field> is required" pattern
every single-value field on all three forms uses — worth knowing if writing
a fourth admin form's tests from this one as a template. Each form's test
now asserts its own verified message list; a generic "some text containing
'is required' is visible somewhere" check was written first, then replaced
once the real strings were confirmed, so no test is asserting an assumed
pattern anymore.

**Fixed in test code**, not documented as an app finding to escalate:
`admin.spec.ts`'s three "will not submit while empty" tests are renamed to
"...shows validation errors instead of submitting when empty" and now assert
the real contract — inline error text appears, the dialog stays open, no
network call fires (implicitly, by the dialog remaining open). The
"Clear empties a partially filled role form" test now checks the field value
is actually empty after Clear, rather than checking button state, which this
form never used as a signal in the first place.

## Finding 10 — proposal: normalise accessible names in the locator layer, so `exact: true` stops being a landmine repo-wide

**The pattern behind Finding 5/6.** The root cause in both was not specific
to `Create User` / `Create Role` / `Create`: this app renders many buttons as
an icon (Private Use Area icon-font glyph, e.g. U+EB62) plus a space plus a
visible label. `element.textContent` and the CSS-rendered pixels don't show
the glyph — only the real accessibility tree does — so any `exact: true`
candidate against the visible label text is silently, permanently
unmatchable, and nothing about it looks wrong until someone checks the
computed name via CDP.

**Scope.** An audit of every `exact: true` locator in `tests/app/pages/`
found **39 occurrences**. Of those: 14 are confirmed working (verified by
passing tests this session — mostly icon-free nav/text buttons and the
already-fixed trio), 3 are already fixed (Finding 5/6), 1 is already known to
misfire in production use (`login.page.ts`'s `Sign In` button — the
platform's own logs show it silently falling back to a CSS candidate on
every run), and **21 are unverified** — the same shape of risk, untested
either way. Hand-writing a `\b`-anchored regex fallback for each of the
remaining 21 (and any future ones) works, but treats the symptom one locator
at a time forever.

**Proposed design (not implemented — for review before any code changes):**
normalise the computed accessible name *before* any comparison happens,
inside the strategy-building step in `packages/execution-engine/src/locators/smart-locator.ts`'s
`build()` — or, better, inside a small helper `SmartLocator` calls for every
`role` candidate's `options.name`, so plain `getByRole` calls elsewhere in
page objects (the ones outside the `LocatorSpec` system, e.g.
`file-explorer.page.ts`'s `treeNode()`, `contentTile()`) can opt into the
same helper without going through the full candidate-chain machinery.

```ts
// Private Use Area (icon-font glyphs, e.g. U+EB62) + zero-width space
// (U+200B) + zero-width no-break space / BOM (U+FEFF).
const PUA_AND_ZERO_WIDTH = /[\u200B\uFEFF\uE000-\uF8FF]/g;

function normaliseAccessibleName(name: string): string {
  return name.replace(PUA_AND_ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}
```

This cannot change what Chrome's accessibility tree actually computes (that
is real, and Playwright's `name` matching queries it directly) — so this
would not make `exact: true` match the *raw* computed name. What it changes
is what candidates should be *authored against*: if `SmartLocator` exposes
(or `captureDomSnapshot` and `pnpm inspect` report) the **normalised** name
rather than the raw one, every future hand-written `exact: true` candidate
gets written against `"Create User"`, never against `"  Create User"`
that nobody can see to type correctly in the first place — removing the
landmine at the source, for every locator written from now on, not just the
four already hit. It does not retroactively fix the 21 unverified locators
above (their real names are unknown until checked), but it means checking
them stops being a game of finding invisible characters by hand.

**Open questions, for review, not yet resolved:**
- Should normalisation apply only to how `pnpm inspect` / `captureDomSnapshot`
  *report* names (so authors write correct candidates going forward), or
  should `SmartLocator` also try a normalised-name match as an automatic
  extra candidate step (closer to a real fix, but a bigger, riskier change to
  matching semantics)? Leaning toward the former first — it is much smaller,
  and Finding 5/6 show that once the real name is known, a plain non-exact
  or `\b`-anchored candidate is enough; the missing piece was *visibility*
  into the real name, not a smarter matcher.
- Whether to also warn (once, at candidate-authoring or healing time) when an
  `exact: true` candidate's target contains characters in `PUA_AND_ZERO_WIDTH`
  that a raw-text read would never surface, so this class of bug gets caught
  before it ships rather than after a test fails in a confusing way.

Not implemented. `smart-locator.ts` untouched, alongside Finding 7.

## Finding 11 — root cause of the file-explorer tree failures: `treeitem` accessible names include their nested chevron and menu-trigger labels

**What was assumed going in.** The upload-wizard scoping hypothesis (Finding
8) — that an unscoped `.first()` was matching the wrong element.

**What was actually true, confirmed live via CDP `Accessibility.getFullAXTree`
against `/files`.** A workspace row's computed accessible name is not its
visible label. Each `treeitem` nests an "Expand"/"Collapse" chevron button
and a "More options" button, and ARIA's name-from-content computation
concatenates every descendant's own accessible name into the parent's. So
the row visibly labeled "ABCD" has a real computed name of
`"Collapse ABCD More options"` (expanded) or `"Expand ABCD More options"`
(collapsed) — confirmed for all 25 workspace rows on this instance, every
one following the same `(Expand|Collapse) <name> More options` shape.
`getByRole('treeitem', { name, exact: true })` (`FileExplorerPage.treeNode`)
could therefore never match any row, at any point — not PUA-glyph poisoning
this time (the names are plain ASCII), but the same underlying lesson as
Finding 10: the rendered label and the accessibility-tree name are not the
same string, and `exact: true` only ever sees the latter.

**Blast radius.** Every test that calls `treeNode()` or `openWorkspace()`
failed, reproducibly, on both the initial attempt and the retry — 7 of
`file-explorer.spec.ts`'s tests: filtering the workspace list, opening a
workspace, bulk-action disabled state, grid/details view switch,
Current/Archive/Bin scope switch, and both context-menu tests.

**Fixed in test code.** `FileExplorerPage.treeNode()`
(`tests/app/pages/file-explorer.page.ts`) now matches a `RegExp` anchored on
both ends: an optional `(Expand|Collapse )` prefix (a leaf row with nothing
to expand may omit the chevron), the literal name, then `More options` at
the end. The `$` anchor is load-bearing, not decorative — a plain substring
or `\b`-bounded match would still collide (e.g. `test` is a whole word
inside `"Expand test 123 More options"`, a different row's real name), so
only anchoring the tail after the name to the literal `More options` (rather
than just requiring a word boundary) disambiguates `"test"` from
`"test 123"`. Re-ran clean afterward: all 7 previously-failing tests pass
(one showed one-off flakiness on the context menu's close animation,
unrelated to this locator, and passed on retry).

**Not an app defect.** Concatenating nested-control names into a tree row's
accessible name is unusual but not nonconformant ARIA — the fix belongs in
the test's locator, which is where it was made.

## Finding 12 — two of three flaky/failing tests root-caused and fixed; the third fix was reverted for insufficient evidence

Three separate issues, previously showing up as 2 flaky-recovered tests plus
1 outright failure. Diagnosed individually rather than patched generically —
"flaky" was masking unrelated causes, and one of them turned out to need
more evidence than it got on the first pass.

**1. `file-explorer.spec.ts` "cancelling leaves the tree untouched" — test
design, not app or locator. Fixed.** Asserted `workspaceCount() === before`
after opening-then-cancelling the create-workspace dialog. Observed
directly: the count drifted 24 → 25 mid-test with `ALLOW_WRITES` unset and
no write test running — this is a shared, live environment, and another
user's concurrent workspace change moves the total independent of anything
this test does. An exact-count assertion here was chasing a moving target
that has nothing to do with whether Cancel worked. Fixed to assert the one
thing Cancel actually promises and that no other actor can produce a false
positive or negative on: the specific workspace we typed into the dialog
does not exist afterward (`expect(explorer.treeNode(name)).not.toBeVisible()`).

**2. `file-explorer.spec.ts` "a workspace menu offers its documented
actions" — wrong dismiss mechanism in the test, AND a real (minor) app gap.
Both recorded; the test is fixed.** `dismissMenu()` pressed `Escape`.
Tested live, in isolation: the menu is still visible a full 2.5s after
`Escape`, every time — not a timing race, `Escape` simply does not close
this menu. It also has no dedicated backdrop element behind it (checked the
DOM directly); it closes via a global outside-click listener instead. Fixed
`dismissMenu()` to click a confirmed-safe, empty, non-interactive point on
the page shell instead of pressing `Escape`. Separately — see Finding 13 —
the app itself not responding to `Escape` on a `role="menu"` widget is a
genuine, if low-severity, WAI-ARIA gap, not purely a test problem.

**3. Intermittent `LocatorResolutionError` on single-candidate nav locators
(`nav.fileExplorer`, `nav.upload`) at the very start of a run — diagnosed,
"fixed" with a base-class retry, then reverted.** The fix that shipped in
the previous commit wrapped every `BasePage` action helper
(`click`/`type`/`selectOption`/`textOf`/`isVisible`/`expectVisible`) in a
retry around locator *resolution* specifically, reasoning that
`SmartLocator.resolve()`'s single `candidateTimeout` window (2s) was too
tight for a page's first render under real 4-worker concurrency at run
start. That reasoning was never actually verified and does not hold up:

- The only evidence was indirect — the failures recovered on Playwright's
  own whole-*test* retry (a fresh page navigation from scratch), which is
  not evidence that waiting longer *at the same point in the same attempt*
  would have worked. No trace or CDP snapshot was captured to check whether
  the element was genuinely still-rendering at the moment of failure, the
  way Finding 5's trace investigation or Finding 11's CDP dump did before
  either of those was called fixed.
- `expect(locator).toBeVisible()` already retries internally (a Playwright
  web-first assertion polls up to its own timeout) — the added retry
  wrapped `find()`'s attach-wait instead, which is a different, redundant
  layer, not a fix to the thing that already retries.
- Structurally, a base-class change is the wrong altitude for a fix that
  isn't even confirmed yet: it silently changes resolution behavior for
  *every* locator in the suite, which converts intermittent failures into
  passes suite-wide — exactly the effect this findings log has spent three
  days working against, since a red test misclassified as flaky (and then
  quietly retried away) is worse than a red test left red.

**Reverted.** `packages/execution-engine/src/pages/base.page.ts` is back to
its original, pre-session state — no retry wrapper, `find()` and every
action helper unchanged. This root cause is **open, not fixed.** The
correct next step, if it recurs, is the same method used for Finding 11:
capture a trace or CDP snapshot of a live failure and check directly
whether `nav.fileExplorer`/`nav.upload` is present-but-slow or genuinely
absent at the moment `LocatorResolutionError` fires, then fix at the
narrowest correct altitude (the specific locator or call site) — not the
shared base class — once that's known.

## Finding 13 — the File Explorer's context menu does not close on Escape (WAI-ARIA menu pattern gap)

**Severity: low.** A real, if minor, app-side accessibility issue — not a
test bug, and not a locator problem. Recorded here rather than only fixed
in test code because, unlike most findings in this document, this one is
about the app's own behavior, not this suite's.

**Observed.** Opened a workspace's context menu (`role="menu"`) on
`/files`, then pressed `Escape` in isolation — no other action in between.
The menu was still visible, unchanged, a full 2.5 seconds later. Confirmed
this isn't a timing issue: clicking anywhere outside the menu closes it
immediately (it has no dedicated backdrop element; it closes via a global
outside-click listener), so the menu *can* be dismissed programmatically —
`Escape` specifically is simply never wired to do it.

**Why this matters.** The [WAI-ARIA Menu Button
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) specifies
`Escape` as the standard way to close an open menu and return focus to its
trigger, for keyboard-only and screen-reader users who may not have an easy
"click elsewhere" gesture available. A `role="menu"` widget that only
responds to a mouse-driven outside click, not the keyboard convention every
other ARIA menu implementation honors, is a real (if narrow) accessibility
gap.

**Not fixed** — this lives in the application's menu component, not in
`tests/app/`. `FileExplorerPage.dismissMenu()` (Finding 12, item 2) already
works around it on the test side by clicking outside instead of pressing
`Escape`, which is why this is filed as a low-severity note rather than a
blocking one.

## Finding 14 — OPEN, not yet root-caused: folder-step selection is inconsistent after the workspace auto-advance

**Status: observed, not explained. Deliberately not called an app bug or a
test bug yet** — this needs the same trace/CDP-level rigor that got Finding
8 retracted twice, not a third guess.

**What was observed**, investigating the one `upload.spec.ts` test Finding
8's fix didn't resolve ("reaches the upload step and refuses to submit an
empty upload," now marked `test.fixme` rather than left failing or forced
green):

- Landing on the Folder step (via the now-understood workspace auto-advance,
  Finding 8), `Next` starts disabled — expected, matches this app's own
  "root is preselected on some workspaces" behavior needing a click first.
- Clicking the already-highlighted "ABCD (root)" row: polled `Next`'s
  disabled state for up to 8 seconds afterward. Still disabled the whole
  time. The row's highlight, present before the click, was gone afterward.
- Clicking a different, non-highlighted row ("auto Test 123") in a separate
  run: fired `GetFoldersAndDocumentsByFolderId` for that folder, then —
  roughly 9 seconds later — `GetPermittedWorkspaceList` and
  `DocumentTemplate/GetAll` fired again, the same two calls seen on the
  *initial* landing on the Workspace step. The wizard's tab state afterward
  confirmed it: `Workspace` was `aria-selected="true"` again — the wizard
  had returned to step 1, not advanced to step 3.

**Why this isn't a finding yet.** Three different things happened across
three attempts (stays put and disabled; row un-highlights; wizard resets to
step 1) and none were followed to a network/console/DOM explanation the way
Finding 11's tree-row bug or Finding 8's actual mechanism were. It's
consistent with several different real explanations — a genuine app defect
in folder selection, a race between the two auto-refetches also seen here
and whatever renders the folder list, or a test-side timing/selector issue
in how "auto Test 123" or "root" get clicked — and asserting any one of
those without evidence would repeat exactly what happened to Finding 8
twice already.

**Next step, if picked up again:** a trace (`pnpm exec playwright
show-trace`) of one reproduced failure, read the way Finding 7's trace was
— network timeline, screencast frames, and the AX tree at the moment
`Next` should have enabled — before drawing any conclusion.

## Finding 15 — an absence claim needs a completeness guarantee over whatever it counts across

**Discovered while auditing name truncation, not while looking for it.** The
self-healing verification step's one guarantee is `matchCount === 1`: the
proposed locator matches exactly one node in the captured accessibility tree.
That is what a human is told they can trust without re-checking, and it is the
whole reason `propose()` is allowed to exist alongside "never heal
automatically".

**The problem.** `matchCount === 1` is really two claims: *this* node matches
(presence), and *no other* node matches (absence). Presence is established by
what the capture contains. Absence is not — it depends on the capture being
**complete**. `captureAccessibilityTree` caps at `maxNodes` and sets
`truncated: true` when it hits the cap, and until 3 Sept 2026 nothing in the
healing path read that flag. So a proposal verified against a tree cut off at
its cap could have a second match sitting past the cutoff, and would still
report `matchCount: 1`.

Nothing was observed to have gone wrong — the fixtures captured with the
default cap of 500 and the largest tree measured across twelve DMS states was
~400 nodes. But "we were under the cap in the cases we happened to measure" is
not a guarantee, and the failure would have been silent and confident, which is
the shape this project keeps getting bitten by.

**The general rule, which is why this is written down as a finding rather than
a commit message:**

> Any claim of the form "there is no X" is only as strong as the completeness
> of the thing you looked in. Before asserting absence, check whether your view
> was truncated, filtered, capped, paginated or sampled — and if it was, say
> "unknown", not "none".

This is not specific to accessibility trees, or to healing. The same shape
appears wherever the codebase reasons over a bounded capture:

- The healing gate's **rule 4** already got this right for the DOM snapshot —
  *"absence proves nothing in a truncated view"* — which is exactly the same
  reasoning applied one layer down. The gap was that nobody carried it across
  to the AX snapshot, which is the capture verification actually reads.
- `DomSnapshot.elements` is capped at `maxElements`, so "this page has no
  Submit button" is unsafe from a truncated snapshot.
- `accessibleName()` caps a name at 80 characters, so "this name differs from
  that one" is unsafe when either side was clipped — the same bug in
  miniature, which produced a phantom "fatal" divergence in the first name
  audit (fixed by flagging truncation at the capture: see
  `DomSnapshot.elements[].nameTruncated`).
- Step 3's generator (`docs/phase-2-generation.md`) will inherit it wholesale:
  its `CONTRADICTED` grade is an absence claim ("no node supports this"), and
  it must not be reachable from a truncated capture.

**Fixed.** `LlmSelfHealingEngine.propose()` refuses outright on
`axSnapshot.truncated` rather than reporting an unprovable uniqueness, and the
fixtures' capture raises `maxNodes` to 1000 so refusing stays rare — otherwise
the fix trades a false guarantee for a healer that never proposes, which is a
different way of being useless.

**Not an app defect.** Entirely our own reasoning, in our own verification
step.
