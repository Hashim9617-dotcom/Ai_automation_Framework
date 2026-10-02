# QA quickstart

> ## This kit is for DMS + new applications (see [ADD-AN-APPLICATION.md](ADD-AN-APPLICATION.md))
>
> **DMS works out of the box.** The Playwright specs under `tests/apps/dms/` were
> written against DmsSynergy — its sidebar, its upload wizard, its admin screens —
> and they stay there. Point the platform at a different application and `pnpm test`
> collects **no** specs for it and says so:
>
> ```
> No specs for application "acme": tests/apps/acme/ does not exist.
> ```
>
> That is the protection, not a limitation. Before it, any non-DMS environment
> collected all 47 DMS tests and would have run DMS's page objects — `@write` tests
> included — against your application.
>
> **A second application is now a supported thing to add**, and it is data, not code:
> an environment file, `config/apps/<name>/`, `tests/apps/<name>/`, and its own
> captures under `artifacts/<name>/`. Every tool takes an explicit `--app`, every
> interactive tool prints the application, environment and host it resolved before it
> does anything. [ADD-AN-APPLICATION.md](ADD-AN-APPLICATION.md) is the page for that;
> follow this one first.
>
> `pnpm auth`, `pnpm inspect`, `pnpm triage` and `pnpm verify` are not DMS-specific
> and work against any target.

This is the short version for a QA joining the project on Windows. It gets you to
four things you can run today:

| you can                                      | command                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| sign in once and save the session            | `pnpm auth`                                           |
| walk the screens and record them             | `pnpm inspect`                                        |
| ask which sheet rows could ever be automated | `pnpm triage "<path>" --app dms`                      |
| check the whole repo is healthy              | `pnpm verify`                                         |
| run the existing Playwright tests            | `pnpm test:demo` (no credentials), `pnpm test` (live) |

Everything in this document was run on a fresh clone before it was written. Where a
command needs the customer system's credentials it is marked so, because those runs
cannot be checked for you.

---

## 1. Prerequisites

| you need | version                                    | how to check    |
| -------- | ------------------------------------------ | --------------- |
| Node.js  | **20 or newer** (`engines.node: >=20.0.0`) | `node -v`       |
| pnpm     | **10.28.0** (`packageManager`)             | `pnpm -v`       |
| Git      | any recent version                         | `git --version` |

Install pnpm the same way the Jenkins build does, so your version matches CI
exactly:

```bash
corepack enable
corepack prepare pnpm@10.28.0 --activate
```

If `corepack` is not available, `npm i -g pnpm@10.28.0` works too. Use the exact
version either way — a different pnpm can rewrite `pnpm-lock.yaml`.

There is no `.nvmrc`; any Node 20+ is fine.

---

## 2. Set up

```bash
git clone <repo-url>
cd ai-testing-platform
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

`--frozen-lockfile` is deliberate: it fails rather than quietly updating
`pnpm-lock.yaml`, so your dependency tree is the one CI tested.

Only Chromium is needed for the commands in this document. The full browser set
(`pnpm exec playwright install`) is for cross-browser runs.

### Your `.env`

```bash
cp .env.example .env
```

Then open `.env` and fill in **your own** credentials. Two rules:

- **`.env` is never committed, pasted into chat, emailed, put in a sheet, or zipped
  with anything.** It is in `.gitignore` and it stays there.
- Leave `TEST_ENV=local` until you actually want to point at the customer system.
  `local` runs against a demo app bundled in this repo, needs no credentials and
  cannot touch anything real.

To point at the customer system, set these (they are commented out in
`.env.example`):

```
TEST_ENV=app
BASE_URL=https://<the system>
APP_USERNAME=<your login>
APP_PASSWORD=<your password>
```

### Tell git who you are

```bash
git config user.name "Your Name"
```

The generated automation sheet records who ran it. Without this it falls back to
your Windows username, and on a build server it records `ci`.

---

## 3. The commands

**Run them in this order the first time.** `pnpm triage` refuses to run without a
capture on disk, and `pnpm inspect` needs a saved session, so the chain is
`auth` → `inspect` → `triage`. Each command below says what it needs.

### If you are on `TEST_ENV=local`, start the demo app first

```bash
node scripts/serve-demo.mjs
```

Leave it running in its own terminal. The TEST commands start this server for you;
`pnpm auth` and `pnpm inspect` do **not** — they open a browser at
`http://127.0.0.1:4173` and will find nothing there. Found by running the commands
on a fresh clone rather than by reading them.

On `TEST_ENV=app` there is nothing to start: the application is already running.

### `pnpm auth` — sign in once

Opens a real browser, waits for you to sign in by hand, and saves the session so
later runs do not sign in again.

- **Needs the target system's credentials.** On `TEST_ENV=local` it signs in to the
  bundled demo app and needs nothing from you.
- Writes: `artifacts/<application>/auth/<environment>.json`.
- **That file is a live session. Never share it.**

**Read the last line it prints.** It says `You landed on: <url>`, and that is your
only check that the sign-in worked. Press Enter too early and it saves the session
anyway — it will say you landed on the login page, and every later command will
behave as though you are signed out. Seen on a real run.

### `pnpm inspect` — record the screens

Opens a browser and waits. You navigate to a screen yourself, press **Enter** in the
terminal, and it records what is on that screen. Repeat for every screen you want
covered, then finish.

- **Needs the target system's credentials** (run `pnpm auth` first).
- It only navigates. It does not click, type or submit anything.
- Writes: `artifacts/<application>/inspect/<timestamp>/capture.json`, `report.md` and
  `pages.json`. The capture records which application, environment and `baseUrl` it
  came from, so it can never be mistaken for another system’s.
- **A capture contains real customer data and a live session token. Never share it.**

It checks its own work: if the page it captured is the login page it prints
`WARNING: captured the login page … the saved session has expired` and tells you to
re-run `pnpm auth`. Believe that warning — a capture of the login screen looks like
a capture.

**Its last message depends on what you captured**, so read it. On the bundled demo
app it tells you to paste `report.md` into the chat, which is right — there is no
real data in it and that is the fastest way to get a page object written. On any
other application it says the opposite:

```
Captures are gitignored and STAY ON THIS MACHINE: they contain real
workspace names, document titles and user names from a live system.

Do NOT paste report.md into a chat, a ticket or an email. Open it locally.
```

It used to print the "paste it into the chat" line unconditionally, two lines after
warning that the capture holds real data — two instructions in one block, the second
undoing the first. Found by running the command on a fresh clone while writing this
document.

### `pnpm triage "<path>" --app <application>` — read the QA sheet

Reads a test-case workbook and prints, row by row, which rows could be automated and
which never can — with a reason for each, and who can act on it.

```bash
pnpm triage "C:/Users/you/Documents/Test case Sheet.xlsx" --app dms
pnpm triage "C:/Users/you/Documents/Test case Sheet.xlsx" --app dms --out artifacts/triage
```

- **Needs no network, no credentials and no browser.** It reads the file and nothing
  else.
- **`--app` is required.** Triage pairs one application’s sheet against that
  application’s captures, and nothing ambient should decide which. If `TEST_ENV` is
  also set and names a different application, it refuses and prints both.
- **It does need at least one capture for THIS application**, or it stops with
  `no captures found under artifacts/<application>/inspect`. That
  refusal is deliberate: the answer depends on which screens have been recorded, so
  a number computed with none would be meaningless. Run `pnpm inspect` first.
- The module names in your sheet are paired against captured screens by a mapping
  inside the script. It prints that pairing with `** NOT ON DISK **` beside anything
  it could not find, and the line `captured but unpaired` for captures no module
  claims. **Read both lines** — a wrong pairing makes every number below it wrong.
- **It never writes to your workbook.** Output goes to the terminal, or to `--out`.
- **Keep the workbook OUTSIDE this repo folder** and pass the full path. The repo
  refuses to track spreadsheets on purpose, and a workbook inside the folder is one
  `git add` away from being committed.

### `pnpm verify` — is the repo healthy?

Formatting, lint, typecheck, unit tests, the demo suite, the API build and the API's
internal tests.

- **Runs entirely on your machine.** No credentials, no customer system, no network
  calls to anything real.
- Takes about a minute. Run it before you report a problem — it tells you whether
  the repo is broken or your setup is.

### Running the existing Playwright tests

```bash
pnpm test:unit      # logic tests, no browser, no credentials
pnpm test:demo      # the bundled demo app, a real browser, no credentials
pnpm test           # the LIVE suite, for the current TEST_ENV
pnpm test:regression   # only tests tagged @regression
pnpm test:headed    # same, with the browser visible
pnpm test:ui         # Playwright's interactive runner
```

**There are two surfaces and they are two different commands.** `pnpm test` and
everything below it is the live suite: it obeys `TEST_ENV`, needs your credentials,
and collects **no** unit or demo test. `pnpm test:unit` and `pnpm test:demo` are the
fixture surface and need nothing.

That split is not a convention — the project list itself is partitioned, so no
invocation can mix them. A live run has to resolve the real environment, which puts
`.env` into every worker it starts, and the fixture surface has no use for a live
credential (SEC-3e). Asking the wrong way says so:

```
The "unit" project is not part of a live run, by design: …
  Run `pnpm test:unit` instead — same tests, with .env parsed rather than merged.
Error: Project(s) "unit" not found. Available projects: "live-setup", "chromium", …
```

**A bare `pnpm test` on a machine with no `.env` is EXPECTED to fail**, and it is
worth knowing which failures are the expected ones, because they look alarming.
Measured on a fresh clone with no environment configured — 4 failed, 9 passed:

| what fails                                            | why                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `live-setup` × 2 (`authenticate`, "named explicitly") | no environment was named and no credentials exist. This is the refusal working. |
| `app-health` × 2                                      | there is no live application to answer.                                         |

All four are the live surface refusing for want of a live system, which is correct
on a machine that has none. It was 6 failed before the partition: the other two were
the fixture guard reporting, accurately, that a live invocation had put the real
`.env` into the unit workers.

Tests that would CREATE data are tagged `@write` and are **skipped** unless an
environment variable is set deliberately. A normal run never creates a record. Leave
it that way.

### Looking at results

```bash
pnpm test:report                       # the HTML report in a browser
pnpm test:trace artifacts/…/trace.zip  # step through a failed test
```

### Where output goes

| command                     | writes to                                                          |
| --------------------------- | ------------------------------------------------------------------ |
| `pnpm auth`                 | `artifacts/<application>/auth/`                                    |
| `pnpm inspect`              | `artifacts/<application>/inspect/<timestamp>/`                     |
| `pnpm triage … --out <dir>` | that directory (terminal only without `--out`)                     |
| any test run                | `artifacts/test-results/`, `artifacts/reports/`, `artifacts/runs/` |

All of `artifacts/` is gitignored, so none of it can reach the repository by
accident. Delete the folder whenever you want the disk back.

> **`pnpm clean` does not work on Windows today.** Measured on a fresh clone,
> 2026-10-01: it exits 1 with `EINVAL … path: '…\**\dist'` and deletes **nothing**
> — the `**/dist` patterns in that script are passed to `rimraf` literally, because
> no Windows shell expands them. Deleting `artifacts/` yourself is safe and is all
> this command was for. Recorded rather than patched in passing: it removes
> directories, so it is worth fixing deliberately.

---

## 4. Never share these

Not by email, not in a chat, not in a Jira attachment, not in a zip:

| what                          | why                                                       |
| ----------------------------- | --------------------------------------------------------- |
| **`.env`**                    | your credentials in plain text                            |
| **`artifacts/*/auth/*.json`** | a live signed-in session — anyone with the file is you    |
| **`artifacts/*/inspect/**`**  | captures hold real customer data and a session token      |
| **any `trace.zip`**           | a replayable recording of a session, including its tokens |
| **the QA workbook**           | its Test Data column holds real credentials               |
| **`artifacts/` in general**   | screenshots and videos of real records                    |

A screenshot of one screen is usually fine to attach to a defect. A trace is not — it
is the whole session.

If a report needs to leave the team, someone reviews it first.

### What IS in the repo, checked

`git ls-files` was searched for every one of those shapes. Two files match and both
are deliberate: `.env.example` (a template, no values) and a unit test with the word
`credentials` in its name. **No `.env`, no spreadsheet, no `artifacts/`, no capture
and no trace is tracked.**

`config/env/*.json` holds the connection settings, and it is the one place to know
about:

| file           | credentials                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `local.json`   | a **literal** username and password — the bundled demo app's own, which are also printed in its HTML. Nothing real. |
| `app.json`     | placeholders only (`${APP_USERNAME}`, `${APP_PASSWORD}`) — your `.env` fills them                                   |
| `staging.json` | placeholders only, including the database block                                                                     |
| `qa.json`      | placeholders only (`${QA_ADMIN_USER}`, `${QA_ADMIN_PASSWORD}`)                                                      |

`qa.json` used to carry `${QA_ADMIN_PASSWORD:-Passw0rd!}` and
`${QA_ADMIN_USER:-hr.admin}` — a committed username and password in a file whose
application is the customer system. Both defaults are gone. With either variable
unset the run now REFUSES and names it:

```
Environment variable QA_ADMIN_PASSWORD is required but not set.
```

A default turned "you did not configure this" into "your password is wrong", which
is the more expensive sentence to debug and the more dangerous one to act on.

`app.json` uses `${APP_USERNAME:-}` — an EMPTY default, which resolves to a blank
rather than refusing. That is a different shape and is left alone for now; use
`TEST_ENV=app` for the customer system and set every variable explicitly.

---

## 5. Not ready yet

Two things exist in the repo and are **not part of this kit**:

- **`pnpm run-sheet` — running the QA sheet end to end.** Not built yet. The pieces
  are there and nothing invokes them, so there is no command to give you.
- **The AI features** — `pnpm rca`, `pnpm heal`, `pnpm smoke:generation`. These call
  a paid model API and need a key this kit does not include. Without a key they fall
  back to a mock and tell you nothing useful, so they are left out rather than
  handed over half-working.

Ask before using either. They are not blocked, they are just not yours to run yet.

---

## 6. Every command in the repo, and which ones are yours

Measured from `package.json`, not remembered. **The kit is the `yes` rows.**

| script                                                        | what it does                                                        | live creds?  | API key? | can write to the app?                     | in the kit                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ------------ | -------- | ----------------------------------------- | -------------------------- |
| `auth`                                                        | one-time interactive sign-in, saves the session                     | **yes**      | no       | no (signs in only)                        | **yes**                    |
| `inspect`                                                     | records the screens you navigate to                                 | **yes**      | no       | no (navigates only)                       | **yes**                    |
| `triage <workbook>`                                           | reads a QA sheet, prints the ceilings                               | no           | no       | no                                        | **yes**                    |
| `verify`                                                      | format, lint, typecheck, unit, demo, API build + internal API tests | no           | no       | no                                        | **yes**                    |
| `test:unit`                                                   | logic tests, no browser                                             | no           | no       | no                                        | **yes**                    |
| `test:demo`                                                   | the bundled demo app in a real browser                              | no           | no       | only the demo app                         | **yes**                    |
| `test`                                                        | every project for the current `TEST_ENV`                            | yes on `app` | no       | `@write` tests only, and they are skipped | **yes**                    |
| `test:regression`                                             | `@regression`-tagged tests                                          | yes on `app` | no       | as above                                  | **yes**                    |
| `test:headed` / `test:ui`                                     | the same, visible / interactive                                     | yes on `app` | no       | as above                                  | **yes**                    |
| `test:api`                                                    | the API project, including `@smoke`                                 | yes          | no       | no                                        | yes                        |
| `test:api:internal`                                           | the API project minus `@smoke`                                      | no           | no       | no                                        | yes (inside `verify`)      |
| `test:smoke:live`                                             | four browsers + API, `@smoke` only                                  | **yes**      | no       | no                                        | yes                        |
| `test:report` / `test:trace`                                  | open a report / step through a trace                                | no           | no       | no                                        | **yes**                    |
| `prepare:browsers`                                            | installs Chromium with OS deps                                      | no           | no       | no                                        | **yes**                    |
| `clean`                                                       | deletes `artifacts/`, `dist/`                                       | no           | no       | no                                        | yes                        |
| `format` / `format:check` / `lint` / `lint:fix` / `typecheck` | code hygiene                                                        | no           | no       | no                                        | yes (inside `verify`)      |
| `check:api-deps`                                              | proves every compiled module resolves its dependencies              | no           | no       | no                                        | yes (inside `verify`)      |
| `rca`                                                         | AI root-cause analysis of failures                                  | no           | **yes**  | no                                        | no                         |
| `heal`                                                        | AI locator repair                                                   | no           | **yes**  | no                                        | **no — edits source**      |
| `heal:review`                                                 | approve a healing proposal, one at a time                           | no           | no       | no                                        | **no — edits source**      |
| `eval:healing`                                                | scores the healing engine                                           | no           | **yes**  | no                                        | no                         |
| `smoke:generation`                                            | one real model call end to end                                      | no           | **yes**  | no                                        | no                         |
| `eval:generation`                                             | scores grounding against a built-in fixture                         | no           | no       | no                                        | no (platform test)         |
| `generate:review`                                             | review and emit generated specs                                     | no           | no       | no                                        | no (nothing to review yet) |
| `api:dev` / `api:build` / `api:start`                         | the orchestration API                                               | no           | no       | no                                        | no                         |
| `docker:up` / `docker:down`                                   | the docker compose stack                                            | no           | no       | no                                        | no                         |

Three things this table is worth reading for:

- **`heal` and `heal:review` write to files in this repo.** They are the only
  commands that do. They are out of the kit for that reason, not because of a key.
- **Only four scripts want an API key.** Everything in the kit runs without one.
- **`@write` tests exist and are skipped.** A normal `pnpm test` never creates a
  record. Turning that off is a deliberate decision, not a flag to try.

---

## 7. If something breaks

1. Run `pnpm verify`. Green means the repo is fine and the problem is in your setup
   or the target system.
2. Check the first line of any test output — every run prints the environment and the
   URL it resolved. If that is not the system you meant, stop and fix `.env` before
   reading anything else.
3. `node -v` and `pnpm -v` against the table in section 1.
4. `pnpm install --frozen-lockfile` again. If it FAILS rather than installing, your
   pnpm version is wrong.
