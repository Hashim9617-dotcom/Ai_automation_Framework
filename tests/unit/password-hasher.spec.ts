import { test, expect } from '@playwright/test';
import {
  ARGON2_POLICY,
  Argon2PasswordHasher,
  makeDummyHash,
  parseStoredParameters,
} from '../../apps/api/src/modules/auth/password-hasher';

/**
 * How a dashboard password is stored.
 *
 * `docs/design/B1-auth-and-data.md` §2. No database: hashing is pure, so these
 * run in `pnpm verify` like everything else in the unit suite.
 *
 * **Nothing here prints a hash or a password.** A test that logged a digest
 * would put it in whatever captured the run, and the sentinels below are
 * asserted on by ABSENCE rather than by being echoed.
 */

const hasher = new Argon2PasswordHasher();

test.describe('Argon2id password hashing @unit', () => {
  test('P1: a hash is a PHC string naming argon2id and the policy parameters', async () => {
    // wrong: a bare digest with the parameters kept somewhere else — in config,
    // in a column, in someone's memory. Then a verify has to be TOLD which
    // parameters produced a given hash, and raising the policy silently
    // invalidates every password stored under the old one. The PHC string
    // carries them, which is what makes P3's upgrade possible at all.
    const stored = await hasher.hash('a-reasonably-long-passphrase');

    expect(stored.startsWith('$argon2id$'), 'not an argon2id PHC string').toBe(true);
    const parsed = parseStoredParameters(stored);
    expect(parsed, 'the hash it just produced is unparseable').toBeDefined();
    expect(parsed!.algorithm).toBe('argon2id');
    expect(parsed!.memoryCost).toBe(ARGON2_POLICY.memoryCost);
    expect(parsed!.timeCost).toBe(ARGON2_POLICY.timeCost);
    expect(parsed!.parallelism).toBe(ARGON2_POLICY.parallelism);
    // Argon2 version 19 (0x13) is the one the RFC describes.
    expect(parsed!.version).toBe(19);
  });

  test('P2: the policy is §2 exactly, pinned so a drift is a failure', async () => {
    // wrong: the parameters drift — someone lowers memoryCost to make a test
    // suite faster, or a merge resolves a conflict the convenient way — and
    // nothing says so, because every other test here passes at ANY parameters.
    // This is the only assertion that notices the numbers themselves changing.
    expect(ARGON2_POLICY.memoryCost, 'memoryCost moved away from §2').toBe(19_456);
    expect(ARGON2_POLICY.timeCost, 'timeCost moved away from §2').toBe(2);
    expect(ARGON2_POLICY.parallelism, 'parallelism moved away from §2').toBe(1);
    expect(ARGON2_POLICY.outputLen).toBe(32);
    // And what is produced actually uses them, or the constant is decoration.
    expect(parseStoredParameters(await hasher.hash('x'))!.memoryCost).toBe(19_456);
  });

  test('P3: needsRehash is false at policy and TRUE for anything weaker', async () => {
    // wrong: without this, raising the cost protects only accounts created
    // AFTERWARDS — every existing password stays at the old parameters forever,
    // and nothing anywhere says so. `needsRehash` is on the interface rather
    // than left to callers for exactly that reason.
    const current = await hasher.hash('a-reasonably-long-passphrase');
    expect(hasher.needsRehash(current), 'a hash at policy was marked for rehash').toBe(false);

    // Each dimension on its own, so the comparison cannot be satisfied by
    // checking only one of the three.
    expect(hasher.needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(hasher.needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(hasher.needsRehash('$argon2id$v=19$m=19456,t=2,p=0$c2FsdA$aGFzaA')).toBe(true);
    // A different algorithm is not a weaker parameter, it is a different scheme.
    expect(hasher.needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(hasher.needsRehash('not a phc string at all')).toBe(true);

    // STRONGER is left alone. Re-hashing down because the policy moved down
    // would be the opposite of what this is for.
    expect(
      hasher.needsRehash('$argon2id$v=19$m=131072,t=4,p=1$c2FsdA$aGFzaA'),
      'a stronger hash was marked for rehash',
    ).toBe(false);
  });

  test('P4: verify accepts the right password and rejects a wrong one', async () => {
    // wrong: a verify that returned true for anything would pass every other
    // test in this file — P1 and P2 only look at the string's shape. This is the
    // one that says the function does its job, and the negative half is what
    // makes the positive half mean something.
    const password = 'correct horse battery staple';
    const stored = await hasher.hash(password);

    expect(await hasher.verify(stored, password)).toBe(true);
    expect(await hasher.verify(stored, 'correct horse battery stapl')).toBe(false);
    expect(await hasher.verify(stored, `${password} `)).toBe(false);
    expect(await hasher.verify(stored, password.toUpperCase())).toBe(false);
    expect(await hasher.verify(stored, '')).toBe(false);
  });

  test('P5: a malformed stored value is FALSE, never an exception', async () => {
    // wrong: `argon2Verify` THROWS on a hash it cannot parse, so without the
    // catch a truncated row turns a login into a 500 — and a 500 for one
    // account beside a 401 for another is user enumeration with extra steps
    // (§3). A caller-side try/catch would work until the one call site that
    // forgot.
    for (const broken of [
      '',
      'null',
      '$argon2id$',
      '$argon2id$v=19$m=19456,t=2,p=1$onlysalt',
      '$2b$10$abcdefghijklmnopqrstuv', // a bcrypt hash, from some other system
      '$argon2id$v=19$m=19456,t=2,p=1$!!!notbase64!!!$!!!alsonot!!!',
    ]) {
      let threw = false;
      let result: boolean | undefined;
      try {
        result = await hasher.verify(broken, 'anything');
      } catch {
        threw = true;
      }
      expect(threw, `verify threw on ${JSON.stringify(broken.slice(0, 24))}`).toBe(false);
      expect(result, `verify was not false for ${JSON.stringify(broken.slice(0, 24))}`).toBe(false);
    }
  });

  test('P6: the same password hashes differently every time', async () => {
    // wrong: a fixed or derived salt — from the email, from the user id, from
    // nothing — and two users with the same password get the same stored value.
    // A database leak then shows which accounts share a password, and one
    // cracked hash cracks all of them. Comparing two hashes of ONE password is
    // the only way to see a salt that is not random.
    const password = 'the same password twice';
    const a = await hasher.hash(password);
    const b = await hasher.hash(password);

    expect(a, 'two hashes of one password are identical — the salt is not random').not.toBe(b);
    // Both still verify, so the difference is the salt and not corruption.
    expect(await hasher.verify(a, password)).toBe(true);
    expect(await hasher.verify(b, password)).toBe(true);
    // And neither contains the password itself.
    expect(a).not.toContain(password);
  });

  test('P7: a long passphrase is not silently truncated', async () => {
    // wrong: bcrypt truncates at 72 bytes, so `<72 chars>A` and `<72 chars>B`
    // are the SAME password to it — a correctness bug a passphrase user would
    // never be told about, and one of the two reasons §2 rejected bcrypt. This
    // test is what makes that rejection checkable rather than asserted.
    const base = 'x'.repeat(80);
    const stored = await hasher.hash(`${base}A`);

    expect(await hasher.verify(stored, `${base}A`)).toBe(true);
    expect(
      await hasher.verify(stored, `${base}B`),
      'two passphrases differing only after 72 bytes verified against each other',
    ).toBe(false);

    // Unicode is bytes, not characters, and must round-trip too.
    const emoji = 'passphrase-with-\u{1F512}-and-é';
    expect(await hasher.verify(await hasher.hash(emoji), emoji)).toBe(true);
  });

  test('P8: the dummy hash is verifiable-against but not guessable', async () => {
    // wrong: §3 needs an unknown-user login to run a REAL verify so its timing
    // matches a real account's. A hard-coded constant would be a published hash
    // of a known input — so `verify(dummy, thatKnownInput)` would be TRUE, and
    // anyone could authenticate as a non-existent user if the login path ever
    // returned on that. Generated from a value nobody holds, and discarded.
    const dummy = await makeDummyHash(hasher);

    expect(dummy.startsWith('$argon2id$'), 'the dummy is not a usable hash').toBe(true);
    // It must be usable as a verify target — that is its whole job.
    expect(await hasher.verify(dummy, 'anything at all')).toBe(false);
    expect(await hasher.verify(dummy, '')).toBe(false);

    // Two calls differ, so it is not a constant somebody could precompute.
    expect(await makeDummyHash(hasher)).not.toBe(dummy);
    // And it costs the same as a real verify, which is the property §3 relies on
    // — asserted as "same parameters" rather than by timing, because a timing
    // assertion in a unit test is a flake generator. The api suite checks the
    // observable timing end to end.
    expect(parseStoredParameters(dummy)!.memoryCost).toBe(ARGON2_POLICY.memoryCost);
    expect(parseStoredParameters(dummy)!.timeCost).toBe(ARGON2_POLICY.timeCost);
  });
});
