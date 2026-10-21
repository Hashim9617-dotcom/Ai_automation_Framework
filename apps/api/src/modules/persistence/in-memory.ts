import { Injectable } from '@nestjs/common';
import {
  ApplicationRepository,
  AuditRepository,
  InviteRepository,
  MembershipRepository,
  SessionRepository,
  UserRepository,
  type ApplicationRow,
  type AuditEventRow,
  type InviteRow,
  type MembershipRow,
  type SessionRow,
  type UserRow,
} from './repositories';

/**
 * IN-MEMORY STORAGE, and it is not a placeholder.
 *
 * `pnpm verify` runs on every commit on a developer machine and must not need a
 * database, so the unit and demo suites bind these. §1 keeps both
 * implementations for that reason, and the one parameterised contract suite is
 * what stops the two drifting — an in-memory repository written by the same
 * author as the code it serves is a stub that cannot falsify itself, and only
 * the same assertions meeting the real engine catch a divergence.
 *
 * Every `list` is newest-first, matching `InMemoryRunRepository`, which has
 * sorted that way since Phase 1. `localeCompare` on an ISO-8601 string is a
 * chronological sort because the format is designed to be — lexicographic and
 * chronological order coincide, which is why these rows carry strings.
 */

const newestFirst = <T>(rows: T[], at: (row: T) => string): T[] =>
  [...rows].sort((a, b) => at(b).localeCompare(at(a)));

/** Emails are compared case-insensitively, so they are stored folded. */
const fold = (email: string): string => email.trim().toLowerCase();

@Injectable()
export class InMemoryUserRepository extends UserRepository {
  private readonly rows = new Map<string, UserRow>();

  async save(user: UserRow): Promise<UserRow> {
    // FOLDED ON THE WAY IN, so `findByEmail` needs no scan and two rows
    // differing only in case cannot both exist. The address as typed is not
    // kept: nothing reads it, and two columns that must agree can disagree.
    const stored = { ...user, email: fold(user.email) };
    this.rows.set(stored.id, stored);
    return stored;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    return this.rows.get(id);
  }

  async list(limit: number): Promise<UserRow[]> {
    return newestFirst([...this.rows.values()], (row) => row.createdAt).slice(0, limit);
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const wanted = fold(email);
    return [...this.rows.values()].find((row) => row.email === wanted);
  }
}

@Injectable()
export class InMemorySessionRepository extends SessionRepository {
  private readonly rows = new Map<string, SessionRow>();

  async save(session: SessionRow): Promise<SessionRow> {
    this.rows.set(session.tokenHash, session);
    return session;
  }

  async findById(tokenHash: string): Promise<SessionRow | undefined> {
    return this.rows.get(tokenHash);
  }

  async list(limit: number): Promise<SessionRow[]> {
    return newestFirst([...this.rows.values()], (row) => row.createdAt).slice(0, limit);
  }

  async findActive(tokenHash: string, now: string): Promise<SessionRow | undefined> {
    const row = this.rows.get(tokenHash);
    if (!row) return undefined;
    // THREE conditions, and the absolute one is not the idle one. A session used
    // daily would live forever on the idle clock alone (§3).
    if (row.revokedAt !== null) return undefined;
    if (now >= row.idleExpiresAt) return undefined;
    if (now >= row.absoluteExpiresAt) return undefined;
    return row;
  }

  async revokeAllForUser(userId: string, now: string, reason: string): Promise<number> {
    let revoked = 0;
    for (const [key, row] of this.rows) {
      if (row.userId !== userId || row.revokedAt !== null) continue;
      this.rows.set(key, { ...row, revokedAt: now, revokedReason: reason });
      revoked += 1;
    }
    return revoked;
  }
}

@Injectable()
export class InMemoryInviteRepository extends InviteRepository {
  private readonly rows = new Map<string, InviteRow>();

  async save(invite: InviteRow): Promise<InviteRow> {
    const stored = { ...invite, email: fold(invite.email) };
    this.rows.set(stored.tokenHash, stored);
    return stored;
  }

  async findById(tokenHash: string): Promise<InviteRow | undefined> {
    return this.rows.get(tokenHash);
  }

  async list(limit: number): Promise<InviteRow[]> {
    return newestFirst([...this.rows.values()], (row) => row.createdAt).slice(0, limit);
  }

  async listForEmail(email: string, limit: number): Promise<InviteRow[]> {
    const wanted = fold(email);
    return newestFirst(
      [...this.rows.values()].filter((row) => row.email === wanted),
      (row) => row.createdAt,
    ).slice(0, limit);
  }
}

@Injectable()
export class InMemoryApplicationRepository extends ApplicationRepository {
  private readonly rows = new Map<string, ApplicationRow>();

  async save(application: ApplicationRow): Promise<ApplicationRow> {
    this.rows.set(application.id, application);
    return application;
  }

  async findById(id: string): Promise<ApplicationRow | undefined> {
    return this.rows.get(id);
  }

  async list(limit: number): Promise<ApplicationRow[]> {
    return newestFirst([...this.rows.values()], (row) => row.createdAt).slice(0, limit);
  }

  async findBySlug(slug: string): Promise<ApplicationRow | undefined> {
    return [...this.rows.values()].find((row) => row.slug === slug);
  }
}

@Injectable()
export class InMemoryMembershipRepository extends MembershipRepository {
  private readonly rows = new Map<string, MembershipRow>();

  async save(membership: MembershipRow): Promise<MembershipRow> {
    this.rows.set(membership.id, membership);
    return membership;
  }

  async findById(id: string): Promise<MembershipRow | undefined> {
    return this.rows.get(id);
  }

  async list(limit: number): Promise<MembershipRow[]> {
    return newestFirst([...this.rows.values()], (row) => row.createdAt).slice(0, limit);
  }

  async listForUser(userId: string): Promise<MembershipRow[]> {
    return newestFirst(
      [...this.rows.values()].filter((row) => row.userId === userId),
      (row) => row.createdAt,
    );
  }
}

/**
 * Append-only in memory too.
 *
 * The array is private and nothing here replaces or removes an entry, so this
 * implementation cannot do what the Postgres grant forbids. That matters for the
 * contract suite: if the in-memory one could be mutated, a test asserting
 * append-only against it would pass for the wrong reason.
 */
@Injectable()
export class InMemoryAuditRepository extends AuditRepository {
  private readonly rows: AuditEventRow[] = [];

  async append(event: AuditEventRow): Promise<AuditEventRow> {
    this.rows.push(event);
    return event;
  }

  async list(limit: number): Promise<AuditEventRow[]> {
    return newestFirst(this.rows, (row) => row.at).slice(0, limit);
  }

  async listForActor(actorUserId: string, limit: number): Promise<AuditEventRow[]> {
    return newestFirst(
      this.rows.filter((row) => row.actorUserId === actorUserId),
      (row) => row.at,
    ).slice(0, limit);
  }
}
