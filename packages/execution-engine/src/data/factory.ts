import { faker } from '@faker-js/faker';

/**
 * Deterministic-by-default test data. Seed comes from TEST_DATA_SEED so a failing
 * run can be reproduced exactly — important once the AI layer starts generating
 * its own data and you need to replay a failure.
 */
const seed = process.env.TEST_DATA_SEED ? Number(process.env.TEST_DATA_SEED) : undefined;
if (seed !== undefined && Number.isFinite(seed)) faker.seed(seed);

/**
 * Re-exported so tests can build their own DOMAIN data on the same seed.
 *
 * Domain vocabulary — employees, invoices, patients — belongs in `tests/`,
 * with the application it describes. What belongs here is the seeding, so a
 * failing run still reproduces exactly wherever the data was shaped.
 */
export { faker };

export const dataFactory = {
  /** Unique string safe for fields that must not collide across parallel workers. */
  unique(prefix = 'aitp'): string {
    return `${prefix}-${Date.now().toString(36)}-${faker.string.alphanumeric(6).toLowerCase()}`;
  },

  password(): string {
    return `${faker.internet.password({ length: 12 })}A1!`;
  },
};
