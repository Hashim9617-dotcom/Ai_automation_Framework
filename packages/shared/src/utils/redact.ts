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

/**
 * Credential keys as they appear in FREE TEXT, followed by a separator.
 *
 * Deliberately narrower than `SECRET_KEY_PATTERN`, and the reason is measured
 * rather than theoretical. In the real QA sheet, **51 Given/When/And/Then
 * clauses mention "password" or "email" as ordinary prose** — "A validation
 * message should come that the user Password is not correct." Redacting on the
 * bare word would destroy 51 real assertions: a silent, permanent loss of
 * exactly the content the platform exists to run.
 *
 * So a value is redacted when it FOLLOWS a credential key and a separator
 * (`Password : hunter2`), never when the word merely appears. One regex, one
 * pass: the key is captured and kept, the value is replaced.
 */
const CREDENTIAL_PAIR =
  /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[-_ ]?key|credential|mail\s*id|e-?mail|user\s*(?:name|id)|login\s*id)(\s*[:=]\s*)([^\s,;|]+)/gi;

/** Anything shaped like an email address, wherever it appears. */
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Redacts credentials that live INSIDE a string, as opposed to in an object key.
 *
 * `redactSecrets` covers `{ password: '...' }`, which is the shape logs and API
 * payloads take. A spreadsheet cell is the other shape: one string holding
 * `mail id : someone@example.com  Password : hunter2`. Both must be stripped
 * before anything reaches a log, a report or a prompt, and they share this
 * module so the two definitions cannot drift apart.
 *
 * The key is KEPT and only the value replaced. A reviewer needs to know a
 * credential was there — `Password: ***redacted***` says so, while replacing
 * the whole cell destroys the structure and hides what was removed.
 */
export function redactCredentialText(value: string): string {
  return value
    .replace(CREDENTIAL_PAIR, (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(EMAIL_ADDRESS, REDACTED);
}
