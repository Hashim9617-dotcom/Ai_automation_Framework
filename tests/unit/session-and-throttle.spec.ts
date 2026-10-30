import { test, expect } from '@playwright/test';
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  IDLE_WRITE_INTERVAL_MS,
  SESSION_TOKEN_BYTES,
  clocksForNewSession,
  hashSessionToken,
  newSessionToken,
  sessionHashesMatch,
  shouldSlideIdleClock,
  slideIdleClock,
} from '../../apps/api/src/modules/auth/session-token';
import {
  THROTTLE_POLICY,
  decideThrottle,
  type LoginAttemptRecord,
} from '../../apps/api/src/modules/auth/login-throttle';
import { InMemorySessionRepository } from '../../apps/api/src/modules/persistence/in-memory';

/**
 * Sessions and login throttling, as decisions rather than as endpoints.
 *
 * `docs/design/B1-auth-and-data.md` §3. Everything here is pure or runs against
 * the in-memory session store, so `pnpm verify` needs no database. The HTTP
 * half — cookie flags, the CSRF origin check, the identical responses — is in
 * the `@db` api suite, because it needs real users.
 *
 * **No test prints a token.** A token is a live credential for as long as its
 * session lasts, and a test that logged one would put it wherever the run output
 * went.
 */

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 30, 12, minute, 0)).toISOString();
const when = (minute: number): Date => new Date(at(minute));

test.describe('session tokens @unit', () => {
  test('S1: a token is 32 bytes of entropy and never the same twice', async () => {
    // wrong: a short token, or one derived from the user id or a counter, is
    // guessable — and a session token IS the credential, so guessing one is
    // signing in. 256 bits is the number that makes guessing not a strategy;
    // asserting the DECODED length is what catches an encoding that silently
    // shortened it.
    expect(SESSION_TOKEN_BYTES).toBe(32);

    const tokens = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = newSessionToken();
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      // base64url: no +, no /, no = padding, so it is cookie-safe without
      // escaping — a token that needed escaping would round-trip differently
      // through a header than through a test.
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      tokens.add(token);
    }
    // 200 draws from 2^256 colliding would mean the generator is not random.
    expect(tokens.size, 'two tokens collided — the source is not random').toBe(200);
  });

  test('S2: only the HASH is storable, and the token cannot be recovered from it', async () => {
    // wrong: storing the token means a database leak hands over live sessions —
    // every row is a usable cookie. This is the property that makes a leak
    // survivable, and the assertion is that the digest does NOT contain the
    // token rather than that some function was called.
    const token = newSessionToken();
    const digest = hashSessionToken(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest, 'the digest contains the token').not.toContain(token);
    // Deterministic, or a lookup by digest could never find its own row.
    expect(hashSessionToken(token)).toBe(digest);
    // And a different token gives a different digest, or every session would
    // collide onto one row.
    expect(hashSessionToken(newSessionToken())).not.toBe(digest);
  });

  test('S3: hashes are compared in constant time, and a length mismatch is false not a throw', async () => {
    // wrong: `timingSafeEqual` THROWS when the buffers differ in length, and a
    // caller-supplied cookie differing in length is perfectly ordinary — a
    // truncated value, a probe, a value from another system. Without the length
    // check that is a 500 on a malformed cookie. With `===` instead, the compare
    // short-circuits at the first differing character and leaks where two
    // same-length digests diverge.
    const token = newSessionToken();
    const digest = hashSessionToken(token);

    expect(sessionHashesMatch(digest, digest)).toBe(true);
    expect(sessionHashesMatch(digest, hashSessionToken(newSessionToken()))).toBe(false);

    for (const malformed of ['', 'short', `${digest}extra`, digest.slice(0, 63)]) {
      let threw = false;
      let result: boolean | undefined;
      try {
        result = sessionHashesMatch(digest, malformed);
      } catch {
        threw = true;
      }
      expect(threw, `a length mismatch threw for ${JSON.stringify(malformed.slice(0, 12))}`).toBe(
        false,
      );
      expect(result).toBe(false);
    }
  });

  test('S4: idle and absolute are two clocks, and only one of them slides', async () => {
    // wrong: one clock. With only an idle timeout, a session used daily lives
    // forever — which makes a stolen cookie permanent, and is the single
    // property §3's absolute expiry exists for. With only an absolute timeout,
    // an abandoned browser stays signed in for a week.
    const issued = when(0);
    const clocks = clocksForNewSession(issued);

    expect(new Date(clocks.idleExpiresAt).getTime() - issued.getTime()).toBe(IDLE_TTL_MS);
    expect(new Date(clocks.absoluteExpiresAt).getTime() - issued.getTime()).toBe(ABSOLUTE_TTL_MS);
    // They are DIFFERENT, or there is only one clock wearing two names.
    expect(clocks.idleExpiresAt).not.toBe(clocks.absoluteExpiresAt);
    expect(IDLE_TTL_MS).toBeLessThan(ABSOLUTE_TTL_MS);

    // Sliding moves the idle clock forward...
    const later = new Date(issued.getTime() + 60 * 60 * 1000);
    const slid = slideIdleClock(later, clocks.absoluteExpiresAt);
    expect(new Date(slid).getTime()).toBeGreaterThan(new Date(clocks.idleExpiresAt).getTime());

    // ...and NEVER past the absolute one. Without the clamp the stored row would
    // claim an expiry beyond the session's hard end — `findActive` checks both
    // so the session would not actually survive, but the row would be lying, and
    // the next reader of `idleExpiresAt` alone would believe it.
    const nearTheEnd = new Date(new Date(clocks.absoluteExpiresAt).getTime() - 60 * 1000);
    expect(slideIdleClock(nearTheEnd, clocks.absoluteExpiresAt)).toBe(clocks.absoluteExpiresAt);
  });

  test('S5: the idle clock is written at most once a minute', async () => {
    // wrong: a row write on every authenticated request. A single open dashboard
    // polling the run list would write a session row per poll, which is the kind
    // of load that gets blamed on the database rather than on the session layer.
    expect(IDLE_WRITE_INTERVAL_MS).toBe(60_000);

    expect(shouldSlideIdleClock(when(0), at(0)), 'wrote with no time elapsed').toBe(false);
    expect(shouldSlideIdleClock(when(0), at(0))).toBe(false);
    // Discriminating: it must eventually say yes, or the idle clock never moves
    // and every session dies at 8 hours regardless of use.
    expect(shouldSlideIdleClock(when(1), at(0))).toBe(true);
    expect(shouldSlideIdleClock(when(5), at(0))).toBe(true);
  });

  test('S6: a new login gets a NEW token, and revoke-all takes only that user', async () => {
    // wrong: two things, and the test needs both halves.
    //
    // Reusing or upgrading an existing session on login is session fixation —
    // an attacker who can set a cookie before sign-in holds a session that
    // becomes authenticated. And a revoke-all that matched too widely signs
    // everyone out on one password change, while one that matched too narrowly
    // leaves the stolen session alive, which is the thing a password change is
    // for.
    const sessions = new InMemorySessionRepository();
    const mine = [newSessionToken(), newSessionToken()];
    const theirs = newSessionToken();

    const row = (token: string, userId: string) => ({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: at(0),
      lastSeenAt: at(0),
      ...clocksForNewSession(when(0)),
      createdIp: null,
      createdUserAgent: null,
      revokedAt: null,
      revokedReason: null,
    });

    for (const token of mine) await sessions.save(row(token, 'user-1'));
    await sessions.save(row(theirs, 'user-2'));

    // Two logins, two distinct tokens — no fixation.
    expect(hashSessionToken(mine[0]!)).not.toBe(hashSessionToken(mine[1]!));

    const revoked = await sessions.revokeAllForUser('user-1', at(5), 'password-change');
    expect(revoked, 'revoke-all did not take both of the user sessions').toBe(2);

    for (const token of mine) {
      expect(await sessions.findActive(hashSessionToken(token), at(6))).toBeUndefined();
    }
    // The OTHER user is untouched, which is the half that says the match is not
    // simply "everything".
    expect(await sessions.findActive(hashSessionToken(theirs), at(6))).toBeDefined();

    // And revoking again reports 0 rather than re-revoking, so a caller auditing
    // the count is told the truth.
    expect(await sessions.revokeAllForUser('user-1', at(7), 'password-change')).toBe(0);
  });
});

test.describe('login throttling @unit', () => {
  const failure = (minute: number, email: string, ip: string | null): LoginAttemptRecord => ({
    at: at(minute),
    email,
    ip,
    succeeded: false,
  });

  test('T1: five failures lock the username, and four do not', async () => {
    // wrong: an off-by-one either locks a user out on their fourth typo or lets
    // a guessing run have an extra attempt per window forever. Both boundaries
    // are asserted, because asserting only the lock would pass over a limit of
    // one.
    expect(THROTTLE_POLICY.usernameFailures).toBe(5);

    const four = [1, 2, 3, 4].map((m) => failure(m, 'someone@example.test', '10.0.0.1'));
    expect(
      decideThrottle({
        now: when(5),
        email: 'someone@example.test',
        ip: '10.0.0.1',
        attempts: four,
      }).allowed,
    ).toBe(true);

    const five = [...four, failure(5, 'someone@example.test', '10.0.0.1')];
    const locked = decideThrottle({
      now: when(6),
      email: 'someone@example.test',
      ip: '10.0.0.1',
      attempts: five,
    });
    expect(locked.allowed).toBe(false);
    if (!locked.allowed) {
      expect(locked.reason).toBe('username-locked');
      expect(locked.retryAfterMs).toBeGreaterThan(0);
    }

    // Case-insensitively, because the user repository folds the address — a
    // lockout that could be stepped around by changing the capitalisation would
    // not be a lockout.
    expect(
      decideThrottle({
        now: when(6),
        email: 'SOMEONE@EXAMPLE.TEST',
        ip: '10.0.0.1',
        attempts: five,
      }).allowed,
    ).toBe(false);
  });

  test('T2: a success clears the slate, and the window eventually does too', async () => {
    // wrong: counting only the window leaves a user who signed in correctly on
    // their fifth try still one failure from a lockout for the next fifteen
    // minutes — their own successful login did nothing. And without the window,
    // five typos ever would lock an account permanently.
    const email = 'someone@example.test';
    const four = [1, 2, 3, 4].map((m) => failure(m, email, '10.0.0.1'));

    const withSuccess: LoginAttemptRecord[] = [
      ...four,
      { at: at(5), email, ip: '10.0.0.1', succeeded: true },
      failure(6, email, '10.0.0.1'),
    ];
    // Five failures are present, but four of them precede the success.
    expect(withSuccess.filter((a) => !a.succeeded)).toHaveLength(5);
    expect(
      decideThrottle({ now: when(7), email, ip: '10.0.0.1', attempts: withSuccess }).allowed,
      'a successful login did not clear the counter',
    ).toBe(true);

    // The window: five failures, all older than it.
    const stale = [1, 2, 3, 4, 5].map((m) => failure(m, email, '10.0.0.1'));
    const afterWindow = new Date(when(5).getTime() + THROTTLE_POLICY.windowMs + 1000);
    expect(
      decideThrottle({ now: afterWindow, email, ip: '10.0.0.1', attempts: stale }).allowed,
      'the window never expires',
    ).toBe(true);
  });

  test('T3: the IP limit is separate, and a null IP is not a shared bucket', async () => {
    // wrong: one limit only, or one shared bucket.
    //
    // Per-username alone lets a spray across many accounts from one host run
    // unthrottled; per-IP alone lets a distributed run at one account through.
    // And collapsing every null IP into one bucket would let any unidentified
    // caller lock out all the others.
    expect(THROTTLE_POLICY.ipFailures).toBe(20);

    // Nineteen failures spread over distinct accounts: no username is near its
    // limit, and the IP is not yet either.
    //
    // ALL INSIDE THE WINDOW, and that took a correction. The first fixture put
    // them one per minute across twenty minutes and evaluated at minute 21 — so
    // the window had already dropped the first five and only fifteen counted.
    // The test failed and the code was right: a fixture that straddles the
    // window is measuring the window, not the limit.
    const spread = Array.from({ length: 19 }, (_, i) =>
      failure(1 + (i % 5), `user${i}@example.test`, '10.0.0.9'),
    );
    expect(
      decideThrottle({
        now: when(6),
        email: 'fresh@example.test',
        ip: '10.0.0.9',
        attempts: spread,
      }).allowed,
    ).toBe(true);

    const twenty = [...spread, failure(5, 'user19@example.test', '10.0.0.9')];
    const throttled = decideThrottle({
      now: when(6),
      email: 'fresh@example.test',
      ip: '10.0.0.9',
      attempts: twenty,
    });
    expect(throttled.allowed).toBe(false);
    if (!throttled.allowed) expect(throttled.reason).toBe('ip-throttled');

    // wrong (second half): a null ip collapsing into one bucket would let any
    // unidentified caller lock out every other unidentified caller — a denial of
    // service wearing a rate limit's clothes. Twenty null-ip failures must not
    // throttle a null-ip caller.
    // 25 of them, ALL inside the window and all above the IP limit — so if null
    // ips were bucketed together this would throttle. Evaluated at minute 6 for
    // the same reason the fixture above was corrected: at minute 30 the window
    // would have dropped most of them and the assertion would have passed
    // because it counted eleven, not because null is unbucketed. Green for the
    // wrong reason is the failure this spacing exists to avoid (§X).
    const nulls = Array.from({ length: 25 }, (_, i) =>
      failure(1 + (i % 5), `other${i}@example.test`, null),
    );
    expect(nulls.length).toBeGreaterThan(THROTTLE_POLICY.ipFailures);
    expect(
      decideThrottle({ now: when(6), email: 'fresh@example.test', ip: null, attempts: nulls })
        .allowed,
      'null IPs were treated as one shared bucket',
    ).toBe(true);

    // And a DIFFERENT ip is unaffected by this one's failures — same window,
    // so the only thing that changed is the address.
    expect(
      decideThrottle({
        now: when(6),
        email: 'fresh@example.test',
        ip: '10.0.0.8',
        attempts: twenty,
      }).allowed,
    ).toBe(true);
  });
});
