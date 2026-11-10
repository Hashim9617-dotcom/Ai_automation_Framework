import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * WHERE A PROJECT'S REPORT EMAIL GOES, and who it says it is from.
 *
 * One file, `.aitp-local/notify.json`, holding one entry per application. It is
 * GITIGNORED and lives OUTSIDE every locked kit prefix, because it is the one piece
 * of configuration that is about this machine and these people rather than about the
 * platform: a QA's own folder path and their team's addresses.
 *
 * ## It holds no secret, and that is enforced rather than promised
 *
 * There is no password here and there never will be. The whole design exists so
 * nothing has to hold an SMTP credential: a run writes a file into a SharePoint-synced
 * folder, and a Power Automate flow owned by a human sends the mail under their own
 * identity. `assertNoSecretShapedKeys` refuses a config carrying a password-shaped
 * key rather than trusting that nobody adds one.
 *
 * ## Three states, three answers (the NOT CONFIGURED / EMPTY / FAILED rule)
 *
 * - **file absent** → `null`. Not an error: notification is opt-in, and a run must
 *   succeed without it. The caller prints one line saying how to configure it.
 * - **file present, no entry for this application** → a config with no entry. Also
 *   not an error, and a DIFFERENT sentence: the file exists, so somebody set this up
 *   for another application and this one was missed.
 * - **file present and unreadable** → THROWS. A `catch` returning `null` here would
 *   turn a broken file into "not configured", and the reader would go and configure
 *   something that is already configured. That is the exact failure the test
 *   inventory had.
 */

/** Bumped when the shape changes in a way a reader must notice. */
export const NOTIFY_CONFIG_SCHEMA_VERSION = 1;

/** Relative to the repo root. Gitignored, and outside every locked prefix. */
export const NOTIFY_CONFIG_RELATIVE = path.join('.aitp-local', 'notify.json');

export function notifyConfigPath(root: string): string {
  return path.join(root, NOTIFY_CONFIG_RELATIVE);
}

/** Where `ranBy` came from. Recorded, because a wrong sender is worth tracing. */
export type RanBySource = 'upn' | 'onedrive' | 'git' | 'explicit';

export interface NotifyAppConfig {
  /** The SharePoint-synced project folder the ready file is dropped into. */
  folder: string;
  to: string[];
  cc: string[];
  /** The address the mail will say it is from, and whose domain bounds recipients. */
  ranBy: string;
  ranBySource: RanBySource;
  /**
   * The only domain recipients may be in — DERIVED from `ranBy`, never typed.
   *
   * Stored rather than recomputed on read so that a `ranBy` edited by hand cannot
   * silently widen the allowlist of an existing entry without the mismatch being
   * visible; `loadNotifyConfig` refuses an entry whose two halves disagree.
   */
  allowedDomain: string;
}

export interface NotifyConfig {
  schemaVersion: number;
  apps: Record<string, NotifyAppConfig>;
}

/**
 * Keys that must never appear in this file.
 *
 * A DENYLIST is the wrong shape for a capability and the right shape here: the file's
 * purpose is "whatever a project needs", so the rule has to name what may not come in.
 * It is paired with a test that plants each shape.
 */
const SECRET_SHAPED = /(password|passwd|secret|token|credential|apikey|api_key|clientsecret)/i;

function assertNoSecretShapedKeys(value: unknown, where: string, trail: string[] = []): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_SHAPED.test(key)) {
      throw new Error(
        `${where}: the key "${[...trail, key].join('.')}" is secret-shaped, and this file must ` +
          'never hold one. Nothing in the notification path needs a credential — a run drops a ' +
          'file into a synced folder and a flow owned by a person sends the mail under their own ' +
          'identity. Remove the key.',
      );
    }
    assertNoSecretShapedKeys(nested, where, [...trail, key]);
  }
}

/** A conservative address check: enough to catch a path or a bare username. */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function isEmailShaped(value: string): boolean {
  return EMAIL.test(value.trim());
}

export function domainOf(email: string): string {
  const at = email.trim().lastIndexOf('@');
  if (at < 0) throw new Error(`"${email}" has no domain — it is not an address.`);
  return email.slice(at + 1).toLowerCase();
}

export interface IdentitySources {
  /**
   * Windows' own user principal name. OFTEN NOT AN ADDRESS — on a machine that is
   * not Entra-joined it is `DOMAIN\user` or absent entirely, which is why every
   * candidate is shape-checked rather than trusted by position in the cascade.
   */
  upn?: string | undefined;
  /** OneDrive for Business `UserEmail`. The most reliable on a managed laptop. */
  oneDriveUserEmail?: string | undefined;
  /** `git config user.email`. Always present in a working repo, often personal. */
  gitUserEmail?: string | undefined;
}

export interface ResolvedRanBy {
  email: string;
  source: RanBySource;
}

/**
 * Who the mail says it is from, by cascade — and the SOURCE is recorded.
 *
 * The sources are PASSED IN and never read here (§AJ). A version that reached for
 * `process.env.USERPRINCIPALNAME` itself would be testing this machine: every
 * assertion about the cascade would depend on whether this laptop happens to be
 * Entra-joined, green here and red on a clean checkout. `collectIdentitySources` is
 * the impure half, and it is a separate function for exactly that reason.
 *
 * Order is deliberate: UPN first because it is the organisation's own name for the
 * person, OneDrive second because it is the account the SharePoint folder belongs to,
 * `git config` LAST because it is whatever the human typed once and is frequently a
 * personal address. Recording which one answered is what makes a wrong sender
 * traceable instead of mysterious.
 */
export function resolveRanBy(sources: IdentitySources): ResolvedRanBy | null {
  const cascade: Array<[RanBySource, string | undefined]> = [
    ['upn', sources.upn],
    ['onedrive', sources.oneDriveUserEmail],
    ['git', sources.gitUserEmail],
  ];
  for (const [source, candidate] of cascade) {
    if (candidate && isEmailShaped(candidate)) return { email: candidate.trim(), source };
  }
  return null;
}

export interface RecipientCheck {
  allowed: string[];
  /** Addresses outside the allowed domain, with the domain each was in. */
  rejected: Array<{ address: string; domain: string }>;
  /** Addresses that are not addresses at all. */
  malformed: string[];
}

/**
 * Splits a recipient list into what may be written and what may not.
 *
 * Returns rather than throws, because the two halves are DIFFERENT ANSWERS to the
 * caller: `notify:setup` refuses outright on any rejection (a typo at setup time is
 * cheap to fix), while the Power Automate flow drops them and warns its owner (by
 * then the mail is being sent and silently including an outside address is the worse
 * failure). One function, two policies, and neither re-derives the domain rule.
 */
export function checkRecipients(
  addresses: readonly string[],
  allowedDomain: string,
): RecipientCheck {
  const allowed: string[] = [];
  const rejected: Array<{ address: string; domain: string }> = [];
  const malformed: string[] = [];
  for (const raw of addresses) {
    const address = raw.trim();
    if (address === '') continue;
    if (!isEmailShaped(address)) {
      malformed.push(address);
      continue;
    }
    const domain = domainOf(address);
    if (domain === allowedDomain.toLowerCase()) allowed.push(address);
    else rejected.push({ address, domain });
  }
  return { allowed, rejected, malformed };
}

/** Reads the config, or `null` when there is none. THROWS when there is a broken one. */
export function loadNotifyConfig(root: string): NotifyConfig | null {
  const file = notifyConfigPath(root);
  if (!existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // NOT `null`. A failed read reported as "not configured" tells the reader to set
    // up something that is already set up, which is the one thing a report is for.
    throw new Error(
      `${file} exists but could not be read as JSON: ${(error as Error).message}. ` +
        'This is a BROKEN configuration, not a missing one — fix the file or delete it.',
    );
  }

  assertNoSecretShapedKeys(raw, file);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} must be a JSON object with "schemaVersion" and "apps".`);
  }
  const value = raw as Record<string, unknown>;

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== NOTIFY_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `${file}: schemaVersion is ${JSON.stringify(schemaVersion)}, and this build reads ` +
        `${NOTIFY_CONFIG_SCHEMA_VERSION}. Re-run \`pnpm notify:setup\` for each application ` +
        'rather than editing the version by hand — the fields may have moved.',
    );
  }

  const apps = value.apps;
  if (!apps || typeof apps !== 'object' || Array.isArray(apps)) {
    throw new Error(`${file}: "apps" must be an object of application slug -> settings.`);
  }

  const parsed: Record<string, NotifyAppConfig> = {};
  for (const [slug, entry] of Object.entries(apps as Record<string, unknown>)) {
    const where = `${file}, app "${slug}"`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where}: must be an object.`);
    }
    const app = entry as Record<string, unknown>;

    const folder = app.folder;
    if (typeof folder !== 'string' || folder.trim() === '') {
      throw new Error(`${where}: "folder" is required — the synced project folder to drop into.`);
    }
    const ranBy = app.ranBy;
    if (typeof ranBy !== 'string' || !isEmailShaped(ranBy)) {
      throw new Error(
        `${where}: "ranBy" must be an email address, found ${JSON.stringify(ranBy)}.`,
      );
    }
    const allowedDomain = app.allowedDomain;
    if (typeof allowedDomain !== 'string' || allowedDomain.trim() === '') {
      throw new Error(`${where}: "allowedDomain" is required.`);
    }
    // THE TWO HALVES MUST AGREE. `allowedDomain` is derived from `ranBy` at setup,
    // and this file is hand-editable — so an edited `ranBy` with a stale domain, or
    // a widened domain with the original `ranBy`, is refused rather than used. A
    // derived value stored beside its source needs the check or the storage is a
    // second source of truth.
    if (allowedDomain.toLowerCase() !== domainOf(ranBy)) {
      throw new Error(
        `${where}: "allowedDomain" is "${allowedDomain}" but "ranBy" is in ` +
          `"${domainOf(ranBy)}". The allowed domain is DERIVED from ranBy; the two disagreeing ` +
          'means one of them was edited by hand. Re-run `pnpm notify:setup` for this app.',
      );
    }

    const list = (field: 'to' | 'cc'): string[] => {
      const given = app[field] ?? [];
      if (!Array.isArray(given) || given.some((item) => typeof item !== 'string')) {
        throw new Error(`${where}: "${field}" must be an array of email addresses.`);
      }
      return given as string[];
    };
    const to = list('to');
    const cc = list('cc');
    if (to.length === 0) {
      throw new Error(
        `${where}: "to" is empty. A drop with no recipient would be written, picked up and sent ` +
          'to nobody — a silent success, which is the one outcome worth refusing here.',
      );
    }

    // RE-CHECKED ON READ, not only at setup. The file is hand-editable, so an
    // address added later must meet the same rule as one added by the CLI.
    for (const field of ['to', 'cc'] as const) {
      const check = checkRecipients(field === 'to' ? to : cc, allowedDomain);
      if (check.malformed.length > 0) {
        throw new Error(
          `${where}: "${field}" contains ${check.malformed.length} entr(y/ies) that are not ` +
            `addresses: ${check.malformed.map((a) => JSON.stringify(a)).join(', ')}.`,
        );
      }
      if (check.rejected.length > 0) {
        throw new Error(
          `${where}: "${field}" contains ${check.rejected.length} address(es) outside ` +
            `"${allowedDomain}": ${check.rejected.map((r) => r.address).join(', ')}. ` +
            "Recipients are bounded by the sender's own domain so a report about a customer " +
            'system cannot be addressed out of the organisation by a typo.',
        );
      }
    }

    const ranBySource = app.ranBySource;
    const sources: RanBySource[] = ['upn', 'onedrive', 'git', 'explicit'];
    if (typeof ranBySource !== 'string' || !sources.includes(ranBySource as RanBySource)) {
      throw new Error(
        `${where}: "ranBySource" must be one of ${sources.join(', ')}, found ` +
          `${JSON.stringify(ranBySource)}.`,
      );
    }

    parsed[slug] = {
      folder,
      to,
      cc,
      ranBy,
      ranBySource: ranBySource as RanBySource,
      allowedDomain: allowedDomain.toLowerCase(),
    };
  }

  return { schemaVersion: NOTIFY_CONFIG_SCHEMA_VERSION, apps: parsed };
}

/** The one sentence a run prints when notification is not set up for an application. */
export function howToConfigure(application: string, root: string): string {
  return (
    `notify: not configured for "${application}" — no report email was prepared. ` +
    `Set it up with: pnpm notify:setup --app ${application} --folder "<synced project folder>" ` +
    `--to someone@example.com   (writes ${path.join(root, NOTIFY_CONFIG_RELATIVE)}, gitignored)`
  );
}
