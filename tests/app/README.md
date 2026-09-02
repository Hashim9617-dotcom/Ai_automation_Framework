# tests/app — your real application

Specs here run against whatever `BASE_URL` points at. They are ignored when
`TEST_ENV=local`, so the bundled demo suite and your real suite never mix.

**Currently populated with a 45-test suite for DmsSynergy DMS**, generated from
the 24-page inventory captured with `pnpm inspect`. See
`docs/dms-suite.md` for what each spec covers and how to tune it.

## Getting started

```bash
# 1. Point at the app (in .env)
TEST_ENV=app
BASE_URL=https://dmsuiv3.aitalkx.com

# 2. Log in once — works with SSO, MFA, OTP, anything
pnpm auth

# 3. Run
pnpm test --project=chromium
```

## Layout

```
tests/app/
  pages/          Page objects for the application under test
    app.page.ts     shared shell: nav, top bar, collapsible sections
    admin/          Users / Roles / Groups (share admin-list.page.ts)
  *.spec.ts       Specs, tagged @smoke / @regression / <feature>
```

## Locator strategy for this app

DmsSynergy has **zero `data-testid` attributes** — 0% coverage across all 24
pages. Its accessibility, however, is strong: real `tree`, `treeitem`, `menu`,
`menuitem`, `tablist`, `toolbar` and `combobox` roles, and every interactive
element carries an accessible name. So every locator here leads with
`role + name` rather than a test id.

`smoke.spec.ts` logs the live test-id coverage on each run. If the app team ever
adds `data-testid`, that number moves and the locator chains can be upgraded
without touching a single spec — the candidates are data, not code.

## Safety

- Nothing here writes to the system unless you opt in:
  `$env:ALLOW_WRITES="true"` enables the `@write` tests (create workspace,
  create role, create user). A normal run skips them.
- No file is ever uploaded and nothing is ever deleted. The upload specs assert
  the wizard's guard rails; the destructive-action specs assert that Cut / Copy /
  Delete / Archive stay **disabled** with nothing selected.

### Never share a raw `trace.zip` outside the team

A Playwright trace records network traffic and storage state, so a trace from
any authenticated run **contains a live session** — the `refresh_token` cookie
plus `access_token`/`refresh_token` from localStorage. The access token
authorises real API calls for 60 minutes from capture.

Pasting a trace into a ticket or a chat thread to help someone debug is the
likeliest way this leaks, and it needs no CI involvement at all. Share the
failing test name, the error text and a screenshot instead. If someone
genuinely needs the trace, hand it over inside the team and say why.

This applies to everything under `artifacts/test-results/` and
`artifacts/runs/` (archived failing runs, kept up to 14 days), and to the
Playwright HTML report, which embeds the same traces under `html/data/*.zip`.
`run.json`, `junit.xml` and `summary.html` are token-free and safe to attach.

## Tuning to your instance

These read from the environment, with the defaults observed during capture:

| Variable | Default | Used by |
| --- | --- | --- |
| `DMS_SAMPLE_WORKSPACE` | `ABCD` | file-explorer, upload |
| `DMS_SAMPLE_FOLDER` | `auto Test 123` | file-explorer, upload |
| `DMS_SEARCH_TERM` | `pension` | global-search |

If your QA instance has different data, set these instead of editing specs.

## Notes

- `pnpm auth` saves a logged-in session, so specs here do **not** test the login
  flow. `login.page.ts` exists for when you want a dedicated auth spec that runs
  without the saved session.
- Keep tests independent: each one sets up its own data. Prefer creating state
  through the `api` fixture over driving the UI — it is faster and less flaky.
