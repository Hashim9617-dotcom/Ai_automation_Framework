# Adding an application

The platform tests one application per `application` slug. DMS is the only one today.
This is what it takes to add another, in the order it has to happen.

Everything below was run on a fresh clone with a fake application before this page
was written. Where a step needs the real system's credentials it says so, because
those steps cannot be checked for you.

---

## 0. Where you type all of this

**Open this kit folder in VS Code or Cursor, and use its built-in terminal**
(`Terminal → New Terminal`). Every command on this page is run there, with the kit
folder as the current directory. The terminal's prompt should end in the kit folder's
name before you run anything.

If you are in Cursor, read **"Using Cursor"** in
[QA-QUICKSTART.md](QA-QUICKSTART.md) first — Privacy Mode on, and never paste `.env`
or a password into a chat.

## 1. Choose a slug

**A "slug" is just a short, lower-case, one-word name for your application** — the
name of a NEW folder you are about to create. `synergystore`, `contoso`, `globex`.

It is typed in exactly two places, and they must match:

| where                                                       | what you type                   |
| ----------------------------------------------------------- | ------------------------------- |
| the folder name                                             | `config\apps\synergystore\`     |
| the `"application"` field in your environment file (step 2) | `"application": "synergystore"` |

`config\apps\dms\` is the worked example — look at it to see the shape, and **do not
edit anything inside it.** Your folder sits beside it.

It becomes a directory name and appears in paths, so pick it once and do not rename
it.

### Check it against the guard first

**A "guard" here is a test that proves nothing in the framework is hard-wired to one
particular application.** `packages/` and `apps/` are supposed to know nothing about
DMS or about yours; this guard reads their source and fails if an application's name
appears in it.

Run it, and expect every test to pass:

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
`staging` are three environments of one application.

> ### Create a NEW file. Never edit `config/env/app.json`.
>
> `app.json` is DMS's environment file. During the 8 October check a QA followed
> "copy app.json and change application" by editing `app.json` itself, which points
> the DMS environment at a different system — and the kit's integrity check now
> refuses when that file changes, which is what it is for.
>
> Copy it to a new name and edit the copy:
>
> ```bash
> copy config\env\app.json config\env\synergystore.json
> ```
>
> Then edit `config\env\synergystore.json` only.

> ### Then change `TEST_ENV` in `.env` to the new file's name, without `.json`
>
> ```
> TEST_ENV=synergystore
> ```
>
> **This step was missed during the 8 October check**, and the consequence was quiet:
> `TEST_ENV` was still `app`, so every command used DMS's environment file while
> `BASE_URL` pointed at the new system — and a synergystore login was saved under
> `artifacts\dms\auth\app.json`. Nothing failed. The banner each command prints is
> where you catch this: if it says `application : dms` and your own host, stop and fix
> `TEST_ENV`.

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

### Your `.env`

**Make it by copying `.env.example`.** Never from another application's `.env`, and
never from another person's — a copied `.env` carries their credentials and their
`TEST_ENV`.

```bash
copy .env.example .env
```

Then fill in only what you need:

| variable                       | what to do                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEST_ENV`                     | the name of your new environment file, without `.json`                                                                                                                      |
| `BASE_URL`                     | your application's URL                                                                                                                                                      |
| `APP_USERNAME`, `APP_PASSWORD` | the login the tests sign in with                                                                                                                                            |
| `API_BASE_URL`                 | **optional.** Only if the application's API is on a different host from its UI. If you do not know, leave it commented out — the environment file falls back to `BASE_URL`. |
| `ANTHROPIC_API_KEY`            | **not needed for this kit. Leave it empty.** Nothing in the QA kit calls a model API; it is there for the maintainer's AI features, which are not part of the kit.          |

> ### ⚠️ Never share `.env`, or anything in it
>
> Not in a chat message, not in an email, not in a screenshot, and **not in an AI
> assistant's chat window** — not Cursor's, not any other.
>
> During the 8 October check a complete `.env`, including an API key and an admin
> login, was pasted into a chat. Treat that as a credential leak: the password and the
> key both have to be rotated.
>
> If somebody needs to help you with it, send them the **variable names** you are
> unsure about, never a line from the file. `.env.example` is the safe thing to share
> — it is the blank template.

`.env` is gitignored, and it never leaves your machine unless you send it somewhere.

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

## 4. Sign in — `pnpm auth --app <slug>`

```bash
pnpm auth --app contoso
```

`--app` is REQUIRED and there is no `TEST_ENV` fallback. It used to be ambient, which
meant that on a machine whose `.env` still said `TEST_ENV=app` this command opened a
browser at the FIRST application and saved a live session under its name — while you
believed you were onboarding the second one.

If the application has several environments (`contoso-qa`, `contoso-prod`), name one
and the two must agree:

```bash
# PowerShell
$env:TEST_ENV="contoso-prod"; pnpm auth --app contoso
```

A `--app` that disagrees with `TEST_ENV` is refused, printing both. With `TEST_ENV`
unset and exactly one environment declaring the application, that one is used; with
several, it refuses and lists them rather than picking.

It prints the target before a browser opens — application, environment, host, and
where each of those came from. **Read it.** That is the only check you get, and the
saved session's label is the one thing nothing downstream can verify.

Then sign in by hand, however the system requires: password, SSO, MFA, a consent
screen. Press Enter when you are on the landing page. The last line says
`You landed on: <url>` — if that is the login page, the sign-in did not take and
every later step will behave as though you are signed out.

Writes `artifacts/<slug>/auth/<environment>.json`. **A live session. Never share it.**

> Needs the real system's credentials. Not verifiable from here.

## 5. Record the screens — `pnpm inspect --app <slug>`

```bash
pnpm inspect --app contoso
```

Navigate to a screen, press Enter, name it, repeat. `q` to finish.

`--app` is REQUIRED here for a sharper reason than for `auth`: the capture this
writes is FILED under that application and is the provenance every locator is later
written against. An ambient variable choosing it means a capture of the wrong system
lands under the right name, and nothing downstream can tell.

- It prints the same target banner first.
- A URL argument whose HOST differs from the environment's is refused, naming both.
  The capture is about to be labelled with the environment's `baseUrl`, and a label
  that was never visited cannot be corrected afterwards.
- Writes `artifacts/<slug>/inspect/<timestamp>/`, and each capture records its
  application, environment and `baseUrl`.
- Its closing message tells you NOT to paste the report anywhere for a real
  application. Follow that.

> **Never click Save, Delete, Upload, Submit or Confirm while inspecting.** You are
> signed in as a real user on a real system. `inspect` only records what you navigate
> to — it clicks nothing itself — so anything that changes data during a capture was
> changed by you.

### Two things it prints that are not errors

**"N name divergences"** — this is a **finding about the application you are
capturing**, not a problem with the kit. It means N elements have an accessible name
that differs from the text shown on screen: a button that reads "Save" to you and
reports itself as "submit-btn" to a screen reader. Tests have to use the accessible
name, so it is worth telling the app team about. Nothing is broken and nothing needs
fixing before you continue.

**`clicked ""` in the "What did you do?" menu** — an empty name means the element has
no accessible name at all, so the kit has nothing to call it. Do not pick that option
hoping it is close enough. Choose **"something else"** and describe what you did in
your own words ("clicked the pencil icon in the row toolbar"). The description is what
a human reads later; a blank name is what a tool could not read.

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
- **AI features** (`pnpm rca --app <a>`, `pnpm heal --app <a>`) need a model API key.
- **Shared reports.** `artifacts/reports/` and `artifacts/runs/` are not yet keyed by
  application, so two applications' run archives mix. Captures and sessions are
  separated; these are not.
