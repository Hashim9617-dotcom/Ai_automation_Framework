/**
 * THE PERSISTENCE INTERFACES, and the rows they carry.
 *
 * `docs/design/B1-auth-and-data.md` §1. Each is an abstract class with an
 * in-memory implementation (`in-memory.ts`) and, once the schema is applied, a
 * Prisma one — bound by the module, so swapping storage touches one file. That
 * is ADR-008's promise and this is where it gets kept.
 *
 * **The in-memory implementations are not scaffolding.** `pnpm verify` runs on
 * every commit on a developer machine and must not need a database, so unit and
 * demo bind these. Keeping both is what makes that true.
 *
 * ## B1b is PERSISTENCE ONLY
 *
 * Nothing here hashes a password, mints a token, checks an expiry for the
 * purpose of letting someone in, or decides what anybody may do. Those are B1c
 * and B1d. These interfaces store and retrieve rows, and the two places where
 * they look like they are deciding something — `findActive` and
 * `AuditRepository` having no mutator — are explained where they appear.
 *
 * ## Dates are ISO strings
 *
 * Matching the canonical `Run` in `packages/shared/src/types/run.ts`, which has
 * always used them. A repository that handed back `Date` objects for its own
 * rows and strings for runs would make the boundary depend on which table you
 * came from.
 */

/** A dashboard user. `passwordHash` is NULL for an SSO identity (§8). */
export interface UserRow {
  id: string;
  /** Lower-cased by the repository, so uniqueness is case-insensitive. */
  email: string;
  displayName: string | null;
  /** A PHC string, produced in B1c. Opaque here. */
  passwordHash: string | null;
  authProviderId: string;
  externalId: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A role+scope grant, over one application or (with a null application) all. */
export interface MembershipRow {
  id: string;
  userId: string;
  applicationId: string | null;
  role: string;
  scope: string;
  createdAt: string;
}

/** A session row. The key is the token's HASH; the token is never stored (§3). */
export interface SessionRow {
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  createdIp: string | null;
  createdUserAgent: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** A single-use invitation. There is no self-registration (§4). */
export interface InviteRow {
  tokenHash: string;
  email: string;
  role: string;
  scope: string;
  applicationId: string | null;
  createdById: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/** Who did what, when, from where (§6). */
export interface AuditEventRow {
  id: string;
  at: string;
  actorUserId: string | null;
  /** The actor AS THEY WERE. An id alone stops saying who acted (§6). */
  actorEmail: string | null;
  actorRole: string | null;
  actorScope: string | null;
  actorTokenId: string | null;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  applicationId: string | null;
  outcome: 'allowed' | 'denied' | 'failed';
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  detail: Record<string, unknown>;
}

/** One application under test. */
export interface ApplicationRow {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The three methods every keyed repository here shares.
 *
 * Declared as a TYPE and not a base class the others extend, deliberately:
 * `RunRepository` already exists with exactly this shape
 * (`apps/api/src/modules/runs/run.repository.ts`) and §1 says the interface
 * stays exactly as it is. So the contract suite matches STRUCTURALLY — anything
 * with these three methods can be handed to it, including the one repository
 * that predates this file and knows nothing about it.
 */
export interface KeyedStore<T> {
  save(entity: T): Promise<T>;
  findById(id: string): Promise<T | undefined>;
  /** Newest first. */
  list(limit: number): Promise<T[]>;
}

export abstract class UserRepository implements KeyedStore<UserRow> {
  abstract save(user: UserRow): Promise<UserRow>;
  abstract findById(id: string): Promise<UserRow | undefined>;
  abstract list(limit: number): Promise<UserRow[]>;
  /** Case-insensitive, because an email address is. */
  abstract findByEmail(email: string): Promise<UserRow | undefined>;
}

export abstract class SessionRepository implements KeyedStore<SessionRow> {
  abstract save(session: SessionRow): Promise<SessionRow>;
  /** The raw row, whatever its state. For administration and for tests. */
  abstract findById(tokenHash: string): Promise<SessionRow | undefined>;
  abstract list(limit: number): Promise<SessionRow[]>;
  /**
   * The row only if it is neither revoked nor past either expiry.
   *
   * This is a QUERY and not an authorization decision: B1c decides what to do
   * with the answer. It lives here because the three conditions are a property
   * of the row, and a caller reassembling them is a caller that can get one
   * wrong — the idle clock and the absolute clock are easy to confuse, and §3
   * turns on the absolute one never moving.
   *
   * `now` is a PARAMETER. A repository that read the clock could not be tested
   * for an expiry boundary without waiting for one (§AJ).
   */
  abstract findActive(tokenHash: string, now: string): Promise<SessionRow | undefined>;
  /** Returns how many were revoked, so a caller can audit the count. */
  abstract revokeAllForUser(userId: string, now: string, reason: string): Promise<number>;
}

export abstract class InviteRepository implements KeyedStore<InviteRow> {
  abstract save(invite: InviteRow): Promise<InviteRow>;
  abstract findById(tokenHash: string): Promise<InviteRow | undefined>;
  abstract list(limit: number): Promise<InviteRow[]>;
  abstract listForEmail(email: string, limit: number): Promise<InviteRow[]>;
}

export abstract class ApplicationRepository implements KeyedStore<ApplicationRow> {
  abstract save(application: ApplicationRow): Promise<ApplicationRow>;
  abstract findById(id: string): Promise<ApplicationRow | undefined>;
  abstract list(limit: number): Promise<ApplicationRow[]>;
  abstract findBySlug(slug: string): Promise<ApplicationRow | undefined>;
}

export abstract class MembershipRepository implements KeyedStore<MembershipRow> {
  abstract save(membership: MembershipRow): Promise<MembershipRow>;
  abstract findById(id: string): Promise<MembershipRow | undefined>;
  abstract list(limit: number): Promise<MembershipRow[]>;
  abstract listForUser(userId: string): Promise<MembershipRow[]>;
}

/**
 * APPEND-ONLY, and the interface is the smaller half of saying so.
 *
 * There is no `save`, no `update` and no `delete` — not as a convention but
 * because §6's control is a database GRANT (`INSERT, SELECT` on `"AuditEvent"`
 * and nothing else), and an interface that offered a mutator would be offering
 * something the role cannot perform. The grant is the control; this is the
 * convenience. Stated here because an interface with no update method, on its
 * own, is exactly the kind of convention this repo has watched get worked
 * around.
 *
 * It deliberately does NOT implement `KeyedStore`: `save` is the method that
 * must not exist, so sharing a shape that requires it would be the wrong
 * abstraction, and the contract suite treats this one separately.
 */
export abstract class AuditRepository {
  abstract append(event: AuditEventRow): Promise<AuditEventRow>;
  /** Newest first. */
  abstract list(limit: number): Promise<AuditEventRow[]>;
  abstract listForActor(actorUserId: string, limit: number): Promise<AuditEventRow[]>;
}
