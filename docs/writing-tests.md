# Writing tests

## The shape of a spec

```ts
import { test, expect } from '@aitp/execution-engine';
import { LoginPage } from '../pages/login.page';

test.describe('Authentication', { tag: ['@smoke', '@auth'] }, () => {
  test('valid credentials sign the user in', async ({ makePage, env, page }) => {
    const login = makePage(LoginPage);
    await login.open();
    await login.login(env.users.admin!.username, env.users.admin!.password);
    await expect(page.getByTestId('current-user')).toHaveText(env.users.admin!.username);
  });
});
```

Import `test` and `expect` from `@aitp/execution-engine`, never from
`@playwright/test` — that is what gives you the fixtures below. API-layer specs
import `apiTest` instead, so no browser is launched.

## Fixtures

| Fixture             | Use                                                              |
| ------------------- | ---------------------------------------------------------------- |
| `env`               | The resolved environment config (URLs, users, timeouts, flags)   |
| `makePage(Page)`    | Builds a page object with the right locator options wired in     |
| `api`               | `ApiClient` for backend calls and backend state verification     |
| `data`              | Deterministic test-data factory (`data.employee()`)              |
| `log`               | Scoped structured logger                                         |
| `locatorTelemetry`  | Every locator resolution in this test                            |
| `diagnostics`       | Auto: console errors, page errors, 5xx/failed requests           |

`diagnostics` runs automatically. On failure it attaches the console/network
signals *and* a DOM snapshot of the page, captured while the page is still alive.
Both are lifted into `run.json` and are exactly what `pnpm rca` reads.

This is worth knowing when you write assertions: the more specific your failure,
the better the analysis. `expect(banner).toHaveClass(/success/)` gives the analyzer
something to work with; a bare `expect(true).toBe(false)` does not.

## Page objects

Extend `BasePage`, declare a `path`, and express *business actions*. Keep
assertions about the page's own state on the page object (`expectSaved()`), and
assertions about the outcome of a scenario in the spec.

```ts
export class EmployeesPage extends BasePage {
  protected readonly path = '/employees';

  private readonly save = locator('employee.save', 'Save employee button', [
    { strategy: 'testId', value: 'employee-save', confidence: 1 },
    { strategy: 'role', value: 'button', options: { name: 'Save employee' } },
  ]);

  async register(employee: EmployeeInput): Promise<void> { /* ... */ }
}
```

### Writing good locator candidates

Order matters — the first match wins.

1. `testId` — ask the developers for `data-testid`; it is the cheapest win in the
   whole platform.
2. `role` + accessible name — survives restyling and reorganisation.
3. `label` / `placeholder` — good for forms.
4. `css` / `xpath` — last resort. Brittle by nature; that is fine as a fallback,
   not as a primary.

Give every spec a real `key` (`employee.form.saveButton`) and a real
`description`. Both are used in logs, in healing history, and by the AI when it
has to re-derive the locator.

## Tags

| Tag           | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `@smoke`      | Fast, critical path. Runs on every commit.       |
| `@regression` | Full coverage. Runs nightly.                     |
| `@api`        | API-layer test.                                  |
| `@<feature>`  | Feature area, e.g. `@auth`, `@pim`.              |

Tags are also how the AI Command Box finds tests, so they earn their keep twice.
Run a subset with `pnpm exec playwright test --grep @smoke`.

## Test data

`data.employee()` returns a full record. Set `TEST_DATA_SEED` in `.env` to make
generated data reproducible — you will want that the first time a nightly failure
does not reproduce locally.

Use `data.unique()` for any field that must not collide across parallel workers.

## Independence

Every test must set up its own state and must not depend on ordering — the suite
runs `fullyParallel`. Use `beforeEach` for the arrange step (see
`tests/e2e/employee-registration.spec.ts`) rather than chaining tests together.
