import { faker } from '@aitp/execution-engine';

/**
 * Employee test data for the HR-shaped applications this repo tests.
 *
 * **This lives in `tests/`, not in `packages/`, and that is the whole point.**
 * `packages/` is the app-agnostic side of the line: it may not describe one
 * application's nouns. `firstName`, `employeeId`, `jobTitle`, `hireDate` are
 * the vocabulary of a particular domain, and a second application would inherit
 * them as dead weight — or worse, as a precedent that domain types belong in
 * the engine.
 *
 * Moved out of `packages/execution-engine/src/data/factory.ts` on 2026-09-08,
 * after the app-agnostic audit flagged it twice. What stayed behind is
 * genuinely generic: `unique()` and `password()` describe no application.
 *
 * The seed is the factory's, so a failing run still reproduces exactly.
 */
export interface EmployeeData {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  employeeId: string;
  phone: string;
  jobTitle: string;
  department: string;
  hireDate: string;
}

export function employeeData(overrides: Partial<EmployeeData> = {}): EmployeeData {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email: faker.internet.email({ firstName, lastName }).toLowerCase(),
    employeeId: `EMP${faker.number.int({ min: 10_000, max: 99_999 })}`,
    phone: faker.phone.number({ style: 'international' }),
    jobTitle: faker.person.jobTitle(),
    department: faker.commerce.department(),
    hireDate: faker.date.recent({ days: 365 }).toISOString().slice(0, 10),
    ...overrides,
  };
}
