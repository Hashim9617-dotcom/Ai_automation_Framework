/**
 * LOGIN THROTTLING, as a pure decision over a list of past attempts.
 *
 * `docs/design/B1-auth-and-data.md` §3. Two independent limits — per username
 * and per IP — and both are decided here, from attempts a repository hands in,
 * so the policy is testable without a clock or a database (§AJ).
 *
 * ## Counters live in the database, and that is not an implementation detail
 *
 * §3 says so explicitly, and the reason is worth keeping: an in-memory counter
 * resets when the API restarts, which turns "lock after 5 failures" into "lock
 * after 5 failures PER RESTART". An attacker who can make the process restart —
 * or who simply waits for a deploy — gets unlimited attempts, and nothing
 * anywhere reports that the limit stopped applying.
 *
 * ## The lockout is invisible
 *
 * A locked account must return the SAME status, body and timing as a wrong
 * password (§3). So `decide()` answers "may this attempt proceed", and the
 * caller's refusal is identical either way — the distinction exists for the
 * audit log, never for the response.
 */

/** §3's numbers, in one place so a test can pin them. */
export const THROTTLE_POLICY = {
  /** Failures within the window before a username is locked. */
  usernameFailures: 5,
  /** Failures within the window before an IP is throttled. */
  ipFailures: 20,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
} as const;

/** One recorded attempt. `succeeded` matters because a success clears the slate. */
export interface LoginAttemptRecord {
  at: string;
  /** Folded, as the user repository folds it. */
  email: string;
  ip: string | null;
  succeeded: boolean;
}

export type ThrottleDecision =
  | { allowed: true }
  /** `reason` is for the AUDIT LOG. It is never surfaced to the caller (§3). */
  | { allowed: false; reason: 'username-locked' | 'ip-throttled'; retryAfterMs: number };

export interface ThrottleInput {
  now: Date;
  email: string;
  ip: string | null;
  /** Every attempt the repository holds for this email and ip, in any order. */
  attempts: readonly LoginAttemptRecord[];
}

const fold = (email: string): string => email.trim().toLowerCase();

/**
 * Attempts that still count: inside the window, and AFTER the most recent
 * success.
 *
 * The second half is what makes "a success resets the counter" true. Counting
 * only the window would leave a user who signed in correctly on their fifth try
 * still four failures from a lockout, for the next fifteen minutes.
 */
function countableFailures(
  attempts: readonly LoginAttemptRecord[],
  now: Date,
  matches: (attempt: LoginAttemptRecord) => boolean,
): LoginAttemptRecord[] {
  const windowStart = now.getTime() - THROTTLE_POLICY.windowMs;
  const relevant = attempts
    .filter(matches)
    .filter((attempt) => new Date(attempt.at).getTime() >= windowStart)
    .sort((a, b) => a.at.localeCompare(b.at));

  const lastSuccess = relevant.filter((attempt) => attempt.succeeded).at(-1);
  const since = lastSuccess ? new Date(lastSuccess.at).getTime() : -Infinity;
  return relevant.filter((attempt) => !attempt.succeeded && new Date(attempt.at).getTime() > since);
}

/** When a lockout triggered by these failures would end. */
function retryAfter(failures: readonly LoginAttemptRecord[], now: Date): number {
  const newest = failures.at(-1);
  if (!newest) return 0;
  const until = new Date(newest.at).getTime() + THROTTLE_POLICY.lockoutMs;
  return Math.max(0, until - now.getTime());
}

export function decideThrottle(input: ThrottleInput): ThrottleDecision {
  const email = fold(input.email);

  // USERNAME FIRST, because it is the limit that protects one account against a
  // guessing run, and it is the one a legitimate user can trip. Reporting the IP
  // reason when both apply would attribute a user's own mistyping to their
  // network.
  const byUsername = countableFailures(
    input.attempts,
    input.now,
    (attempt) => fold(attempt.email) === email,
  );
  if (byUsername.length >= THROTTLE_POLICY.usernameFailures) {
    return {
      allowed: false,
      reason: 'username-locked',
      retryAfterMs: retryAfter(byUsername, input.now),
    };
  }

  // Per IP, and only when there IS an ip. A null ip must not collapse every
  // unidentified caller into one shared bucket — that would let one of them lock
  // out all the others, which is a denial of service wearing a rate limit's
  // clothes.
  if (input.ip !== null) {
    const byIp = countableFailures(input.attempts, input.now, (attempt) => attempt.ip === input.ip);
    if (byIp.length >= THROTTLE_POLICY.ipFailures) {
      return { allowed: false, reason: 'ip-throttled', retryAfterMs: retryAfter(byIp, input.now) };
    }
  }

  return { allowed: true };
}
