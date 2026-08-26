# AI Testing Platform

An AI-powered test automation **platform** — Playwright for execution, with an AI
layer on top for test-case generation, self-healing selectors, DOM understanding
and root cause analysis, plus a live dashboard and enterprise integrations.

**Status: Phase 1 complete, Phase 2 started.** The execution engine, orchestration
API, reporting and CI/CD scaffolding work end to end. The first AI feature —
root cause analysis on failures — has shipped.

---

## Quick start

```bash
pnpm install
pnpm exec playwright install --with-deps chromium   # add firefox/webkit when you need them
cp .env.example .env

pnpm test                # runs the sample suite against the bundled demo app
pnpm test:report         # open the Playwright HTML report
```

`pnpm test` works on a fresh clone with no VPN and no credentials: the repo ships
a tiny demo HR app (`tests/demo-app/`) that Playwright starts automatically. Point
`config/env/qa.json` at your real application when you are ready.

Run the orchestration API:

```bash
pnpm api:dev             # http://localhost:3001/api  (Swagger at /api/docs)
```

```bash
# Schedule a run
curl -X POST localhost:3001/api/runs \
  -H 'content-type: application/json' \
  -d '{"grep":"@smoke","environment":"local"}'

# AI Command Box
curl -X POST localhost:3001/api/command \
  -H 'content-type: application/json' \
  -d '{"command":"test complete employee registration flow","environment":"local","dryRun":true}'
```

---

## Layout

```
apps/
  api/                    NestJS orchestration API (runs, events, command box)
  web/                    Dashboard — Phase 3 (contracts documented, not built)
packages/
  shared/                 Types, contracts, logger, redaction — the common language
  execution-engine/       Playwright framework: config, smart locators, POM, fixtures, DOM capture
  ai-engine/              LLM gateway, budget guard, root cause analysis, Phase 2 sockets
  reporting-engine/       Custom reporter, HTML summary, SMTP delivery
tests/
  app/                    YOUR application: specs + page objects
  demo/                   Bundled demo app, its page objects and specs
  api/                    API-layer specs (no browser launched)
  unit/                   Pure logic specs for platform code
  support/                Global setup
config/env/               One JSON per environment (local, qa, staging)
infra/
  docker/                 Dockerfile.api, Dockerfile.runner, docker-compose.yml
  jenkins/                Jenkinsfile (nightly + parameterised)
  prisma/                 Database schema (not yet wired up)
scripts/                  Demo server, app inspector, failure analyzer, report mailer
```

---

## Pointing it at your own application

Switching the platform to a different application is a `.env` edit — no code, no
config file:

```bash
TEST_ENV=app
BASE_URL=https://your-app.example.com
APP_USERNAME=qa.automation
APP_PASSWORD=...
# TEST_ID_ATTRIBUTE=data-qa      # if your app does not use data-testid
```

Then log in once:

```bash
pnpm auth
```

A browser opens, you sign in **by hand**, and the session is saved. Every run
afterwards starts already authenticated. This is deliberately manual: it is what
makes the platform work with any identity provider — SAML, OIDC, Azure AD, Okta,
an OTP on your phone, a consent screen — none of which script reliably. Re-run it
when the session expires. The saved file holds live cookies, so it lives under
`artifacts/` and is gitignored.

`tests/demo/` (the bundled sample app) and `tests/app/` (your application) never
run together: `TEST_ENV=local` runs the demo, anything else runs your suite.

Next, take an inventory of what the engine can actually see:

```bash
pnpm inspect                    # uses BASE_URL
pnpm inspect https://other/page # or an explicit URL
```

A browser opens. Log in however your app requires — password, SSO, OTP — navigate
to a page you want automated, name it in the terminal, press Enter. Repeat for
each page, then `q`.

You get `artifacts/inspect/report.md`: every interactive element per page with
its role, accessible name, `data-testid` and placeholder — plus what percentage
of elements carry a test id, which is the single best predictor of how stable
your suite will be.

That report is enough to write real page objects with accurate locators and
fallback chains, instead of guessing. Nothing leaves your machine, and password
and token values are filtered out of the capture.

## Root cause analysis

When a test fails, the execution engine captures the evidence while the page is
still alive — console errors, uncaught page errors, failed and 5xx requests, the
locators that were resolved, and a compact accessibility-first snapshot of the
page. All of it lands inside `run.json`.

Analysis is a **separate pass**, so a failing run never waits on a model:

```bash
pnpm test          # run the suite
pnpm rca           # analyze the failures, update run.json + summary.html
```

The API does it automatically after any run with failures (`RCA_AUTO=false` to
turn that off). Each verdict carries a category — `application-bug`, `test-bug`,
`environment`, `test-data`, `selector`, `flaky` or `unknown` — plus a confidence
score, the quoted evidence behind it, and a suggested fix:

> **APPLICATION-BUG** · Root cause · 82%
> The Save button never rendered the expected label because `GET /api/departments`
> returned 500, so the department dropdown — and the form it gates — never initialised.
>
> **Suggested fix:** Fix the `/api/departments` 500 on the QA environment, then re-run.

Set `ANTHROPIC_API_KEY` in `.env` to enable it. Without a key the platform says so
and skips analysis rather than writing empty verdicts into your report.

Cost is bounded by design: identical failures across chromium, firefox, webkit and
mobile-chrome are one bug, so they cost one call; generated ids are normalised out
of the cache key so the same failure is free on the next run; `RCA_MAX_FAILURES`
caps how many distinct failures are analyzed; and `LLM_BUDGET_USD` is a hard stop.

## The four ideas that matter

**1. Locators are data, not code.** A page object declares a `LocatorSpec`: a key,
a human description, and an *ordered list of candidates*. `SmartLocator` walks the
list and records which candidate won.

```ts
private readonly lastName = locator('employee.lastName', 'Last name input', [
  { strategy: 'testId', value: 'employee-last-name', confidence: 0.2 },
  { strategy: 'label', value: 'Last name' },
  { strategy: 'css', value: '#lastName' },
]);
```

Today that gives free resilience — the sample suite genuinely falls back from a
missing test id to the label. Tomorrow the self-healing engine hooks into
`onHealRequested` and asks the LLM for a new candidate when the whole list is
stale. No page object changes.

**2. One canonical `Run` document.** The custom reporter writes
`artifacts/reports/run.json` in the shape defined by `@aitp/shared`. The
dashboard, email, Jira and Slack all read that, never Playwright internals.

**3. AI contracts exist before the AI does.** `TestCaseGenerator`,
`ScriptGenerator`, `SelfHealingEngine`, `RootCauseAnalyzer` and `LlmGateway` were
defined in Phase 1 and referenced from day one. `RootCauseAnalyzer` has since been
implemented — and not a single call site changed. The remaining `Pending*` classes
go the same way.

**4. Cost control is structural.** Every LLM call goes through one gateway with a
disk cache and a per-run budget cap (`LLM_BUDGET_USD`). A runaway healing loop
cannot quietly burn the budget.

---

## Commands

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `pnpm test`            | Full suite, all configured projects                       |
| `pnpm test:smoke`      | `@smoke`-tagged tests only                                |
| `pnpm test:regression` | `@regression`-tagged tests only                           |
| `pnpm test:api`        | API-layer project (no browser)                            |
| `pnpm test:unit`       | Pure logic tests for platform code (no browser, no app)   |
| `pnpm rca`             | Root cause analysis over the last run's failures          |
| `pnpm inspect [url]`   | Open your app, capture each page's element inventory      |
| `pnpm auth`            | Log in once by hand; tests reuse the session (any IdP)    |
| `pnpm test:ui`         | Playwright UI mode                                        |
| `pnpm test:headed`     | Watch the browser                                         |
| `pnpm verify`          | format + lint + typecheck + smoke — run before committing |
| `pnpm api:dev`         | Build and start the orchestration API                     |
| `pnpm docker:up`       | Postgres + Redis + API via docker compose                 |

Environment selection is `TEST_ENV=qa pnpm test` (files live in `config/env/`).

---

## Environments and secrets

`config/env/<name>.json` holds everything environment-specific. Secrets are
never committed — they are referenced as `${VAR}` or `${VAR:-default}` and
resolved from `.env` / CI credentials at load time:

```json
"users": { "admin": { "username": "${QA_ADMIN_USER}", "password": "${QA_ADMIN_PASSWORD}" } }
```

A missing required variable fails fast with a clear message instead of producing
a confusing test failure later.

---

## Roadmap

| Phase                     | Scope                                                                 | Status |
| ------------------------- | --------------------------------------------------------------------- | ------ |
| 1 — Foundation            | Monorepo, Playwright + POM + fixtures, config, reporting, Docker, CI   | Done   |
| 2 — AI layer              | DOM understanding + root cause analysis **done**; self-healing, test-case and script generation next | Started |
| 3 — Dashboard             | Live browser view, live logs, pass/fail, screenshots, video, timeline  | Later  |
| 4 — Enterprise            | Jira, Azure DevOps, Slack, Teams, test management, RBAC, analytics     | Later  |

See `docs/` for the architecture decisions and the Phase 2 implementation order.
