/**
 * WHERE THE DATA LIVES — resolved, with three answers and no default.
 *
 * `DATABASE_URL` has no fallback, for the reason `resolveEnvName` has none: a
 * default here is a guess about which database a run writes to, and the guess
 * that would feel safe (`localhost/aitp`) is the one most likely to be someone
 * else's. An unset variable refuses BY NAME.
 *
 * ## Three states, because they call for three different actions
 *
 * | state | means | what to do |
 * | --- | --- | --- |
 * | `not-configured` | no `DATABASE_URL`, or a blank one | set it in `.env` |
 * | `malformed` | there is a value and it is not a usable Postgres URL | fix the value |
 * | `configured` | a usable URL | nothing |
 *
 * Collapsing the first two into "no database" is the failure this repo keeps
 * finding: NOT CONFIGURED and FAILED TO LOAD are different answers, and a
 * reader told the wrong one goes and does the wrong thing.
 *
 * ## No message here may contain the value
 *
 * The URL carries a password. So a `malformed` refusal says WHAT is wrong and
 * never echoes the string — not even partially, because the password is the part
 * most likely to contain whatever made it unparseable. `describe()` is the only
 * thing that renders a URL, and it masks.
 *
 * Pure, and the raw value is a PARAMETER: a guard that reads `process.env`
 * itself is testing the machine it runs on (§AJ), and this one decides which
 * database the installation uses.
 */

export type DatabaseConfig =
  | {
      state: 'configured';
      /** The URL itself. Never logged — pass it to a client, not to a message. */
      url: string;
      /** Safe to print: user, host, port and database, with the password masked. */
      describe: string;
    }
  | { state: 'not-configured'; why: string }
  | { state: 'malformed'; why: string };

/** Postgres only. A `mysql://` URL here is a configuration mistake, not a feature. */
const ALLOWED_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * A connection string with its password replaced.
 *
 * Returns a fixed placeholder rather than the input when it cannot be parsed —
 * an unparseable URL still contains the password, so echoing it back is the one
 * thing a masking function must never do on its failure path.
 */
export function maskDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const user = url.username ? decodeURIComponent(url.username) : '(no user)';
    const database = url.pathname.replace(/^\//, '') || '(no database)';
    const port = url.port || '5432';
    return `${user}@${url.hostname}:${port}/${database}`;
  } catch {
    return '(unparseable connection string)';
  }
}

export function resolveDatabaseUrl(raw: string | undefined): DatabaseConfig {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return {
      state: 'not-configured',
      why:
        'DATABASE_URL is not set. It has no default on purpose: a default would be a guess ' +
        'about which database this installation writes to. Set it in .env, which is ' +
        'gitignored — for example postgresql://aitp_app:<password>@127.0.0.1:5432/aitp',
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Deliberately says nothing about the value. It holds a password.
    return {
      state: 'malformed',
      why: 'DATABASE_URL is set but is not a URL. Expected postgresql://user:password@host:port/database',
    };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      state: 'malformed',
      why: `DATABASE_URL has protocol "${url.protocol}" — this installation speaks Postgres only, so it must be postgresql://`,
    };
  }
  if (!url.hostname) {
    return { state: 'malformed', why: 'DATABASE_URL names no host' };
  }
  if (!url.pathname.replace(/^\//, '')) {
    return {
      state: 'malformed',
      why:
        'DATABASE_URL names no database. The path after the host is the database name — ' +
        'a dedicated one, so a development `migrate reset` cannot reach anything else',
    };
  }

  return { state: 'configured', url: trimmed, describe: maskDatabaseUrl(trimmed) };
}

/**
 * The URL, or a refusal that names the variable and says which of the two
 * failures it is.
 *
 * @throws for `not-configured` and `malformed` alike — they are different
 * sentences, not different severities.
 */
export function requireDatabaseUrl(raw: string | undefined): string {
  const resolved = resolveDatabaseUrl(raw);
  if (resolved.state !== 'configured') throw new Error(`refusing to start: ${resolved.why}`);
  return resolved.url;
}
