-- B1b: what the application role may do, applied BY THE MIGRATION.
--
-- Runs as the owner (pnpm db:deploy supplies AITP_DB_OWNER_URL). These grants
-- are not printed for a human to issue: a grant somebody has to remember is a
-- grant that eventually is not issued, and docs/design/B1-auth-and-data.md §6
-- says the control is the PERMISSION, not the repository interface. An
-- interface with no update method is a convention; this is enforcement.
--
-- Hand-written rather than generated, because `prisma migrate diff` describes
-- tables and knows nothing about roles. It is idempotent, so a re-run or a
-- `migrate resolve` cannot leave the grants half-applied.
--
-- The role name is NOT a parameter. Prisma migrations are plain SQL with no
-- substitution, and inventing one would mean this file disagreeing with
-- DATABASE_URL in a way nothing checks. `pnpm test:db` asserts the outcome
-- against whoever DATABASE_URL actually is, which is the half that catches a
-- mismatch.

-- ── 1. Reach the schema, but never change it ────────────────────────────────
--
-- USAGE lets the role resolve names inside `public`. CREATE is deliberately NOT
-- granted: a role that can CREATE TABLE can also DROP and recreate "AuditEvent",
-- which would make every restriction below removable by the thing they restrict.
GRANT USAGE ON SCHEMA public TO aitp_app;
REVOKE CREATE ON SCHEMA public FROM aitp_app;

-- ── 2. Ordinary tables: the four verbs the code needs, and nothing else ─────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aitp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aitp_app;

-- Tables a LATER migration creates would otherwise arrive ungranted, and the
-- symptom is one endpoint failing with "permission denied for table X" long
-- after this ran. The default applies to objects the OWNER creates, which is who
-- every migration runs as.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aitp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aitp_app;

-- ── 3. "AuditEvent" is APPEND-ONLY ──────────────────────────────────────────
--
-- INSERT and SELECT only. The REVOKE is what makes §6 true, and it comes AFTER
-- the blanket grant above on purpose — ordering is the whole correctness of this
-- file, and a reader who moves it up silently re-grants what it takes away.
--
-- TRUNCATE is revoked explicitly even though it is not in the grant above:
-- PostgreSQL treats it as a separate privilege, so "we never granted it" and
-- "it cannot be exercised" are different statements, and only the second is
-- worth relying on.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditEvent" FROM aitp_app;

-- And for every future table too, so a migration that adds one cannot
-- accidentally hand back what this revoked on this one.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM aitp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM aitp_app;

-- ── 4. No DDL anywhere, stated rather than assumed ─────────────────────────
--
-- Being a non-owner already prevents ALTER and DROP on the owner's tables, and
-- CREATE was revoked in step 1. These are belt-and-braces for the two things a
-- non-superuser role could otherwise still do at the database level.
REVOKE CREATE ON DATABASE aitp FROM aitp_app;
REVOKE ALL ON SCHEMA information_schema FROM aitp_app;
GRANT USAGE ON SCHEMA information_schema TO aitp_app;
