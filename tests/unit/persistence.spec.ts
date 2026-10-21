import { test, expect } from '@playwright/test';
import {
  maskDatabaseUrl,
  requireDatabaseUrl,
  resolveDatabaseUrl,
} from '../../apps/api/src/config/database';
import { InMemoryRunRepository } from '../../apps/api/src/modules/runs/run.repository';
import {
  InMemoryApplicationRepository,
  InMemoryAuditRepository,
  InMemoryInviteRepository,
  InMemoryMembershipRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
} from '../../apps/api/src/modules/persistence/in-memory';
import type {
  ApplicationRow,
  InviteRow,
  KeyedStore,
  MembershipRow,
  SessionRow,
  UserRow,
} from '../../apps/api/src/modules/persistence/repositories';
import { RunStatus, type Run } from '@aitp/shared';

/**
 * The persistence layer: where the data lives, and the contract every store
 * keeps.
 *
 * `docs/design/B1-auth-and-data.md` §1. **This suite runs against the
 * IN-MEMORY implementations only**, which is what lets `pnpm verify` need no
 * database. The same assertions are what `pnpm test:db` will run against
 * Postgres once the schema is applied — one suite, two implementations, which is
 * the only thing that catches a divergence between them. An in-memory
 * repository written by the same author as the code it serves is a stub that
 * cannot falsify itself.
 *
 * So the two halves compose to the property and neither states it alone (§L):
 * green here means the contract holds in memory, and nothing more.
 */

const ISO = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 21, 12, minute, 0)).toISOString();

/**
 * A repository under contract, described structurally.
 *
 * Structural rather than by a shared base class, because `RunRepository`
 * predates this suite and §1 says its interface stays exactly as it is — so it
 * is included here without being modified to know about it.
 */
interface Subject<T> {
  name: string;
  make: () => KeyedStore<T>;
  /** A row with the given key and creation time, otherwise plausible. */
  row: (key: string, createdAt: string) => T;
  keyOf: (row: T) => string;
}

/**
 * Each subject is TYPED, not cast (§AD).
 *
 * The first draft stored them as `Subject<never>[]` with
 * `as unknown as Subject<never>` on each literal — which compiled, and cost the
 * row builders their contextual typing: every `(id, createdAt) =>` parameter
 * became an implicit `any`, so a row missing a field the store reads would not
 * have been a compile error. That is exactly what §AD warns about — the field a
 * cast lets you forget is the one no test will ever mention.
 *
 * `define<T>` keeps each literal checked against its own row type and erases the
 * parameter only at the boundary, where the suite genuinely does not care which
 * store it is holding.
 */
type ErasedSubject = Subject<unknown>;

const define = <T>(subject: Subject<T>): ErasedSubject => subject as ErasedSubject;

const runRow = (id: string, createdAt: string): Run => ({
  id,
  status: RunStatus.Queued,
  request: { environment: 'local', browsers: ['chromium'], headed: false, metadata: {} },
  createdAt,
  results: [],
  artifacts: {},
});

const SUBJECTS: ErasedSubject[] = [
  define<Run>({
    name: 'RunRepository',
    make: () => new InMemoryRunRepository(),
    row: runRow,
    keyOf: (r: Run) => r.id,
  }),
  define<UserRow>({
    name: 'UserRepository',
    make: () => new InMemoryUserRepository(),
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
    keyOf: (r: { id: string }) => r.id,
  }),
  define<SessionRow>({
    name: 'SessionRepository',
    make: () => new InMemorySessionRepository(),
    row: (tokenHash, createdAt) => ({
      tokenHash,
      userId: 'user-1',
      createdAt,
      lastSeenAt: createdAt,
      idleExpiresAt: ISO(59),
      absoluteExpiresAt: ISO(59),
      createdIp: null,
      createdUserAgent: null,
      revokedAt: null,
      revokedReason: null,
    }),
    keyOf: (r: { tokenHash: string }) => r.tokenHash,
  }),
  define<InviteRow>({
    name: 'InviteRepository',
    make: () => new InMemoryInviteRepository(),
    row: (tokenHash, createdAt) => ({
      tokenHash,
      email: `${tokenHash}@example.test`,
      role: 'QA',
      scope: 'app',
      applicationId: null,
      createdById: 'user-1',
      createdAt,
      expiresAt: ISO(59),
      acceptedAt: null,
      revokedAt: null,
    }),
    keyOf: (r: { tokenHash: string }) => r.tokenHash,
  }),
  define<ApplicationRow>({
    name: 'ApplicationRepository',
    make: () => new InMemoryApplicationRepository(),
    row: (id, createdAt) => ({
      id,
      slug: id,
      name: `App ${id}`,
      createdAt,
      updatedAt: createdAt,
    }),
    keyOf: (r: { id: string }) => r.id,
  }),
  define<MembershipRow>({
    name: 'MembershipRepository',
    make: () => new InMemoryMembershipRepository(),
    row: (id, createdAt) => ({
      id,
      userId: 'user-1',
      applicationId: null,
      role: 'QA',
      scope: 'app',
      createdAt,
    }),
    keyOf: (r: { id: string }) => r.id,
  }),
];

/** §T — the loops below must have had something to loop over. */
const EXPECTED_SUBJECTS = 6;

test.describe('the repository contract, in memory @unit', () => {
  test('C1: every store round-trips a saved row by its key', async () => {
    // wrong: a save that dropped the row, or a findById keyed on the wrong
    // field, returns undefined here — and with six stores sharing one suite a
    // single store getting its key wrong is caught, where six hand-written
    // suites would each have been written against whatever that store does.
    expect(SUBJECTS.length, 'the contract ran over no stores at all').toBe(EXPECTED_SUBJECTS);

    for (const subject of SUBJECTS) {
      const store = subject.make();
      const row = subject.row('k1', ISO(0));
      await store.save(row);
      const found = await store.findById(subject.keyOf(row));
      expect(found, `${subject.name}: a saved row was not found by its key`).toBeDefined();
      expect(subject.keyOf(found!), `${subject.name}: the wrong row came back`).toBe('k1');
    }
  });

  test('C2: an unknown key is undefined, not a throw and not a fabricated row', async () => {
    // wrong: a store that threw would make "does this exist?" unanswerable
    // without a try/catch at every call site, and one that returned a default
    // object would let a caller act on a row nobody wrote. Both have been
    // shipped by somebody; `undefined` is the only answer that is a fact.
    for (const subject of SUBJECTS) {
      const store = subject.make();
      expect(await store.findById('nope'), `${subject.name}: not undefined`).toBeUndefined();
    }
  });

  test('C3: saving the same key twice REPLACES rather than duplicating', async () => {
    // wrong: an append-style save gives two rows for one key, `findById` returns
    // whichever the implementation happens to reach first, and the two
    // implementations can disagree about which — a divergence that shows up as
    // one stale field much later.
    for (const subject of SUBJECTS) {
      const store = subject.make();
      await store.save(subject.row('k1', ISO(0)));
      await store.save(subject.row('k1', ISO(5)));
      const all = await store.list(100);
      expect(
        all.filter((r) => subject.keyOf(r) === 'k1'),
        `${subject.name}: duplicated`,
      ).toHaveLength(1);
    }
  });

  test('C4: list is newest-first', async () => {
    // wrong: insertion order. Which is the SAME as newest-first whenever rows
    // are inserted in chronological order, so the fixture inserts them out of
    // order on purpose — a fixture that saved oldest-then-newest could not tell
    // a sorted list from an unsorted one (§"a discriminating property needs a
    // discriminating fixture").
    for (const subject of SUBJECTS) {
      const store = subject.make();
      await store.save(subject.row('middle', ISO(5)));
      await store.save(subject.row('oldest', ISO(0)));
      await store.save(subject.row('newest', ISO(9)));
      const keys = (await store.list(100)).map(subject.keyOf);
      expect(keys, `${subject.name}: not newest-first`).toEqual(['newest', 'middle', 'oldest']);
    }
  });

  test('C5: list respects its limit, and takes the newest ones', async () => {
    // wrong: a limit applied BEFORE the sort returns the newest two of whatever
    // order the store happened to hold — so asserting only the length would pass
    // over an implementation that silently drops the rows a reader wanted most.
    for (const subject of SUBJECTS) {
      const store = subject.make();
      await store.save(subject.row('a', ISO(0)));
      await store.save(subject.row('b', ISO(5)));
      await store.save(subject.row('c', ISO(9)));
      expect((await store.list(2)).map(subject.keyOf), `${subject.name}: wrong page`).toEqual([
        'c',
        'b',
      ]);
    }
  });

  test('C6: an empty store lists nothing, and that is not an error', async () => {
    // wrong: a throw, or a null. This is the three-states rule at the storage
    // layer — "configured and empty" must be distinguishable from "could not
    // read", and an empty array is how the first one says so.
    for (const subject of SUBJECTS) {
      const store = subject.make();
      expect(await store.list(25), `${subject.name}: empty is not []`).toEqual([]);
    }
  });

  test('C7: a user is found by email case-insensitively, and only one case can exist', async () => {
    // wrong: `Hashim@x.test` and `hashim@x.test` become two accounts, and which
    // one a login reaches depends on what the person typed. Email is
    // case-insensitive in practice, so the store folds on the way IN rather than
    // scanning case-insensitively on the way out — a scan would still let both
    // rows exist.
    const users = new InMemoryUserRepository();
    // Built here and fully TYPED rather than spread off an erased subject row:
    // `UserRow` is what the store reads, so the compiler is required to supply
    // every field of it (§AD).
    const user: UserRow = {
      id: 'u1',
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

    expect(await users.findByEmail('mixed.case@example.test')).toBeDefined();
    expect(await users.findByEmail('MIXED.CASE@EXAMPLE.TEST')).toBeDefined();
    expect(await users.findByEmail('  Mixed.Case@Example.test  ')).toBeDefined();
    // Stored folded, so a second row cannot differ only by case.
    expect((await users.findById('u1'))!.email).toBe('mixed.case@example.test');
    // Discriminating: a different address is still not found.
    expect(await users.findByEmail('someone.else@example.test')).toBeUndefined();
  });

  test('C8: findActive refuses a revoked session and BOTH expiries separately', async () => {
    // wrong: checking only the idle clock makes a session that is used daily
    // live forever, which is the exact property §3's absolute expiry exists to
    // stop — and a test that only aged a session past BOTH clocks at once could
    // not tell which check was doing the work. Each is aged on its own here.
    const sessions = new InMemorySessionRepository();
    const row = {
      tokenHash: 'h',
      userId: 'u1',
      createdAt: ISO(0),
      lastSeenAt: ISO(0),
      idleExpiresAt: ISO(10),
      absoluteExpiresAt: ISO(50),
      createdIp: null,
      createdUserAgent: null,
      revokedAt: null,
      revokedReason: null,
    };

    await sessions.save(row);
    expect(await sessions.findActive('h', ISO(5)), 'a live session was refused').toBeDefined();

    // Past the IDLE clock only.
    expect(await sessions.findActive('h', ISO(20))).toBeUndefined();
    // Past the ABSOLUTE clock only — idle pushed forward, as activity does.
    await sessions.save({ ...row, idleExpiresAt: ISO(59) });
    expect(
      await sessions.findActive('h', ISO(55)),
      'the absolute expiry did not hold once idle was extended',
    ).toBeUndefined();

    // Revoked, while both clocks still have time on them.
    await sessions.save({ ...row, revokedAt: ISO(1), revokedReason: 'logout' });
    expect(await sessions.findActive('h', ISO(5))).toBeUndefined();
    // And the raw row is still retrievable, because administration needs it.
    expect(await sessions.findById('h')).toBeDefined();
  });

  test('C9: the audit store appends and reads, and exposes no way to change a row', async () => {
    // wrong: an interface carrying `save` or `delete` would let a well-meaning
    // bug rewrite history, and the §6 control is a database GRANT — so a mutator
    // here would be offering something the production role cannot do. Asserted
    // on the OBJECT rather than by reading the source, because a method added to
    // the class is what would actually break this.
    const audit = new InMemoryAuditRepository();
    const event = {
      id: 'e1',
      at: ISO(0),
      actorUserId: 'u1',
      actorEmail: 'who@example.test',
      actorRole: 'Owner',
      actorScope: 'all',
      actorTokenId: null,
      action: 'auth.login',
      subjectType: null,
      subjectId: null,
      applicationId: null,
      outcome: 'allowed' as const,
      ip: null,
      userAgent: null,
      requestId: null,
      detail: {},
    };

    await audit.append(event);
    await audit.append({ ...event, id: 'e2', at: ISO(9), outcome: 'denied' as const });

    expect(
      (await audit.list(10)).map((r) => r.id),
      'not newest-first',
    ).toEqual(['e2', 'e1']);
    expect(await audit.listForActor('u1', 10)).toHaveLength(2);
    expect(await audit.listForActor('nobody', 10)).toEqual([]);

    // Denials are recorded as deliberately as successes (§6).
    expect((await audit.list(10)).map((r) => r.outcome)).toContain('denied');

    for (const forbidden of ['save', 'update', 'delete', 'remove', 'clear']) {
      expect(
        (audit as unknown as Record<string, unknown>)[forbidden],
        `AuditRepository exposes ${forbidden}() — append-only is broken`,
      ).toBeUndefined();
    }
  });
});

test.describe('DATABASE_URL has three answers and no default @unit', () => {
  test('D1: not-configured, malformed and configured are three different answers', () => {
    // wrong: collapsing the first two into "no database" tells a reader to go
    // and set a variable that is already set, or to go and fix a value that does
    // not exist. NOT CONFIGURED and FAILED TO LOAD are the distinction this repo
    // has had to rebuild three times.
    expect(resolveDatabaseUrl(undefined).state).toBe('not-configured');
    expect(resolveDatabaseUrl('').state).toBe('not-configured');
    expect(resolveDatabaseUrl('   ').state).toBe('not-configured');

    expect(resolveDatabaseUrl('not a url').state).toBe('malformed');
    expect(resolveDatabaseUrl('mysql://u:p@h:3306/d').state).toBe('malformed');
    expect(resolveDatabaseUrl('postgresql://u:p@h:5432/').state).toBe('malformed');

    const good = resolveDatabaseUrl('postgresql://aitp_app:s3cret@127.0.0.1:5432/aitp');
    expect(good.state).toBe('configured');

    // There is NO default. A fallback here would be a guess about which database
    // this installation writes to.
    expect(() => requireDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => requireDatabaseUrl('mysql://u:p@h/d')).toThrow(/Postgres only/);
    expect(() => requireDatabaseUrl('postgresql://u:p@h:5432/d')).not.toThrow();
  });

  test('D2: no message or description ever carries the password', () => {
    // wrong: the obvious malformed-URL message is `Invalid DATABASE_URL:
    // ${value}` — which prints the password, and prints it into whatever
    // captured the refusal. The password is also the part most likely to contain
    // whatever made the value unparseable, so the failure path is exactly where
    // it would leak.
    const SECRET = 'pa55-w0rd-sentinel';

    const described = resolveDatabaseUrl(`postgresql://aitp_app:${SECRET}@127.0.0.1:5432/aitp`);
    expect(described.state).toBe('configured');
    if (described.state === 'configured') {
      expect(described.describe, 'the masked description leaked the password').not.toContain(
        SECRET,
      );
      // Discriminating: it still says the useful things, or masking would be
      // satisfied by returning a constant.
      expect(described.describe).toContain('aitp_app');
      expect(described.describe).toContain('127.0.0.1:5432');
      expect(described.describe).toContain('aitp');
    }

    // Every refusal path, over a value that holds the sentinel.
    for (const raw of [
      `mysql://u:${SECRET}@h:3306/d`,
      `postgresql://u:${SECRET}@h:5432/`,
      `postgres ${SECRET} not a url`,
    ]) {
      const resolved = resolveDatabaseUrl(raw);
      expect(resolved.state === 'malformed' || resolved.state === 'not-configured').toBe(true);
      if (resolved.state !== 'configured') {
        expect(resolved.why, `a refusal leaked the password: ${resolved.why}`).not.toContain(
          SECRET,
        );
      }
      let thrown = '';
      try {
        requireDatabaseUrl(raw);
      } catch (error) {
        thrown = (error as Error).message;
      }
      expect(thrown, 'the thrown refusal leaked the password').not.toContain(SECRET);
    }

    // And the masker's own FAILURE path does not echo its input, which is where
    // a "return the original on error" would have leaked it.
    expect(maskDatabaseUrl(`garbage ${SECRET}`)).not.toContain(SECRET);
  });
});
