import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { RunStatus, findRepoRoot, type Run } from '@aitp/shared';
import {
  maskDatabaseUrl,
  requireDatabaseUrl,
  resolveDatabaseUrl,
} from '../../apps/api/src/config/database';
import { InMemoryRunRepository } from '../../apps/api/src/modules/runs/run.repository';
import {
  APPEND_ONLY_TABLES,
  FORBIDDEN_ON_APPEND_ONLY,
} from '../../apps/api/src/modules/persistence/append-only';
import {
  InMemoryApplicationRepository,
  InMemoryAuditRepository,
  InMemoryInviteRepository,
  InMemoryMembershipRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
} from '../../apps/api/src/modules/persistence/in-memory';
import { conflictingEnvKeys, readEnvFile } from '../../scripts/read-env-file';
import {
  CONTRACT,
  ISO,
  define,
  type ContractRunners,
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
 * The persistence layer, against the IN-MEMORY implementations.
 *
 * `docs/design/B1-auth-and-data.md` §1. The assertions themselves live in
 * `tests/support/repository-contract.ts` and are called from here with the
 * in-memory stores, and from `pnpm test:db` with the Prisma ones. **One suite,
 * two implementations** — the only thing that catches a divergence, because a
 * stub written by the author of the code it serves cannot falsify itself.
 *
 * So green here means the contract holds in memory, and nothing more. The other
 * half is `pnpm test:db`, and neither states the property alone (§L).
 */

const ROOT = findRepoRoot();

/** Every `.ts` under a directory. Used by D3 to enumerate rather than remember. */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const runRow = (id: string, createdAt: string): Run => ({
  id,
  status: RunStatus.Queued,
  request: { environment: 'local', browsers: ['chromium'], headed: false, metadata: {} },
  createdAt,
  results: [],
  artifacts: {},
});

/**
 * Each subject is TYPED where it is defined (§AD).
 *
 * The first draft stored them as `Subject<never>[]` with a cast per literal —
 * which compiled, and cost every row builder its contextual typing, so a row
 * missing a field the store reads would not have been an error. `define<T>`
 * keeps each literal checked and erases the parameter only at the boundary.
 */
const SUBJECTS: ErasedSubject[] = [
  define<Run>({
    name: 'RunRepository',
    make: () => new InMemoryRunRepository(),
    row: runRow,
    keyOf: (row) => row.id,
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
    keyOf: (row) => row.id,
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
    keyOf: (row) => row.tokenHash,
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
    keyOf: (row) => row.tokenHash,
  }),
  define<ApplicationRow>({
    name: 'ApplicationRepository',
    make: () => new InMemoryApplicationRepository(),
    row: (id, createdAt) => ({ id, slug: id, name: `App ${id}`, createdAt, updatedAt: createdAt }),
    keyOf: (row) => row.id,
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
    keyOf: (row) => row.id,
  }),
];

/**
 * No `prepare` anywhere, and that is the in-memory half's whole advantage:
 * every `make()` is a fresh `Map`, so there is nothing to clear and no foreign
 * key to satisfy. The Postgres half supplies real ones — see
 * `tests/api/persistence-postgres.spec.ts`.
 */
const RUNNERS: ContractRunners = {
  subjects: SUBJECTS,
  users: () => Promise.resolve(new InMemoryUserRepository()),
  sessions: () => Promise.resolve(new InMemorySessionRepository()),
  audit: () => Promise.resolve(new InMemoryAuditRepository()),
};

const contract = (id: string): (() => Promise<void>) => {
  const entry = CONTRACT.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no contract assertion called ${id}`);
  return () => entry.run(RUNNERS);
};

/** §T — the shared contract must actually hold all nine, or these delegate to nothing. */
const EXPECTED_CONTRACT_SIZE = 9;

test.describe('the repository contract, in memory @unit', () => {
  test('C1: every store round-trips a saved row by its key', async () => {
    // wrong: a save that dropped the row, or a findById keyed on the wrong
    // field, returns undefined — and with six stores sharing one assertion a
    // single store getting its key wrong is caught, where six hand-written
    // suites would each have been written against whatever that store does.
    //
    // The SHARED LIST is pinned here as well (§T), because extracting these
    // assertions into a module both halves read created a new failure the
    // extraction itself could cause: a contract that lost an entry would make
    // this suite and `pnpm test:db` quietly weaker IN STEP, agreeing because
    // they read the same shortened list, with nothing failing.
    expect(CONTRACT.map((entry) => entry.id)).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'C9',
    ]);
    expect(CONTRACT).toHaveLength(EXPECTED_CONTRACT_SIZE);
    expect(SUBJECTS.length, 'the contract would run over no stores').toBe(6);

    await contract('C1')();
  });

  test('C2: an unknown key is undefined, not a throw and not a fabricated row', async () => {
    // wrong: a store that threw would make "does this exist?" unanswerable
    // without a try/catch at every call site, and one returning a default object
    // would let a caller act on a row nobody wrote.
    await contract('C2')();
  });

  test('C3: saving the same key twice REPLACES rather than duplicating', async () => {
    // wrong: an append-style save gives two rows for one key, and `findById`
    // returns whichever the implementation reaches first — which the two
    // implementations can disagree about, surfacing as one stale field later.
    await contract('C3')();
  });

  test('C4: list is newest-first', async () => {
    // wrong: insertion order, which is the SAME as newest-first whenever rows go
    // in chronologically — so the fixture inserts them out of order and a sorted
    // store can be told from an unsorted one.
    await contract('C4')();
  });

  test('C5: list respects its limit, and takes the newest ones', async () => {
    // wrong: a limit applied BEFORE the sort returns two rows of whatever order
    // the store held, so asserting only the length would pass over an
    // implementation that silently drops the rows a reader wanted most.
    await contract('C5')();
  });

  test('C6: an empty store lists nothing, and that is not an error', async () => {
    // wrong: a throw, or a null. This is the three-states rule at the storage
    // layer — "configured and empty" must be distinguishable from "could not
    // read", and an empty array is how the first says so.
    await contract('C6')();
  });

  test('C7: a user is found by email case-insensitively, and only one case can exist', async () => {
    // wrong: `Hashim@x.test` and `hashim@x.test` become two accounts and which
    // one a login reaches depends on what was typed. Folding on the way IN is
    // what stops both rows existing; a case-insensitive scan on the way out
    // would not.
    await contract('C7')();
  });

  test('C8: findActive refuses a revoked session and BOTH expiries separately', async () => {
    // wrong: checking only the idle clock makes a session used daily live
    // forever, which is what §3's absolute expiry exists to stop — and ageing
    // past both clocks at once could not say which check did the work.
    await contract('C8')();
  });

  test('C9: the audit store appends and reads, and exposes no way to change a row', async () => {
    // wrong: an interface carrying `save` or `delete` would let a well-meaning
    // bug rewrite history — and against Postgres the call would fail at the
    // GRANT, so an interface offering it offers something that cannot work.
    await contract('C9')();
  });
});

test.describe('DATABASE_URL has three answers and no default @unit', () => {
  test('D1: not-configured, malformed and configured are three different answers', () => {
    // wrong: collapsing the first two into "no database" tells a reader to set a
    // variable that is already set, or to fix a value that does not exist. NOT
    // CONFIGURED and FAILED TO LOAD is the distinction this repo has rebuilt
    // three times.
    expect(resolveDatabaseUrl(undefined).state).toBe('not-configured');
    expect(resolveDatabaseUrl('').state).toBe('not-configured');
    expect(resolveDatabaseUrl('   ').state).toBe('not-configured');

    expect(resolveDatabaseUrl('not a url').state).toBe('malformed');
    expect(resolveDatabaseUrl('mysql://u:p@h:3306/d').state).toBe('malformed');
    expect(resolveDatabaseUrl('postgresql://u:p@h:5432/').state).toBe('malformed');

    expect(resolveDatabaseUrl('postgresql://aitp_app:s3cret@127.0.0.1:5432/aitp').state).toBe(
      'configured',
    );

    expect(() => requireDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => requireDatabaseUrl('mysql://u:p@h/d')).toThrow(/Postgres only/);
    expect(() => requireDatabaseUrl('postgresql://u:p@h:5432/d')).not.toThrow();
  });

  test('D2: no message or description ever carries the password', () => {
    // wrong: the obvious malformed-URL message is `Invalid DATABASE_URL:
    // ${value}` — which prints the password into whatever captured the refusal.
    // The password is also the part most likely to contain whatever made the
    // value unparseable, so the failure path is exactly where it would leak.
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

test.describe('the owner credential stays out of the runtime @unit', () => {
  test('D3: no code under apps/api reads AITP_DB_OWNER_URL', () => {
    // wrong: the API process holding the owner URL means the runtime can change
    // its own schema — which makes every grant in the grants migration removable
    // by the thing they restrict, including the REVOKE that is §6's only real
    // control. One `process.env.AITP_DB_OWNER_URL` anywhere under apps/api would
    // do it, and nothing else in the suite would notice.
    const files = walkTs(path.join(ROOT, 'apps', 'api', 'src'));

    // §T — the walk had a subject. Measured 2026-10-22: 17 source files.
    expect(files.length, 'the walk read no apps/api source at all').toBeGreaterThan(8);

    const offenders = files.filter((file) => /AITP_DB_OWNER_URL/.test(readFileSync(file, 'utf8')));
    expect(
      offenders.map((file) => path.relative(ROOT, file).split(path.sep).join('/')),
      'these read the OWNER credential from runtime code. Only scripts/db-deploy.ts\n' +
        'may, and it passes it to one child command rather than holding it:',
    ).toEqual([]);

    // Discriminating, and the half that matters: the scan must be capable of
    // FINDING the string. Over a tree that does not contain it, a detector that
    // works and one whose regex never matches are the same output.
    const planted = '/* AITP_DB_OWNER' + '_URL */';
    expect(/AITP_DB_OWNER_URL/.test(planted), 'the pattern cannot match its own target').toBe(true);

    // And the one place that IS allowed to read it does, or the rule above is
    // satisfied by nobody using the variable at all.
    const deployer = readFileSync(path.join(ROOT, 'scripts', 'db-deploy.ts'), 'utf8');
    expect(deployer, 'db-deploy.ts does not read the owner key — the rule guards nothing').toMatch(
      /AITP_DB_OWNER_URL/,
    );
  });

  test('D4: two assignments of one key in .env are REFUSED, not tie-broken', () => {
    // wrong: this happened. `AITP_DB_OWNER_URL` was in `.env` twice, lines 56
    // and 58, with different passwords — and reading is LAST-WINS (measured for
    // both dotenv and this repo's reader), so the line that silently won was the
    // one that FAILED authentication, with the working credential two lines
    // above it. The symptom reads as one wrong password rather than as two.
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-env-dup-'));
    try {
      const file = path.join(dir, '.env');

      // THE CATCHING HALF: same key, different values.
      writeFileSync(file, 'A=1\nAITP_DB_OWNER_URL=one\nB=2\nAITP_DB_OWNER_URL=two\n', 'utf8');
      const conflicts = conflictingEnvKeys(file);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.key).toBe('AITP_DB_OWNER_URL');
      // The LINE NUMBERS are the actionable part — "delete line 4", not "fix your .env".
      expect(conflicts[0]!.lines).toEqual([2, 4]);
      // And no value is reported, because a refusal about a credential must not
      // print the credential.
      expect(JSON.stringify(conflicts)).not.toContain('one');
      expect(JSON.stringify(conflicts)).not.toContain('two');

      // THE SILENT HALF, and the case the assertion above is written against. A
      // detector flagging every repeated key would refuse a tidy-but-duplicated
      // file; one flagging any multi-key file would refuse every .env there is.
      writeFileSync(file, 'A=1\nAITP_DB_OWNER_URL=same\nAITP_DB_OWNER_URL=same\n', 'utf8');
      expect(conflictingEnvKeys(file), 'an identical duplicate cannot change an outcome').toEqual(
        [],
      );
      writeFileSync(file, 'A=1\nB=2\nC=3\n', 'utf8');
      expect(conflictingEnvKeys(file)).toEqual([]);

      // Last-wins is the behaviour the refusal exists because of, so it is
      // pinned rather than assumed — if the reader became first-wins, every
      // message about it would be wrong.
      writeFileSync(file, 'K=first\nK=second\n', 'utf8');
      expect(readEnvFile(file).K, 'the reader is no longer last-wins').toBe('second');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D5: every declared append-only table is a real model in the schema', () => {
    // wrong: a typo in APPEND_ONLY_TABLES — `AuditEvents`, `audit_event` — makes
    // the privilege sweep in `pnpm test:db` compare the live grants against a
    // table that does not exist, find it absent from the UPDATE/DELETE list, and
    // report PASS. The grant could have been dropped entirely and the sweep
    // would still be green, because it would be asking about nothing.
    //
    // Derived from the schema file rather than from a second list, so the two
    // cannot drift (§AE).
    const schema = readFileSync(path.join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]!);

    // §T — the parse had a subject. Measured 2026-10-22: 10 models.
    expect(models.length, 'no model was parsed out of schema.prisma').toBeGreaterThan(5);

    expect(APPEND_ONLY_TABLES.length, 'the append-only list is empty').toBeGreaterThan(0);
    for (const table of APPEND_ONLY_TABLES) {
      expect(models, `APPEND_ONLY_TABLES names "${table}", which is not a model`).toContain(table);
    }

    // The privileges it forbids are the three that can rewrite or erase history.
    // INSERT and SELECT are deliberately absent — an append-only table that
    // could not be appended to or read would be useless.
    expect([...FORBIDDEN_ON_APPEND_ONLY].sort()).toEqual(['DELETE', 'TRUNCATE', 'UPDATE']);
    expect(FORBIDDEN_ON_APPEND_ONLY).not.toContain('INSERT');
    expect(FORBIDDEN_ON_APPEND_ONLY).not.toContain('SELECT');
  });
});
