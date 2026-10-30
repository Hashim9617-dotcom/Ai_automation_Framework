import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * THE SESSION TOKEN, AND WHY ONLY ITS HASH IS EVER STORED.
 *
 * `docs/design/B1-auth-and-data.md` §3. Pure: no clock, no database, no request
 * — everything here takes what it needs as an argument, so these decisions can
 * be tested without a server (§AJ).
 *
 * ## Opaque, not a claim
 *
 * 32 bytes from `randomBytes`, base64url. It carries nothing: no user id, no
 * expiry, no signature. So there is nothing in it to parse, forge, confuse or
 * get wrong, and the session row is the only authority on what it means. That is
 * the whole argument against a JWT here — a self-describing token moves the
 * authority into the token, where revoking it becomes a second mechanism.
 *
 * ## The hash is what makes a database leak survivable
 *
 * Only `sha256(token)` reaches the `Session` table. An attacker holding the
 * table holds digests, and a digest is not a cookie — there is no way back to a
 * usable one. The token itself exists for exactly as long as the response that
 * carries it.
 *
 * SHA-256 and not a password hash, deliberately: the token is 256 bits of
 * machine-generated entropy, not a human-chosen secret, so there is no
 * dictionary to stretch against. Argon2 here would cost ~8 ms on every
 * authenticated request to defend against an attack that cannot happen.
 */

/** 32 bytes. 256 bits of entropy, so guessing is not a strategy. */
export const SESSION_TOKEN_BYTES = 32;

/** A freshly minted token. Returned ONCE, to be put in a cookie and forgotten. */
export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** The only form that is ever persisted. Hex, so it is a stable 64-char key. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two token hashes.
 *
 * `timingSafeEqual` throws when the two buffers differ in LENGTH, which is a
 * perfectly ordinary thing for a caller-supplied value to do — a truncated
 * cookie, a value from another system, a probe. So the length is checked first
 * and answered with `false`.
 *
 * That early return is itself a timing signal, and it is the right trade:
 * it leaks only "your value was not 64 hex characters", which the attacker
 * already knows because they chose it. What must not leak is WHERE two
 * same-length digests diverge, and that is what the constant-time compare
 * protects.
 *
 * Both sides are hashes rather than tokens, so this never sees a secret that
 * could be reused.
 */
export function sessionHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The two clocks a session lives under, computed from one instant.
 *
 * §3: idle SLIDES and absolute does NOT. They are returned together from a
 * single `issuedAt` because computing them separately is how they come to
 * disagree about when a session began.
 */
export const IDLE_TTL_MS = 8 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClocks {
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export function clocksForNewSession(issuedAt: Date): SessionClocks {
  return {
    idleExpiresAt: new Date(issuedAt.getTime() + IDLE_TTL_MS).toISOString(),
    absoluteExpiresAt: new Date(issuedAt.getTime() + ABSOLUTE_TTL_MS).toISOString(),
  };
}

/**
 * Where the idle clock moves to on activity — and it never passes the absolute one.
 *
 * The clamp is the point. Without it, a session used once an hour would have its
 * idle expiry pushed past the absolute expiry and live forever, which is exactly
 * the property the absolute clock exists to prevent. `findActive` checks both,
 * so an unclamped value would not actually extend the session — but it would
 * make the stored row claim something untrue, and the next person to read only
 * `idleExpiresAt` would believe it.
 */
export function slideIdleClock(now: Date, absoluteExpiresAt: string): string {
  const slid = now.getTime() + IDLE_TTL_MS;
  const absolute = new Date(absoluteExpiresAt).getTime();
  return new Date(Math.min(slid, absolute)).toISOString();
}

/**
 * Whether the idle clock is worth writing again.
 *
 * §3: "written at most once a minute, so a busy tab does not write a row per
 * request." A pure predicate so the threshold is testable without waiting.
 */
export const IDLE_WRITE_INTERVAL_MS = 60 * 1000;

export function shouldSlideIdleClock(now: Date, lastSeenAt: string): boolean {
  return now.getTime() - new Date(lastSeenAt).getTime() >= IDLE_WRITE_INTERVAL_MS;
}
