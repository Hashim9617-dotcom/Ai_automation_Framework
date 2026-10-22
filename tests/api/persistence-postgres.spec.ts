import { test, expect } from '@playwright/test';
import { resolveDatabaseUrl } from '../../apps/api/src/config/database';
import {
  APPEND_ONLY_TABLES,
  FORBIDDEN_ON_APPEND_ONLY,
} from '../../apps/api/src/modules/persistence/append-only';
import {
  PrismaApplicationRepository,
  PrismaAuditRepository,
  PrismaInviteRepository,
  PrismaMembershipRepository,
  PrismaRunRepository,
  PrismaService,
  PrismaSessionRepository,
  PrismaUserRepository,
} from '../../apps/api/src/modules/persistence/prisma';
import { RunStatus, type Run } from '@aitp/shared';
import {
  CONTRACT,
  CONTRACT_USER_ID,
  ISO,
  define,
  type ErasedSubject,
} from '../support/repository-contract';
import type {
  ApplicationRow,
  InviteRow,
  MembershipRow,
  SessionRow,
  UserRow,
} from '../../apps/api/src/modules/persistence/repositories';

/**
 * THE POSTGRES HALF: the grants that hold, and the contract that still works
 * inside them.
 *
 * `docs/design/B1-auth-and-data.md` §1 and §6. Two groups, and they matter
 * TOGETHER:
 *
 *  - the GRANTS say what the application role cannot do;
 *  - the CONTRACT says the repositories still work within what it can.
 *
 * Either alone is satisfiable by something broken. A role with no privileges at
 * all passes every refusal in the first group; a role with every privilege
 * passes the whole second group. Only the pair says the configuration is right.
 *
 * ## The contract assertions are the SAME nine the unit suite runs
 *
 * Imported from `tests/support/repository-contract.ts`, which
 * `tests/unit/persistence.spec.ts` calls with the in-memory stores and this file
 * calls with the Prisma ones. One suite, two implementations — the only thing
 * that catches a divergence, because a stub written by the author of the code it
 * serves cannot falsify itself. Neither half states the property alone (§L).
 *
 * ## `@db`, and excluded from `pnpm verify`
 *
 * These need a PostgreSQL server. `pnpm verify` runs on every commit on a
 * developer machine and must not, which is why the in-memory implementations
 * stay. `scripts/test-api.mjs` excludes `@db` the way it already excludes
 * `@smoke`, and `pnpm test:db` is what runs them.
 */

const configured = resolveDatabaseUrl(process.env.DATABASE_URL);

/** SQLSTATE 42501 — `insufficient_privilege`. */
const PERMISSION_DENIED = '42501';

const sqlState = (error: unknown): string | undefined => {
  const shaped = error as { meta?: { code?: string }; code?: string } | undefined;
  return shaped?.meta?.code ?? shaped?.code;
};

/** Thrown to roll a transaction back after the thing under test has happened. */
class RollbackSignal extends Error {}

test.describe('the Postgres persistence half @api @db', () => {
  /**
   * SERIAL, because there is ONE database and `reset()` below empties it.
   *
   * Measured rather than anticipated: with the api project's `fullyParallel`,
   * the first run of this suite had C4, C5 and C6 fail and both run-history
   * tests come back FLAKY — this file's `reset()` was deleting rows the other
   * file had just written, and vice versa. C6 ("an empty store lists nothing")
   * cannot be made parallel-safe by scoping ids, because an empty table is the
   * subject.
   *
   * This handles tests WITHIN the file. Across files, `pnpm test:db` passes
   * `--workers=1` — a shared mutable resource cannot be partitioned by worker,
   * and pretending otherwise is how two correct suites make each other red.
   */
  test.describe.configure({ mode: 'serial' });
  // SKIPPED WITH A STATED REASON, never silently. The design is explicit: a
  // contributor with no database must see why this did not run, and must never
  // see it reported as passing.
  test.skip(
    configured.state !== 'configured',
    'DATABASE_URL is not configured, so the Postgres half cannot run. This is SKIPPED, ' +
      'not passing — see `pnpm db:deploy` then `pnpm test:db`.',
  );
  test.setTimeout(180_000);

  let prisma: PrismaService;

  test.beforeAll(() => {
    prisma = new PrismaService();
  });
  test.afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * Empty every table a subject writes to, and `"AuditEvent"` is deliberately
   * NOT one of them.
   *
   * `deleteMany` rather than TRUNCATE, because the role has no TRUNCATE — which
   * is the property G3 asserts. The audit table cannot be cleared at all, which
   * is why `c9AuditAppendOnly` scopes itself to an actor id it generates.
   */
  const clearAll = async (): Promise<void> => {
    await prisma.testRun.deleteMany({});
    await prisma.run.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.invite.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.application.deleteMany({});
    await prisma.user.deleteMany({});
  };

  /**
   * A clean slate PLUS the foreign-key parent, for the subjects that need one.
   *
   * `Session.userId`, `Invite.createdById` and `Membership.userId` are real
   * foreign keys here and nothing at all in memory. The parent has to exist for
   * those three — and must NOT exist for `PrismaUserRepository`, because it is
   * itself a `User` row and would appear in `list()`. Measured: seeding once for
   * every subject made C4 return `['u1', 'newest', 'middle', 'oldest']`.
   *
   * That is why `ContractSubject.prepare` is per SUBJECT: the row one subject
   * requires is a row another must not see.
   */
  const clearAndSeedParent = async (): Promise<void> => {
    await clearAll();
    await prisma.user.create({
      data: {
        id: CONTRACT_USER_ID,
        email: 'contract-seed@example.test',
        // Deliberately OLD, so that if a future assertion does list users
        // alongside a parent, the parent sorts last rather than first.
        createdAt: new Date(Date.UTC(2000, 0, 1)),
        updatedAt: new Date(Date.UTC(2000, 0, 1)),
      },
    });
  };

  // ── The grants ─────────────────────────────────────────────────────────────

  test('G1: UPDATE on an append-only table is refused with a PERMISSION error', async () => {
    // wrong: it succeeds, and §6's one real control is gone — the audit log
    // becomes rewritable by the process whose actions it records. Asserted on
    // SQLSTATE 42501 and not on "an error": a typo in the SQL, or a table name
    // that does not exist, also throws, and reading that as proof of a refused
    // permission is how a sweep comes to prove nothing (§X).
    for (const table of APPEND_ONLY_TABLES) {
      let state: string | undefined;
      try {
        await prisma.$executeRawUnsafe(`UPDATE "${table}" SET action = 'x'`);
      } catch (error) {
        state = sqlState(error);
      }
      expect(state, `UPDATE on "${table}" was not refused with insufficient_privilege`).toBe(
        PERMISSION_DENIED,
      );
    }
  });

  test('G2: DELETE on an append-only table is refused with a PERMISSION error', async () => {
    // wrong: history can be erased rather than rewritten, which is the same loss
    // by a different verb — and an audit log that can lose rows cannot answer
    // "has anyone been probing this", which is most of what it is for.
    for (const table of APPEND_ONLY_TABLES) {
      let state: string | undefined;
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
      } catch (error) {
        state = sqlState(error);
      }
      expect(state, `DELETE on "${table}" was not refused with insufficient_privilege`).toBe(
        PERMISSION_DENIED,
      );
    }
  });

  test('G3: TRUNCATE on an append-only table is refused with a PERMISSION error', async () => {
    // wrong: TRUNCATE is a SEPARATE PostgreSQL privilege, so "we never granted
    // it" and "it cannot be exercised" are different statements — and only the
    // second survives someone later adding a blanket GRANT ALL. The grants
    // migration revokes it explicitly for exactly this reason.
    for (const table of APPEND_ONLY_TABLES) {
      let state: string | undefined;
      try {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}"`);
      } catch (error) {
        state = sqlState(error);
      }
      expect(state, `TRUNCATE "${table}" was not refused with insufficient_privilege`).toBe(
        PERMISSION_DENIED,
      );
    }
  });

  test('G4: INSERT and SELECT on the append-only table DO work', async () => {
    // wrong: and this is the half without which G1-G3 prove nothing. A role
    // granted NOTHING passes every refusal above — so an append-only table that
    // could not be appended to or read would look perfectly configured. This is
    // what tells a correct grant from a missing one.
    //
    // The INSERT is proven inside a transaction that ROLLS BACK: the permission
    // is checked at execution, so the proof lands without leaving a row. It
    // could not be cleaned up afterwards anyway — which is the point of the table.
    await expect(prisma.auditEvent.count()).resolves.toBeGreaterThanOrEqual(0);

    const before = await prisma.auditEvent.count();
    let inserted = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.auditEvent.create({
          data: {
            id: `probe-${Date.now()}`,
            action: 'persistence-postgres probe',
            outcome: 'allowed',
          },
        });
        inserted = true;
        throw new RollbackSignal();
      });
    } catch (error) {
      if (!(error instanceof RollbackSignal)) throw error;
    }
    expect(inserted, 'the INSERT was refused').toBe(true);
    // And the rollback actually rolled back, so this test leaves nothing behind
    // in a table nothing can clean.
    expect(await prisma.auditEvent.count()).toBe(before);
  });

  test('G5: CREATE TABLE is refused, and no append-only table is UPDATE/DELETE-able', async () => {
    // wrong (first half): a role that can CREATE TABLE can DROP and recreate
    // "AuditEvent", which makes every revoke above removable by the thing it
    // restricts. The grants migration revokes CREATE on the schema for this.
    let state: string | undefined;
    try {
      await prisma.$executeRawUnsafe('CREATE TABLE "_should_not_exist" (x int)');
    } catch (error) {
      state = sqlState(error);
    }
    expect(state, 'CREATE TABLE was not refused with insufficient_privilege').toBe(
      PERMISSION_DENIED,
    );

    // wrong (second half): `ALTER DEFAULT PRIVILEGES` grants the four verbs on
    // every FUTURE table, so a new append-only table arrives writable and the
    // grants migration must revoke for each one deliberately. This is what makes
    // that omission loud rather than silent — the question is asked of the
    // SERVER, so the declaration in APPEND_ONLY_TABLES is checked against fact
    // rather than against a second list (§AE).
    const writable = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`
      SELECT DISTINCT table_name
      FROM information_schema.table_privileges
      WHERE grantee = current_user
        AND table_schema = 'public'
        AND privilege_type IN ('UPDATE', 'DELETE')
      ORDER BY table_name`);
    const names = writable.map((row) => row.table_name);

    // §T — the sweep had a SUBJECT. An empty answer is also what a role with no
    // privileges, or a wrong `grantee`, produces — and over that every
    // append-only table is trivially absent and the assertion below is vacuous.
    expect(
      names.length,
      'the role can UPDATE/DELETE nothing at all — either the grants did not apply or ' +
        'this query asked about the wrong grantee, and over an empty answer the check ' +
        'below proves nothing',
    ).toBeGreaterThan(0);

    for (const table of APPEND_ONLY_TABLES) {
      expect(
        names,
        `"${table}" is declared append-only and the role can UPDATE or DELETE it. Add a ` +
          'REVOKE to the grants migration, or remove it from APPEND_ONLY_TABLES on purpose.',
      ).not.toContain(table);
    }

    // The forbidden set is the three that rewrite or erase. Pinned here because
    // the sweep above only asks about two of them; TRUNCATE is G3's subject.
    expect([...FORBIDDEN_ON_APPEND_ONLY].sort()).toEqual(['DELETE', 'TRUNCATE', 'UPDATE']);
  });

  // ── The contract, against Postgres ─────────────────────────────────────────

  const runRow = (id: string, createdAt: string): Run => ({
    id,
    status: RunStatus.Queued,
    request: { environment: 'local', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt,
    results: [],
    artifacts: {},
  });

  const subjects = (): ErasedSubject[] => [
    define<Run>({
      name: 'PrismaRunRepository',
      make: () => new PrismaRunRepository(prisma),
      row: runRow,
      keyOf: (row) => row.id,
      // No foreign-key parent needed: `Run.applicationId` is nullable.
      prepare: clearAll,
    }),
    define<UserRow>({
      name: 'PrismaUserRepository',
      make: () => new PrismaUserRepository(prisma),
      row: (id, createdAt) => ({
        id,
        email: `${id}@example.test`,
        displayName: null,
        passwordHash: null,
        authProviderId: 'local',
        externalId: null,
        disabledAt: null,
        createdAt,
        updatedAt: createdAt,
      }),
      keyOf: (row) => row.id,
      // NO PARENT, and this is the subject that proved why `prepare` must be per
      // subject: the parent user is itself a `User` row, so seeding it here put a
      // fourth entry at the front of C4's list.
      prepare: clearAll,
    }),
    define<SessionRow>({
      name: 'PrismaSessionRepository',
      make: () => new PrismaSessionRepository(prisma),
      row: (tokenHash, createdAt) => ({
        tokenHash,
        // A REAL foreign key here, and nothing at all in memory — which is
        // exactly the kind of divergence one shared contract exists to find.
        userId: CONTRACT_USER_ID,
        createdAt,
        lastSeenAt: createdAt,
        idleExpiresAt: ISO(59),
        absoluteExpiresAt: ISO(59),
        createdIp: null,
        createdUserAgent: null,
        revokedAt: null,
        revokedReason: null,
      }),
      keyOf: (row) => row.tokenHash,
      // Session.userId is a real FK, so the parent must exist.
      prepare: clearAndSeedParent,
    }),
    define<InviteRow>({
      name: 'PrismaInviteRepository',
      make: () => new PrismaInviteRepository(prisma),
      row: (tokenHash, createdAt) => ({
        tokenHash,
        email: `${tokenHash}@example.test`,
        role: 'QA',
        scope: 'app',
        applicationId: null,
        createdById: CONTRACT_USER_ID,
        createdAt,
        expiresAt: ISO(59),
        acceptedAt: null,
        revokedAt: null,
      }),
      keyOf: (row) => row.tokenHash,
      // Invite.createdById is a real FK.
      prepare: clearAndSeedParent,
    }),
    define<ApplicationRow>({
      name: 'PrismaApplicationRepository',
      make: () => new PrismaApplicationRepository(prisma),
      row: (id, createdAt) => ({
        // `slug` is UNIQUE, so distinct keys must give distinct slugs or C4 and
        // C5 collide on a constraint rather than on the property under test.
        id,
        slug: `slug-${id}`,
        name: `App ${id}`,
        createdAt,
        updatedAt: createdAt,
      }),
      keyOf: (row) => row.id,
      // No FK out of Application.
      prepare: clearAll,
    }),
    define<MembershipRow>({
      name: 'PrismaMembershipRepository',
      make: () => new PrismaMembershipRepository(prisma),
      row: (id, createdAt) => ({
        id,
        userId: CONTRACT_USER_ID,
        applicationId: null,
        // @@unique([userId, applicationId, role]) — distinct per key, same reason
        // as the slug above.
        role: `QA-${id}`,
        scope: 'app',
        createdAt,
      }),
      keyOf: (row) => row.id,
      // Membership.userId is a real FK.
      prepare: clearAndSeedParent,
    }),
  ];

  for (const entry of CONTRACT) {
    test(`${entry.id} (Postgres): ${entry.title}`, async () => {
      // wrong: the in-memory implementation passes all nine, so green here is
      // not a restatement — it is the half that says the Prisma implementation
      // behaves the same way. Where the two can differ is exactly where this
      // earns its place: real foreign keys, real unique constraints, a real
      // ORDER BY, and `Date` crossing a boundary the row types declare as ISO
      // strings. Each of those broke the first draft.
      // Each subject prepares itself (`prepare` above); these three prepare the
      // single-store assertions. C7 must see NO parent user — it creates its
      // own — while C8 needs one for the session's foreign key, and the audit
      // table cannot be cleared at all, so C9 scopes itself to an actor id it
      // generates.
      await entry.run({
        subjects: subjects(),
        users: async () => {
          await clearAll();
          return new PrismaUserRepository(prisma);
        },
        sessions: async () => {
          await clearAndSeedParent();
          return new PrismaSessionRepository(prisma);
        },
        audit: async () => Promise.resolve(new PrismaAuditRepository(prisma)),
      });
    });
  }
});
