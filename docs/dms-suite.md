# The DMS suite — what it covers and how to run it

45 tests across 6 spec files, built from the 24-page inventory in
`artifacts/inspect/report.md`. Every locator, every label and every step name in
these files came out of that capture — nothing here is guessed.

## Run it

```powershell
$env:TEST_ENV="app"
pnpm.cmd auth            # once — a headed browser opens, you sign in, session is saved
pnpm.cmd test --project=chromium
```

Faster feedback loop while you're triaging:

```powershell
pnpm.cmd test --project=chromium --grep @smoke     # 6 tests, ~1 min
pnpm.cmd test --project=chromium --headed          # watch it work
pnpm.cmd test:report                               # open the HTML report
```

**Expect failures on the first run.** These tests have never executed against
the live system — they were written from a static capture. A first run that is
80% green is a good first run. Each red test is one of three things:

1. A locator that needs a small correction (the capture saw a different state)
2. Sample data that doesn't exist on your instance → set the env vars below
3. A real bug

Telling those apart is exactly what the RCA pass is for:

```powershell
pnpm.cmd rca
```

## What each file covers

| File | Tests | Covers |
| --- | --- | --- |
| `smoke.spec.ts` | 5 | App reachable, session valid, shell renders, test-id coverage logged |
| `navigation.spec.ts` | 9 | Every nav link lands on the right page; collapsible sections open |
| `file-explorer.spec.ts` | 11 | Workspace tree, filtering, contents pane, view/scope switching, context menus, create-workspace dialog |
| `global-search.spec.ts` | 6 | Query, type filters, count consistency, clear, select-all |
| `upload.spec.ts` | 9 | Both wizards' step gating — you cannot skip a step or submit nothing |
| `admin.spec.ts` | 10 | Users / Roles / Groups lists, search, pagination, create-form validation |

## The three tests worth knowing about

**`destructive bulk actions stay disabled with nothing selected`** — this is a
real safety property, not a UI nicety. If Delete or Archive ever becomes clickable
with an empty selection, someone loses documents. Cheap to assert, expensive to
miss.

**`the summary count agrees with the rows actually rendered`** — the classic
pagination-versus-total bug. The chip says "28 total", the page shows a slice.
The test asserts rendered ≤ reported; a violation means the summary is lying.

**`the group picker stays disabled until a role is chosen`** — the control names
itself "Select a role first". The suite asserts the dependency rather than
trusting the label, because labels and behaviour drift apart.

## Write tests

Three tests actually create data. They are skipped unless you opt in:

```powershell
$env:ALLOW_WRITES="true"; pnpm.cmd test --project=chromium --grep @write
```

They create a workspace, a role and a user, each with a unique generated name
(`aitp-ws-…`, `aitp-role-…`, `aitp-user-…`) so they never collide and are easy to
find and clean up afterwards. Run these against QA, never production.

## Sample data

| Variable | Default | Change it if… |
| --- | --- | --- |
| `DMS_SAMPLE_WORKSPACE` | `ABCD` | your instance has no `ABCD` workspace |
| `DMS_SAMPLE_FOLDER` | `auto Test 123` | that folder doesn't exist under it |
| `DMS_SEARCH_TERM` | `pension` | no document on your instance matches it |

```powershell
$env:DMS_SAMPLE_WORKSPACE="Finance"
```

## Why the locators look the way they do

The app has **no `data-testid` anywhere** — 0% across all 24 captured pages. What
it does have is genuinely good accessibility: `tree` / `treeitem` for the
workspace pane, `menu` / `menuitem` for context menus, `tablist` / `tab` for both
upload wizards, `toolbar` for the file actions, and an accessible name on every
control. Role + name gives locators that survive CSS refactors and class-name
churn better than test ids usually do.

Two places needed care:

- **Tree chevrons are all named just "Expand"** — there is no folder name on
  them in File Explorer. So `expandTreeNode()` scopes the chevron inside its own
  `treeitem` before clicking. (Bulk Upload's chevrons *are* named per folder,
  "Expand bulk1" — that wizard gets the simpler version.)
- **"More options" repeats on every row and every tile.** Both
  `openTreeNodeMenu()` and `openTileMenu()` scope it to the parent node first,
  which is why they take a name argument.

Each locator is still a *chain* of candidates, so when a test id does appear, it
slots in front as the preferred strategy and every spec picks it up for free.
