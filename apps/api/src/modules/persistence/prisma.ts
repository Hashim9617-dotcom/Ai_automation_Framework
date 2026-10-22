import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Run } from '@aitp/shared';
import { RunRepository } from '../runs/run.repository';
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
 * THE POSTGRES IMPLEMENTATIONS.
 *
 * One per interface in `repositories.ts`, plus `PrismaRunRepository` for the
 * `RunRepository` that predates all of this and is unchanged (§1, ADR-008: the
 * swap touches the binding only).
 *
 * ## They are held to the SAME contract as the in-memory ones
 *
 * `tests/support/repository-contract.ts` holds the assertions once.
 * `tests/unit/persistence.spec.ts` runs them against the in-memory stores with no
 * database; `pnpm test:db` runs the identical functions against these. That
 * pairing is the only thing that catches a divergence — an in-memory repository
 * written by the same author as the code it serves is a stub that cannot falsify
 * itself, and two implementations that are never compared are two guesses.
 *
 * ## Dates cross the boundary as ISO strings
 *
 * Prisma returns `Date`; the row types use `string`, matching the canonical `Run`
 * which has always used them. Converting HERE rather than at the call sites is
 * the point: a caller that had to know which repository it was talking to would
 * make the two implementations observably different, which is exactly what the
 * shared contract exists to prevent.
 */

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value === null ? null : iso(value));
/** ISO string in, `Date` out. Prisma will not accept the string. */
const date = (value: string): Date => new Date(value);
const dateOrNull = (value: string | null): Date | null => (value === null ? null : date(value));

/**
 * The client, owned by Nest so one connection pool serves the process.
 *
 * `DATABASE_URL` is read by Prisma itself from the environment — the API's own
 * refusal for a missing one lives in `config/database.ts` and runs at boot, so by
 * the time this is constructed the value has already been validated and named.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.log.log('Disconnected from the database');
  }
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class PrismaUserRepository extends UserRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private static toRow(row: {
    id: string;
    email: string;
    displayName: string | null;
    passwordHash: string | null;
    authProviderId: string;
    externalId: string | null;
    disabledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): UserRow {
    return {
      ...row,
      disabledAt: isoOrNull(row.disabledAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async save(user: UserRow): Promise<UserRow> {
    // FOLDED, exactly as the in-memory store folds: uniqueness is
    // case-insensitive, and the contract suite asserts it against both.
    const email = user.email.trim().toLowerCase();
    const data = {
      email,
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      authProviderId: user.authProviderId,
      externalId: user.externalId,
      disabledAt: dateOrNull(user.disabledAt),
      createdAt: date(user.createdAt),
      updatedAt: date(user.updatedAt),
    };
    // UPSERT, not create: the contract says saving the same key twice REPLACES.
    const saved = await this.prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, ...data },
      update: data,
    });
    return PrismaUserRepository.toRow(saved);
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? PrismaUserRepository.toRow(row) : undefined;
  }

  async list(limit: number): Promise<UserRow[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(PrismaUserRepository.toRow);
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const row = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    return row ? PrismaUserRepository.toRow(row) : undefined;
  }
}

@Injectable()
export class PrismaSessionRepository extends SessionRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private static toRow(row: {
    tokenHash: string;
    userId: string;
    createdAt: Date;
    lastSeenAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    createdIp: string | null;
    createdUserAgent: string | null;
    revokedAt: Date | null;
    revokedReason: string | null;
  }): SessionRow {
    return {
      ...row,
      createdAt: iso(row.createdAt),
      lastSeenAt: iso(row.lastSeenAt),
      idleExpiresAt: iso(row.idleExpiresAt),
      absoluteExpiresAt: iso(row.absoluteExpiresAt),
      revokedAt: isoOrNull(row.revokedAt),
    };
  }

  async save(session: SessionRow): Promise<SessionRow> {
    const data = {
      userId: session.userId,
      createdAt: date(session.createdAt),
      lastSeenAt: date(session.lastSeenAt),
      idleExpiresAt: date(session.idleExpiresAt),
      absoluteExpiresAt: date(session.absoluteExpiresAt),
      createdIp: session.createdIp,
      createdUserAgent: session.createdUserAgent,
      revokedAt: dateOrNull(session.revokedAt),
      revokedReason: session.revokedReason,
    };
    const saved = await this.prisma.session.upsert({
      where: { tokenHash: session.tokenHash },
      create: { tokenHash: session.tokenHash, ...data },
      update: data,
    });
    return PrismaSessionRepository.toRow(saved);
  }

  async findById(tokenHash: string): Promise<SessionRow | undefined> {
    const row = await this.prisma.session.findUnique({ where: { tokenHash } });
    return row ? PrismaSessionRepository.toRow(row) : undefined;
  }

  async list(limit: number): Promise<SessionRow[]> {
    const rows = await this.prisma.session.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(PrismaSessionRepository.toRow);
  }

  async findActive(tokenHash: string, now: string): Promise<SessionRow | undefined> {
    // THE THREE CONDITIONS, in the query rather than in JavaScript — and the
    // absolute clock is checked separately from the idle one, because a session
    // used daily would live forever on the idle clock alone (§3).
    const at = date(now);
    const row = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        idleExpiresAt: { gt: at },
        absoluteExpiresAt: { gt: at },
      },
    });
    return row ? PrismaSessionRepository.toRow(row) : undefined;
  }

  async revokeAllForUser(userId: string, now: string, reason: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: date(now), revokedReason: reason },
    });
    return result.count;
  }
}

@Injectable()
export class PrismaInviteRepository extends InviteRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private static toRow(row: {
    tokenHash: string;
    email: string;
    role: string;
    scope: string;
    applicationId: string | null;
    createdById: string;
    createdAt: Date;
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
  }): InviteRow {
    return {
      ...row,
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      acceptedAt: isoOrNull(row.acceptedAt),
      revokedAt: isoOrNull(row.revokedAt),
    };
  }

  async save(invite: InviteRow): Promise<InviteRow> {
    const email = invite.email.trim().toLowerCase();
    const data = {
      email,
      role: invite.role,
      scope: invite.scope,
      applicationId: invite.applicationId,
      createdById: invite.createdById,
      createdAt: date(invite.createdAt),
      expiresAt: date(invite.expiresAt),
      acceptedAt: dateOrNull(invite.acceptedAt),
      revokedAt: dateOrNull(invite.revokedAt),
    };
    const saved = await this.prisma.invite.upsert({
      where: { tokenHash: invite.tokenHash },
      create: { tokenHash: invite.tokenHash, ...data },
      update: data,
    });
    return PrismaInviteRepository.toRow(saved);
  }

  async findById(tokenHash: string): Promise<InviteRow | undefined> {
    const row = await this.prisma.invite.findUnique({ where: { tokenHash } });
    return row ? PrismaInviteRepository.toRow(row) : undefined;
  }

  async list(limit: number): Promise<InviteRow[]> {
    const rows = await this.prisma.invite.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(PrismaInviteRepository.toRow);
  }

  async listForEmail(email: string, limit: number): Promise<InviteRow[]> {
    const rows = await this.prisma.invite.findMany({
      where: { email: email.trim().toLowerCase() },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(PrismaInviteRepository.toRow);
  }
}

@Injectable()
export class PrismaApplicationRepository extends ApplicationRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private static toRow(row: {
    id: string;
    slug: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }): ApplicationRow {
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  }

  async save(application: ApplicationRow): Promise<ApplicationRow> {
    const data = {
      slug: application.slug,
      name: application.name,
      createdAt: date(application.createdAt),
      updatedAt: date(application.updatedAt),
    };
    const saved = await this.prisma.application.upsert({
      where: { id: application.id },
      create: { id: application.id, ...data },
      update: data,
    });
    return PrismaApplicationRepository.toRow(saved);
  }

  async findById(id: string): Promise<ApplicationRow | undefined> {
    const row = await this.prisma.application.findUnique({ where: { id } });
    return row ? PrismaApplicationRepository.toRow(row) : undefined;
  }

  async list(limit: number): Promise<ApplicationRow[]> {
    const rows = await this.prisma.application.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(PrismaApplicationRepository.toRow);
  }

  async findBySlug(slug: string): Promise<ApplicationRow | undefined> {
    const row = await this.prisma.application.findUnique({ where: { slug } });
    return row ? PrismaApplicationRepository.toRow(row) : undefined;
  }
}

@Injectable()
export class PrismaMembershipRepository extends MembershipRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private static toRow(row: {
    id: string;
    userId: string;
    applicationId: string | null;
    role: string;
    scope: string;
    createdAt: Date;
  }): MembershipRow {
    return { ...row, createdAt: iso(row.createdAt) };
  }

  async save(membership: MembershipRow): Promise<MembershipRow> {
    const data = {
      userId: membership.userId,
      applicationId: membership.applicationId,
      role: membership.role,
      scope: membership.scope,
      createdAt: date(membership.createdAt),
    };
    const saved = await this.prisma.membership.upsert({
      where: { id: membership.id },
      create: { id: membership.id, ...data },
      update: data,
    });
    return PrismaMembershipRepository.toRow(saved);
  }

  async findById(id: string): Promise<MembershipRow | undefined> {
    const row = await this.prisma.membership.findUnique({ where: { id } });
    return row ? PrismaMembershipRepository.toRow(row) : undefined;
  }

  async list(limit: number): Promise<MembershipRow[]> {
    const rows = await this.prisma.membership.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(PrismaMembershipRepository.toRow);
  }

  async listForUser(userId: string): Promise<MembershipRow[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(PrismaMembershipRepository.toRow);
  }
}

/**
 * Append-only, and here that is not a choice this class makes.
 *
 * There is no `save`, `update` or `delete` because the interface has none, and
 * the interface has none because the GRANT has none: `UPDATE`, `DELETE` and
 * `TRUNCATE` on `"AuditEvent"` are revoked from the application role, so a method
 * added here would fail at the database. That ordering is the point — the
 * permission is the control and this is the convenience.
 */
@Injectable()
export class PrismaAuditRepository extends AuditRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private static toRow(row: {
    id: string;
    at: Date;
    actorUserId: string | null;
    actorEmail: string | null;
    actorRole: string | null;
    actorScope: string | null;
    actorTokenId: string | null;
    action: string;
    subjectType: string | null;
    subjectId: string | null;
    applicationId: string | null;
    outcome: string;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
    detail: unknown;
  }): AuditEventRow {
    return {
      ...row,
      at: iso(row.at),
      outcome: row.outcome as AuditEventRow['outcome'],
      detail: (row.detail ?? {}) as Record<string, unknown>,
    };
  }

  async append(event: AuditEventRow): Promise<AuditEventRow> {
    const created = await this.prisma.auditEvent.create({
      data: {
        id: event.id,
        at: date(event.at),
        actorUserId: event.actorUserId,
        actorEmail: event.actorEmail,
        actorRole: event.actorRole,
        actorScope: event.actorScope,
        actorTokenId: event.actorTokenId,
        action: event.action,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        applicationId: event.applicationId,
        outcome: event.outcome,
        ip: event.ip,
        userAgent: event.userAgent,
        requestId: event.requestId,
        detail: event.detail as never,
      },
    });
    return PrismaAuditRepository.toRow(created);
  }

  async list(limit: number): Promise<AuditEventRow[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: { at: 'desc' },
      take: limit,
    });
    return rows.map(PrismaAuditRepository.toRow);
  }

  async listForActor(actorUserId: string, limit: number): Promise<AuditEventRow[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: { actorUserId },
      orderBy: { at: 'desc' },
      take: limit,
    });
    return rows.map(PrismaAuditRepository.toRow);
  }
}

/**
 * The run store, against Postgres.
 *
 * `RunRepository`'s three methods are unchanged (§1). `Run` is a nested document
 * — a request, a summary, results, a target — and the schema flattens the parts
 * that need indexing and keeps the rest as JSON, so this class is where the two
 * shapes meet.
 */
@Injectable()
export class PrismaRunRepository extends RunRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async save(run: Run): Promise<Run> {
    const data = {
      status: run.status,
      command: run.request.command ?? null,
      grep: run.request.grep ?? null,
      environment: run.request.environment,
      browsers: run.request.browsers,
      headed: run.request.headed,
      workers: run.request.workers ?? null,
      retries: run.request.retries ?? null,
      metadata: run.request.metadata as never,
      // `null` is MEANINGFUL and is not the same as absent: it records that the
      // producer knew about targets and was given none (SEC-2).
      target: (run.target ?? null) as never,
      createdAt: date(run.createdAt),
      startedAt: run.startedAt ? date(run.startedAt) : null,
      finishedAt: run.finishedAt ? date(run.finishedAt) : null,
      total: run.summary?.total ?? 0,
      passed: run.summary?.passed ?? 0,
      failed: run.summary?.failed ?? 0,
      skipped: run.summary?.skipped ?? 0,
      flaky: run.summary?.flaky ?? 0,
      durationMs: run.summary?.durationMs ?? 0,
      passRate: run.summary?.passRate ?? 0,
      artifacts: run.artifacts as never,
      error: run.error ?? null,
      healingProposals: (run.healingProposals ?? null) as never,
    };

    // ONE TRANSACTION. A run and its results are one document; a crash between
    // them would leave a run whose `summary.total` disagrees with how many rows
    // exist, and nothing downstream could tell that from a run that genuinely
    // had fewer results.
    //
    // Results are replaced wholesale rather than merged: a re-save is a later
    // snapshot of the same run (the reporter writes one, then RCA enriches it),
    // and merging would accumulate stale attempts.
    await this.prisma.$transaction([
      this.prisma.run.upsert({
        where: { id: run.id },
        create: { id: run.id, ...data },
        update: data,
      }),
      this.prisma.testRun.deleteMany({ where: { runId: run.id } }),
      this.prisma.testRun.createMany({
        data: run.results.map((result) => ({
          runId: run.id,
          testId: result.id,
          title: result.title,
          file: result.file,
          project: result.project,
          tags: result.tags,
          outcome: result.outcome,
          durationMs: result.durationMs,
          retry: result.retry,
          errorMsg: result.error?.message ?? null,
          errorStack: result.error?.stack ?? null,
          rca: (result.error?.rca ?? null) as never,
          context: (result.context ?? null) as never,
          steps: result.steps as never,
          attachments: result.attachments as never,
        })),
      }),
    ]);

    return run;
  }

  async findById(id: string): Promise<Run | undefined> {
    const row = await this.prisma.run.findUnique({
      where: { id },
      include: { results: { orderBy: { title: 'asc' } } },
    });
    return row ? PrismaRunRepository.toRun(row) : undefined;
  }

  async list(limit: number): Promise<Run[]> {
    const rows = await this.prisma.run.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { results: { orderBy: { title: 'asc' } } },
    });
    return rows.map((row) => PrismaRunRepository.toRun(row));
  }

  /** The flattened columns back into one `Run`. */
  private static toRun(row: Record<string, unknown> & { results: Record<string, unknown>[] }): Run {
    const asIso = (value: unknown): string | undefined =>
      value instanceof Date ? value.toISOString() : undefined;

    return {
      id: row.id as string,
      status: row.status as Run['status'],
      request: {
        ...(row.command === null ? {} : { command: row.command as string }),
        ...(row.grep === null ? {} : { grep: row.grep as string }),
        environment: row.environment as string,
        browsers: row.browsers as Run['request']['browsers'],
        headed: row.headed as boolean,
        ...(row.workers === null ? {} : { workers: row.workers as number }),
        ...(row.retries === null ? {} : { retries: row.retries as number }),
        metadata: (row.metadata ?? {}) as Record<string, string>,
      },
      createdAt: asIso(row.createdAt) ?? new Date(0).toISOString(),
      ...(asIso(row.startedAt) ? { startedAt: asIso(row.startedAt) } : {}),
      ...(asIso(row.finishedAt) ? { finishedAt: asIso(row.finishedAt) } : {}),
      summary: {
        total: row.total as number,
        passed: row.passed as number,
        failed: row.failed as number,
        skipped: row.skipped as number,
        flaky: row.flaky as number,
        durationMs: row.durationMs as number,
        passRate: row.passRate as number,
      },
      // `null` survives as `null`, never becoming `undefined`: the two say
      // different things and only one of them is auditable (SEC-2).
      target: (row.target ?? null) as Run['target'],
      artifacts: (row.artifacts ?? {}) as Record<string, string>,
      ...(row.error === null ? {} : { error: row.error as string }),
      ...(row.healingProposals === null
        ? {}
        : { healingProposals: row.healingProposals as Run['healingProposals'] }),
      results: row.results.map((result) => ({
        id: (result.testId ?? result.id) as string,
        title: result.title as string,
        file: result.file as string,
        project: result.project as string,
        tags: result.tags as string[],
        outcome: result.outcome as never,
        durationMs: result.durationMs as number,
        retry: result.retry as number,
        ...(result.errorMsg === null
          ? {}
          : {
              error: {
                message: result.errorMsg as string,
                ...(result.errorStack === null ? {} : { stack: result.errorStack as string }),
                ...(result.rca === null ? {} : { rca: result.rca as never }),
              },
            }),
        ...(result.context === null ? {} : { context: result.context as never }),
        steps: (result.steps ?? []) as never,
        attachments: (result.attachments ?? []) as never,
      })),
    };
  }
}
