import assert from 'node:assert/strict';
import type {
  AuditEventRow,
  KeyedStore,
  SessionRow,
  UserRow,
} from '../../apps/api/src/modules/persistence/repositories';
import type {
  AuditRepository,
  SessionRepository,
  UserRepository,
} from '../../apps/api/src/modules/persistence/repositories';

/**
 * THE REPOSITORY CONTRACT, WRITTEN ONCE.
 *
 * `docs/design/B1-auth-and-data.md` §1: one suite, two implementations. These
 * functions are called by `tests/unit/persistence.spec.ts` against the in-memory
 * stores — no database, so `pnpm verify` needs none — and by `pnpm test:db`
 * against the Prisma ones.
 *
 * **That pairing is the only thing that catches a divergence.** An in-memory
 * repository written by the same author as the code it serves is a stub that
 * cannot falsify itself; two implementations that are never compared are two
 * guesses. Neither half states the property alone (§L), and that is said here
 * rather than left for a reader to notice.
 *
 * ## Why `node:assert` and not `expect`
 *
 * `expect` belongs to the Playwright runner, and `pnpm test:db` is a script with
 * no runner. A shared assertion that only worked under one of its two callers
 * would defeat the point. `assert/strict` throws, which both callers handle: a
 * thrown error fails a Playwright test, and the script catches and reports it.
 *
 * Every assertion carries a message naming the store, because a failure over
 * seven stores is useless without knowing which one.
 */

/** A store under contract, described structurally so `RunRepository` qualifies unchanged. */
export interface ContractSubject<T> {
  name: string;
  make: () => KeyedStore<T>;
  /** A row with the given key and creation time, otherwise plausible. */
  row: (key: string, createdAt: string) => T;
  keyOf: (row: T) => string;
  /**
   * Put this store into a known-empty state, if it needs putting there.
   *
   * In-memory stores do not: every `make()` is a fresh `Map`. A shared database
   * does, and that asymmetry is REAL rather than an inconvenience — which is the
   * whole reason one contract runs against both.
   *
   * It also has to be PER SUBJECT and not per assertion, and that was measured.
   * `Session`, `Invite` and `Membership` carry real foreign keys to `User`, so
   * the Postgres half has to seed a parent user — and that user is itself a
   * `User` row, so it appeared in `UserRepository.list()` and C4 came back
   * `['u1', 'newest', 'middle', 'oldest']`. Seeding once for all subjects cannot
   * work: the row one subject needs is a row another subject must not see.
   */
  prepare?: () => Promise<void>;
}

/**
 * The parameter erased at the boundary, where the contract genuinely does not
 * care which store it holds. Each subject is still TYPED where it is DEFINED
 * (§AD) — `define` is how, and the casts that preceded it cost every row builder
 * its contextual typing.
 */
export type ErasedSubject = ContractSubject<unknown>;

export const define = <T>(subject: ContractSubject<T>): ErasedSubject => subject as ErasedSubject;

/** Fixed timestamps, so ordering assertions do not depend on how fast a test runs. */
export const ISO = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 21, 12, minute, 0)).toISOString();

// ── The six assertions every keyed store must satisfy ───────────────────────

export async function c1RoundTrips(subjects: readonly ErasedSubject[]): Promise<void> {
  assert.ok(subjects.length > 0, 'the contract ran over no stores at all');
  for (const subject of subjects) {
    await subject.prepare?.();
    const store = subject.make();
    const row = subject.row('k1', ISO(0));
    await store.save(row);
    const found = await store.findById(subject.keyOf(row));
    assert.ok(found !== undefined, `${subject.name}: a saved row was not found by its key`);
    assert.equal(subject.keyOf(found), 'k1', `${subject.name}: the wrong row came back`);
  }
}

export async function c2UnknownKeyIsUndefined(subjects: readonly ErasedSubject[]): Promise<void> {
  for (const subject of subjects) {
    await subject.prepare?.();
    const store = subject.make();
    assert.equal(
      await store.findById('no-such-key'),
      undefined,
      `${subject.name}: an unknown key was not undefined`,
    );
  }
}

export async function c3SaveReplaces(subjects: readonly ErasedSubject[]): Promise<void> {
  for (const subject of subjects) {
    await subject.prepare?.();
    const store = subject.make();
    await store.save(subject.row('k1', ISO(0)));
    await store.save(subject.row('k1', ISO(5)));
    const same = (await store.list(100)).filter((row) => subject.keyOf(row) === 'k1');
    assert.equal(same.length, 1, `${subject.name}: saving one key twice left ${same.length} rows`);
  }
}

export async function c4ListIsNewestFirst(subjects: readonly ErasedSubject[]): Promise<void> {
  for (const subject of subjects) {
    await subject.prepare?.();
    const store = subject.make();
    // Inserted OUT of chronological order on purpose: inserted in order,
    // insertion order and newest-first are the same list and the fixture could
    // not tell a sorted store from an unsorted one.
    await store.save(subject.row('middle', ISO(5)));
    await store.save(subject.row('oldest', ISO(0)));
    await store.save(subject.row('newest', ISO(9)));
    assert.deepEqual(
      (await store.list(100)).map(subject.keyOf),
      ['newest', 'middle', 'oldest'],
      `${subject.name}: list is not newest-first`,
    );
  }
}

export async function c5ListRespectsLimit(subjects: readonly ErasedSubject[]): Promise<void> {
  for (const subject of subjects) {
    await subject.prepare?.();
    const store = subject.make();
    await store.save(subject.row('a', ISO(0)));
    await store.save(subject.row('b', ISO(5)));
    await store.save(subject.row('c', ISO(9)));
    assert.deepEqual(
      (await store.list(2)).map(subject.keyOf),
      ['c', 'b'],
      `${subject.name}: the limit did not take the NEWEST rows`,
    );
  }
}

export async function c6EmptyListsNothing(subjects: readonly ErasedSubject[]): Promise<void> {
  for (const subject of subjects) {
    await subject.prepare?.();
    const store = subject.make();
    assert.deepEqual(await store.list(25), [], `${subject.name}: an empty store did not list []`);
  }
}

// ── Three assertions about one store each ───────────────────────────────────

export async function c7EmailIsCaseInsensitive(users: UserRepository): Promise<void> {
  const user: UserRow = {
    id: CONTRACT_USER_ID,
    email: 'Mixed.Case@Example.TEST',
    displayName: null,
    passwordHash: null,
    authProviderId: 'local',
    externalId: null,
    disabledAt: null,
    createdAt: ISO(0),
    updatedAt: ISO(0),
  };
  await users.save(user);

  for (const spelling of [
    'mixed.case@example.test',
    'MIXED.CASE@EXAMPLE.TEST',
    '  Mixed.Case@Example.test  ',
  ]) {
    assert.ok(
      (await users.findByEmail(spelling)) !== undefined,
      `findByEmail did not match "${spelling}"`,
    );
  }
  // Stored FOLDED, so a second row cannot differ only by case.
  const stored = await users.findById(CONTRACT_USER_ID);
  assert.equal(stored?.email, 'mixed.case@example.test', 'the email was not folded on save');
  // Discriminating: a different address is still not found.
  assert.equal(
    await users.findByEmail('someone.else@example.test'),
    undefined,
    'findByEmail matched an address that was never saved',
  );
}

export async function c8SessionActivity(sessions: SessionRepository): Promise<void> {
  const base: SessionRow = {
    tokenHash: 'h',
    userId: CONTRACT_USER_ID,
    createdAt: ISO(0),
    lastSeenAt: ISO(0),
    idleExpiresAt: ISO(10),
    absoluteExpiresAt: ISO(50),
    createdIp: null,
    createdUserAgent: null,
    revokedAt: null,
    revokedReason: null,
  };

  await sessions.save(base);
  assert.ok((await sessions.findActive('h', ISO(5))) !== undefined, 'a live session was refused');

  // Past the IDLE clock only.
  assert.equal(
    await sessions.findActive('h', ISO(20)),
    undefined,
    'an idle-expired session was returned',
  );

  // Past the ABSOLUTE clock only, with idle pushed forward as activity does.
  // Aged SEPARATELY, or the test could not say which check did the work.
  await sessions.save({ ...base, idleExpiresAt: ISO(59) });
  assert.equal(
    await sessions.findActive('h', ISO(55)),
    undefined,
    'the absolute expiry did not hold once idle was extended',
  );

  // Revoked, while both clocks still have time on them.
  await sessions.save({ ...base, revokedAt: ISO(1), revokedReason: 'logout' });
  assert.equal(await sessions.findActive('h', ISO(5)), undefined, 'a revoked session was returned');
  // The raw row is still retrievable, because administration needs it.
  assert.ok((await sessions.findById('h')) !== undefined, 'the revoked row became unreadable');
}

/**
 * The user id every row with a foreign key points at.
 *
 * Exported because the Postgres half has to SEED it: `Session.userId`,
 * `Invite.createdById` and `Membership.userId` are real foreign keys there, and
 * the in-memory stores have none — so a fixture that invented a user id passed
 * in memory and failed on the database with a constraint violation. The two
 * implementations differing in what they ENFORCE is exactly what one shared
 * contract is for.
 */
export const CONTRACT_USER_ID = 'u1';

export async function c9AuditAppendOnly(audit: AuditRepository): Promise<void> {
  // A UNIQUE ACTOR PER INVOCATION, because the audit table cannot be reset
  // between runs — nothing may delete from it, which is the property under test.
  // Asserting on `list()` would therefore accumulate rows from every previous
  // run and fail on the second one; asserting on this actor's own rows is the
  // same ordering property over a set this invocation owns.
  const actor = `audit-actor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const first = `${actor}-e1`;
  const second = `${actor}-e2`;

  const event: AuditEventRow = {
    id: first,
    at: ISO(0),
    actorUserId: actor,
    actorEmail: 'who@example.test',
    actorRole: 'Owner',
    actorScope: 'all',
    actorTokenId: null,
    action: 'auth.login',
    subjectType: null,
    subjectId: null,
    applicationId: null,
    outcome: 'allowed',
    ip: null,
    userAgent: null,
    requestId: null,
    detail: {},
  };

  await audit.append(event);
  await audit.append({ ...event, id: second, at: ISO(9), outcome: 'denied' });

  const mine = await audit.listForActor(actor, 10);
  assert.deepEqual(
    mine.map((row) => row.id),
    [second, first],
    'the audit log is not newest-first',
  );
  assert.equal(mine.length, 2, 'listForActor lost a row');
  assert.deepEqual(
    await audit.listForActor('nobody-at-all', 10),
    [],
    'listForActor invented rows for an unknown actor',
  );
  // Denials are recorded as deliberately as successes (§6).
  assert.ok(
    mine.some((row) => row.outcome === 'denied'),
    'a denial was not recorded',
  );
  // And the rows are readable through the general listing too, which is the
  // method a reader of the audit log actually calls.
  assert.ok(
    (await audit.list(50)).some((row) => row.id === second),
    'list() lost the newest row',
  );

  // No mutator exists to call. Asserted on the OBJECT rather than by reading
  // source, because a method added to the class is what would actually break it.
  for (const forbidden of ['save', 'update', 'delete', 'remove', 'clear']) {
    assert.equal(
      (audit as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `AuditRepository exposes ${forbidden}() — append-only is broken`,
    );
  }
}

/**
 * The nine, in order, so `test:db` can run them all and name each one.
 *
 * The three single-store assertions take their store rather than the subject
 * list, so the caller supplies whichever implementation it is testing.
 */
/**
 * The three single-store factories are ASYNC, so the Postgres half can clear the
 * table — and seed a foreign-key parent where one is needed — before handing the
 * store over. In memory they resolve immediately; the asymmetry is the database's
 * and belongs on its side of the seam.
 */
export interface ContractRunners {
  subjects: readonly ErasedSubject[];
  users: () => Promise<UserRepository>;
  sessions: () => Promise<SessionRepository>;
  audit: () => Promise<AuditRepository>;
}

export const CONTRACT: ReadonlyArray<{
  id: string;
  title: string;
  run: (runners: ContractRunners) => Promise<void>;
}> = [
  {
    id: 'C1',
    title: 'every store round-trips a saved row by its key',
    run: (r) => c1RoundTrips(r.subjects),
  },
  {
    id: 'C2',
    title: 'an unknown key is undefined, not a throw',
    run: (r) => c2UnknownKeyIsUndefined(r.subjects),
  },
  {
    id: 'C3',
    title: 'saving the same key twice replaces rather than duplicating',
    run: (r) => c3SaveReplaces(r.subjects),
  },
  { id: 'C4', title: 'list is newest-first', run: (r) => c4ListIsNewestFirst(r.subjects) },
  {
    id: 'C5',
    title: 'list respects its limit and takes the newest',
    run: (r) => c5ListRespectsLimit(r.subjects),
  },
  { id: 'C6', title: 'an empty store lists nothing', run: (r) => c6EmptyListsNothing(r.subjects) },
  {
    id: 'C7',
    title: 'a user is found by email case-insensitively',
    run: async (r) => c7EmailIsCaseInsensitive(await r.users()),
  },
  {
    id: 'C8',
    title: 'findActive refuses a revoked session and both expiries',
    run: async (r) => c8SessionActivity(await r.sessions()),
  },
  {
    id: 'C9',
    title: 'the audit store appends, reads, and exposes no mutator',
    run: async (r) => c9AuditAppendOnly(await r.audit()),
  },
];
