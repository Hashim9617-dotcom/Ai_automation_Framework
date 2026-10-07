# Adding an application

The platform tests one application per `application` slug. DMS is the only one today.
This is what it takes to add another, in the order it has to happen.

Everything below was run on a fresh clone with a fake application before this page
was written. Where a step needs the real system's credentials it says so, because
those steps cannot be checked for you.

---

## 1. Choose a slug

A lower-case slug — `contoso`, `globex`. It becomes a directory name and appears in
paths, so pick it once and do not rename it.

**Check it against the guard before you use it anywhere:**

```bash
pnpm test:unit --grep app-agnostic
```

That guard fails if your slug appears anywhere in `packages/` or `apps/`, which are
the layers whose whole claim is that they know nothing about any application.

This step is not a formality. The first draft of this page used `acme` as its
example, and running the guard on a fresh clone failed:

```
an application slug does not appear in the CODE of packages/ or apps/
  + "packages/execution-engine/src/config/schema.ts: acme"
```

— because `schema.ts` uses `"acme"` in the comment explaining what a slug is. The
guard was right, the example was wrong, and the only reason it was caught is that
the step was actually run. Pick a slug, run that command, and read the answer.

## 2. The environment file — `config/env/<name>.json`

The environment NAME and the application SLUG are different things: `app`, `qa` and
`staging` are three environments of one application. Copy `config/env/app.json` and
change `application`.

```json
{
  "name": "contoso-prod",
  "application": "contoso",
  "baseUrl": "${CONTOSO_BASE_URL}",
  "users": {
    "admin": {
      "username": "${CONTOSO_USERNAME}",
      "password": "${CONTOSO_PASSWORD}",
      "role": "admin"
    }
  }
}
```

Two rules this file is under, both earned:

- **No credential gets a default.** `${CONTOSO_PASSWORD}` with nothing after the name
  refuses and names the variable when it is unset. `${CONTOSO_PASSWORD:-}` resolves to a
  blank, the schema accepts it, and the run reaches a login attempt — which then
  fails on the login page and reads as a wrong password rather than as missing
  configuration.
- **A second role is ABSENT, not blank.** Add a `user` entry only when you have one.
  A test that asks for a role the file does not define is refused by name.

Add the variables to `.env`. They are yours and never leave your machine.

## 3. `config/apps/<slug>/`

Two files, and the second one comes after you have captures — see step 6.

| file                 | what it is                                             | when                  |
| -------------------- | ------------------------------------------------------ | --------------------- |
| `module-routes.json` | sheet Module column -> the route that IS that screen   | before `triage`       |
| `module-map.json`    | route + the element that PROVES the screen was reached | before a sheet is run |

`module-routes.json` starts almost empty and grows:

```json
{
  "routes": { "Dashboard": "dashboard" },
  "skipped": {},
  "notCaptured": ["Everything else, by name"]
}
```

`notCaptured` matters more than it looks. A module absent from `routes` is
indistinguishable from an oversight, and listing it by name is the difference between
a gap somebody can act on and a silence.

## 4. Sign in — `pnpm auth`

```bash
# PowerShell
$env:TEST_ENV="contoso-prod"; pnpm auth
```

It prints the target before a browser opens — application, environment, host, and
where each of those came from. **Read it.** That is the only check you get, and the
saved session's label is the one thing nothing downstream can verify.

Then sign in by hand, however the system requires: password, SSO, MFA, a consent
screen. Press Enter when you are on the landing page. The last line says
`You landed on: <url>` — if that is the login page, the sign-in did not take and
every later step will behave as though you are signed out.

Writes `artifacts/<slug>/auth/<environment>.json`. **A live session. Never share it.**

> Needs the real system's credentials. Not verifiable from here.

## 5. Record the screens — `pnpm inspect`

```bash
$env:TEST_ENV="contoso-prod"; pnpm inspect
```

Navigate to a screen, press Enter, name it, repeat. `q` to finish.

- It prints the same target banner first.
- A URL argument whose HOST differs from the environment's is refused, naming both.
  The capture is about to be labelled with the environment's `baseUrl`, and a label
  that was never visited cannot be corrected afterwards.
- Writes `artifacts/<slug>/inspect/<timestamp>/`, and each capture records its
  application, environment and `baseUrl`.
- Its closing message tells you NOT to paste the report anywhere for a real
  application. Follow that.

> Needs the real system's credentials. Not verifiable from here.

## 6. Triage a sheet — `pnpm triage`

```bash
pnpm triage "C:/path/outside/the/repo/Test cases.xlsx" --app contoso
```

- `--app` is **required**. Triage pairs one application's sheet against that
  application's captures, and nothing ambient should decide which. If `TEST_ENV` is
  also set and names a different application, it refuses and prints both.
- It needs at least one capture for that application, or it refuses rather than
  reporting a ceiling computed from nothing.
- **Keep the workbook outside the repo folder** and pass the full path. The repo
  refuses to track spreadsheets on purpose.

Read the pairing table it prints. A wrong pairing manufactures a false ceiling in
whichever direction it errs, and it is the one thing here a human should check by eye.

Then write `module-map.json` from what the captures actually hold — a route a capture
recorded and an element that capture contains. Map only what is captured: an entry
nobody can prove fails row by row later, and the whole-run check refuses for one.

## 6a. Check the map against the LIVE app — `pnpm verify-entries`

```bash
TEST_ENV=contoso-prod pnpm verify-entries --app contoso
```

**`TEST_ENV` is required here**, naming the environment file from step 2 — unlike
`pnpm triage`, this command opens a browser and so must resolve an environment, and
there is no default. Without it the command refuses and says so. (It can come from
your `.env` instead; it is written out here because that is the form that works on a
machine which has not set one up.)

**Do this immediately after writing `module-map.json`, and again whenever a run
starts behaving oddly.** `module-map.json` is validated against the CAPTURE — the
screens as you recorded them — and that is a fact about a recording. This is the only
thing that asks the application whether the route still opens and the proof element is
still on it, and a stale capture validates perfectly.

Read-only: it navigates and counts, nothing else.

|  exit | means                                                                                                          |
| ----: | -------------------------------------------------------------------------------------------------------------- |
| **0** | every provable module verified                                                                                 |
| **1** | a module failed, **or** the command refused to start (no session, no capture, `ALLOW_WRITES` set, unknown app) |

One line per module — `verified`, or the stage that stopped it: `auth`, `navigation`,
`state-assert`. A failure writes a screenshot and an aria snapshot under
`artifacts/<slug>/verify-entries/` and prints the paths, so you can see whether the
element is absent, renamed or merely off-screen.

A module that is in the map but **not provable against the capture** is not checked
here at all, and is listed separately. Those are a map problem, not a live one — fix
them before this command can tell you anything about them.

## 7. Your own specs — `tests/apps/<slug>/`

Live browser projects collect `tests/apps/<application>/**`. Until that directory
exists, a run for your application collects no specs and says so:

```
No specs for application "contoso": tests/apps/contoso/ does not exist.
```

That is not an error. The two tests it still lists are the sign-in setup and the
environment-name guard, which are not application-specific.

**One application's specs never import another's.** Shared helpers go in
`tests/support/`; a page object stays inside its own application directory. A test
enforces this by resolving every import, so a borrowed page object fails the unit
suite rather than quietly putting someone else's selectors into your run.

## 8. Check it

```bash
pnpm format
pnpm verify
```

`pnpm format` first, and that order is from running this page rather than writing it:
`verify` starts with `format:check`, so a hand-written `module-routes.json` that is
not Prettier-formatted fails the whole gate on its first step — before a single test
runs, with a message about code style rather than about your application.

`verify` is local only: no credentials, no customer system. Green means the repo is
fine and anything still wrong is in your setup or the target.

---

## What this does NOT give you

- **Running a QA sheet end to end.** `runSheet` is composed and has no caller; the
  CLI arrives later.
- **AI features** (`pnpm rca`, `pnpm heal`) need a model API key.
- **Shared reports.** `artifacts/reports/` and `artifacts/runs/` are not yet keyed by
  application, so two applications' run archives mix. Captures and sessions are
  separated; these are not.
