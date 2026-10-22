/**
 * Tables the application role may INSERT into and SELECT from, and nothing else.
 *
 * `docs/design/B1-auth-and-data.md` §6. The CONTROL is the database grant issued
 * by `prisma/migrations/..._b1b_grants_for_app_role/migration.sql`; this list is
 * what lets a test ask whether that grant is still in force.
 *
 * ## Why a declared list is necessary here, and is not the §AE mistake
 *
 * §AE says a hand-written list beside a derived set is acceptable only when the
 * worst a missing entry can do is degrade a MESSAGE. A missing entry here would
 * do worse than that — so the list is not the thing being trusted.
 *
 * The derived set is what `information_schema.table_privileges` reports: every
 * table the role can actually UPDATE or DELETE. The test compares the two and
 * fails if any name below appears in it. So:
 *
 *  - a table named here that is NOT protected  -> the test fails (the grant
 *    regressed, which is the case that matters);
 *  - a table protected but not named here      -> no failure, and no harm: it is
 *    simply more locked down than declared;
 *  - a NEW append-only table nobody adds here  -> the gap this list cannot close
 *    on its own, which is why `ALTER DEFAULT PRIVILEGES` grants the four verbs
 *    to future tables and the migration must REVOKE for each new one
 *    deliberately. Adding the name here is how that becomes a visible act.
 *
 * There is no structural way to ask Prisma "is this model append-only" — it is a
 * policy, not a property of the schema — so the declaration has to live
 * somewhere. It lives in production code rather than in the test so that the
 * policy and the code that respects it sit together, and so a second copy cannot
 * drift.
 */

/**
 * Model names as Prisma spells them, which is also how the tables are named —
 * the schema uses no `@@map`, so `AuditEvent` is the table name and needs
 * quoting in SQL.
 */
export const APPEND_ONLY_TABLES: readonly string[] = ['AuditEvent'];

/** The privileges that must never be held on a table above. */
export const FORBIDDEN_ON_APPEND_ONLY: readonly string[] = ['UPDATE', 'DELETE', 'TRUNCATE'];
