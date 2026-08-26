// Deliberately does NOT match a bare "pass" — otherwise legitimate report fields
// like `passed` and `passRate` get redacted out of every log line and summary.
const SECRET_KEY_PATTERN =
  /(password|passwd|passphrase|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|session|credential)/i;

const REDACTED = '***redacted***';

/**
 * Strips credentials before anything reaches a log line, a report, an LLM prompt
 * or a Jira comment. Applied centrally so no call site has to remember.
 */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 6 || value == null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(val, depth + 1);
    }
    return out as unknown as T;
  }

  if (typeof value === 'string') {
    return value.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, `$1${REDACTED}`) as unknown as T;
  }

  return value;
}

/**
 * Strips credentials out of a URL before it is logged, stored or put in a prompt.
 * Query strings routinely carry tokens, and `redactSecrets` cannot see inside a
 * string that happens to be a URL.
 */
export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return input;
  }
}
