import { faker } from '@faker-js/faker';

/**
 * Deterministic-by-default test data. Seed comes from TEST_DATA_SEED so a failing
 * run can be reproduced exactly — important once the AI layer starts generating
 * its own data and you need to replay a failure.
 */
const seed = process.env.TEST_DATA_SEED ? Number(process.env.TEST_DATA_SEED) : undefined;
if (seed !== undefined && Number.isFinite(seed)) faker.seed(seed);

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

export const dataFactory = {
  employee(overrides: Partial<EmployeeData> = {}): EmployeeData {
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
  },

  /** Unique string safe for fields that must not collide across parallel workers. */
  unique(prefix = 'aitp'): string {
    return `${prefix}-${Date.now().toString(36)}-${faker.string.alphanumeric(6).toLowerCase()}`;
  },

  password(): string {
    return `${faker.internet.password({ length: 12 })}A1!`;
  },
};
