# Setting this up on a new machine

This is the **live copy** taken from `C:\Users\xtpl\git\ai-testing-platform`, including
every fix made so far. Two things are deliberately **not** in this zip:

- `.env` — it holds your DMS credentials. Recreate it (step 3).
- `artifacts/` — it holds live session cookies. It regenerates itself.

---

## 1. Prerequisites

Check what you already have:

```powershell
node -v      # need v20 or newer
pnpm -v
git --version
```

Missing anything?

- **Node.js** — install the LTS build from https://nodejs.org (this also gives you `npx`).
- **pnpm** — `npm install -g pnpm`
- **git** — https://git-scm.com/download/win

On Windows, PowerShell blocks `pnpm.ps1`, so **always type `pnpm.cmd`, not `pnpm`**.

## 2. Install dependencies

```powershell
cd <wherever-you-extracted>\ai-testing-platform
pnpm.cmd install
pnpm.cmd exec playwright install --with-deps chromium
```

The second command downloads the browser and takes a few minutes.

## 3. Create `.env`

```powershell
copy .env.example .env
notepad .env
```

Fill in exactly these four:

```
TEST_ENV=app
BASE_URL=https://dmsuiv3.aitalkx.com
APP_USERNAME=<your DMS email>
APP_PASSWORD=<your DMS password>
```

`BASE_URL` is the domain only — no `/login`. No quotes, no spaces around `=`.

`.env` is gitignored and must never be committed.

## 4. Prove the install works — no app needed

```powershell
pnpm.cmd test --project=unit
```

This runs the bundled unit tests with no browser and no network. Green here means
the monorepo, TypeScript paths and workspace links are all correct.

## 5. Run against DMS

```powershell
pnpm.cmd test --project=chromium --grep @smoke
```

The `setup` project logs in automatically from `.env` before the tests run — no
manual browser step. If you ever need to sign in by hand (SSO, MFA, OTP):

```powershell
pnpm.cmd auth
```

Then the full suite:

```powershell
pnpm.cmd test --project=chromium
pnpm.cmd test:report
```

## 6. Then do the thing that stops this happening again

There is no git remote configured. That is why the code has been living on one
disk. Create an empty private repo on the company GitHub, then:

```powershell
git init
git status          # confirm .env and artifacts/ are NOT listed
git add .
git commit -m "AI testing platform"
git branch -M main
git remote add origin <repo-url>
git push -u origin main
```

**Stop and check** before `git add .` — if `.env` or `artifacts/` appear in
`git status`, do not commit. They contain credentials and live session cookies.

After that, any machine is one `git clone` + `pnpm.cmd install` away.

---

## Where to read next

| File | What it covers |
| --- | --- |
| `docs/dms-findings.md` | Every finding so far — app bugs and platform bugs, with evidence |
| `docs/dms-suite.md` | What the 45 DMS tests cover and how to tune them |
| `tests/app/README.md` | Locator strategy, safety rules, sample-data env vars |
| `docs/architecture-decisions.md` | Why the platform is built the way it is |
| `docs/phase-2-plan.md` | What comes next in the AI layer |
