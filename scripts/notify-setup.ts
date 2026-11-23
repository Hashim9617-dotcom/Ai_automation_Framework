#!/usr/bin/env node
/**
 * Configures report email for one application. NON-INTERACTIVE.
 *
 *   pnpm notify:setup --app ecom --folder "C:\\Users\\me\\Contoso - Ecom QA" \
 *     --to qa@contoso.com,lead@contoso.com [--cc cto@contoso.com] [--ran-by me@contoso.com]
 *
 * Writes `.aitp-local/notify.json`, which is gitignored and sits outside every
 * locked kit prefix. It holds no credential and cannot: nothing in this path sends
 * mail. A run drops a file into a SharePoint-synced folder and a Power Automate flow
 * owned by a person sends the mail under their own identity — see
 * docs/notify/POWER-AUTOMATE-FLOW.md.
 *
 * ## Why non-interactive, and what is deferred
 *
 * A wizard that asks four questions is nicer for a first-time user and is a worse
 * first deliverable: it cannot be driven by a test as a real process, so the thing a
 * QA actually runs would be the one path with no coverage. The flags are testable
 * today. **The interactive wizard is deferred to kit v0.4.2** and is listed as
 * deferred rather than implied.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  NOTIFY_CONFIG_RELATIVE,
  NOTIFY_CONFIG_SCHEMA_VERSION,
  NOTIFY_CONFIG_VAR,
  checkRecipients,
  domainOf,
  isEmailShaped,
  loadNotifyConfig,
  notifyConfigOverride,
  notifyConfigPath,
  resolveRanBy,
  type IdentitySources,
  type NotifyAppConfig,
  type NotifyConfig,
  type ResolvedRanBy,
} from '@aitp/reporting-engine';
import { findRepoRoot, rootLogger } from '@aitp/shared';

const log = rootLogger.child('notify-setup');

const USAGE = [
  'usage: pnpm notify:setup --app <slug> --folder <path> --to <addr>[,<addr>...]',
  '                        [--cc <addr>[,<addr>...]] [--ran-by <email>]',
].join('\n');

function valueOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  // A flag with nothing after it is not a value: `--to --cc x` would otherwise make
  // the recipient list `--cc`, which then fails as a malformed address and reads as
  // a different problem entirely.
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

const listOf = (flag: string): string[] =>
  (valueOf(flag) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

/**
 * The IMPURE half of identity resolution, kept separate from the cascade.
 *
 * `resolveRanBy` takes its sources and reads nothing (§AJ), so the cascade is
 * testable without this machine. This function is where the machine is actually
 * consulted, and it is the only place — which is also why it is here in `scripts/`
 * rather than in the package: nothing that runs in a test should be able to reach it
 * by accident.
 *
 * Every lookup is individually guarded. On a laptop that is not Entra-joined
 * `USERPRINCIPALNAME` is absent or is `DOMAIN\user`; OneDrive for Business may not be
 * signed in; `git config` may have no `user.email`. Each failure is silence, not an
 * error, because the cascade's job is to try the next one.
 */
function collectIdentitySources(root: string): IdentitySources {
  const upn = process.env.USERPRINCIPALNAME;

  // OneDrive for Business records the signed-in address in the registry. Read
  // through `reg query` rather than a PowerShell module so this needs nothing
  // installed, and wrapped because the key is absent on a machine without it — and
  // absent on every non-Windows machine, where this must simply fall through.
  let oneDriveUserEmail: string | undefined;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts\\Business1', '/v', 'UserEmail'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      oneDriveUserEmail = /UserEmail\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
    } catch {
      oneDriveUserEmail = undefined;
    }
  }

  let gitUserEmail: string | undefined;
  try {
    gitUserEmail = execFileSync('git', ['config', 'user.email'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    gitUserEmail = undefined;
  }

  return { upn, oneDriveUserEmail, gitUserEmail };
}

/**
 * Writes the config ATOMICALLY: a temp file in the same directory, then a rename.
 *
 * The file is read by a run that may be starting at the same moment, and a partial
 * JSON there reads as a BROKEN config — which `loadNotifyConfig` correctly refuses,
 * so a half-written file would fail a run's notification for a reason that has
 * nothing to do with the run. `renameSync` within one directory is atomic on both
 * NTFS and POSIX.
 */
function writeAtomically(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, file);
  // ASSERTS ITS OWN EFFECT: the bytes that landed are the bytes intended. A rename
  // that silently did nothing, or a filter in the path, would otherwise be invisible
  // and the next run would read the old config while this one reported success.
  const readBack = readFileSync(file, 'utf8');
  if (readBack !== contents) {
    throw new Error(
      `wrote ${file} but reading it back gave ${readBack.length} bytes instead of ` +
        `${contents.length}. The file on disk is not what was written — refusing to report success.`,
    );
  }
}

function main(): void {
  const application = valueOf('--app');
  if (!application) {
    throw new Error(
      `${USAGE}\n  --app is required: this configures ONE application's report email, and ` +
        'nothing else should decide which.',
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(application)) {
    throw new Error(
      `${USAGE}\n  --app "${application}" is not a slug. It names the directory under ` +
        'config/apps/, so it is lower-case letters, digits and hyphens.',
    );
  }

  const root = findRepoRoot();

  // THE APPLICATION MUST EXIST. Configuring email for a slug with no config is a
  // typo that would otherwise sit in the file until a run quietly failed to notify —
  // and the drop is keyed on the slug a run resolves, so a mismatch is undetectable
  // from the config alone.
  const appDir = path.join(root, 'config', 'apps', application);
  if (!existsSync(appDir)) {
    throw new Error(
      `refusing to configure: there is no config/apps/${application}/ in this repo, so no run ` +
        'can ever resolve that application and nothing would read this entry.\n' +
        '  Check the spelling, or onboard the application first (docs/ADD-AN-APPLICATION.md).',
    );
  }

  const folder = valueOf('--folder');
  if (!folder) {
    throw new Error(
      `${USAGE}\n  --folder is required: the synced project folder the ready file is dropped ` +
        'into. It is the folder the Power Automate flow watches.',
    );
  }
  const resolvedFolder = path.resolve(folder);
  // THE FOLDER MUST EXIST NOW, and it must be a directory. A path typed with a
  // missing segment would be created later by the drop and then watched by nobody —
  // a flow pointed at the real folder would see nothing, forever, with every run
  // reporting that it wrote a file. Checked here, where a human is present to fix it.
  if (!existsSync(resolvedFolder)) {
    throw new Error(
      `refusing to configure: ${resolvedFolder} does not exist.\n` +
        '  Create it, or let OneDrive finish syncing the project folder, then run this again. ' +
        'A folder that does not exist yet would be CREATED by the first run and watched by no ' +
        'flow, so every run would report a drop nobody receives.',
    );
  }
  if (!statSync(resolvedFolder).isDirectory()) {
    throw new Error(`refusing to configure: ${resolvedFolder} is not a directory.`);
  }

  // ---- who the mail says it is from ----
  const explicit = valueOf('--ran-by');
  let ranBy: ResolvedRanBy;
  if (explicit) {
    if (!isEmailShaped(explicit)) {
      throw new Error(`${USAGE}\n  --ran-by "${explicit}" is not an email address.`);
    }
    ranBy = { email: explicit, source: 'explicit' };
  } else {
    const sources = collectIdentitySources(root);
    const resolved = resolveRanBy(sources);
    if (!resolved) {
      // NAMES WHAT WAS TRIED. "could not determine your address" is useless; the
      // reader needs to know which three places were looked at so they can fix one
      // or pass the flag.
      throw new Error(
        'could not determine who this machine runs as. Three sources were tried, in order:\n' +
          `  1. USERPRINCIPALNAME — ${describeCandidate(sources.upn)}\n` +
          `  2. OneDrive for Business UserEmail — ${describeCandidate(sources.oneDriveUserEmail)}\n` +
          `  3. git config user.email — ${describeCandidate(sources.gitUserEmail)}\n` +
          '  Pass --ran-by <your work email> instead.',
      );
    }
    ranBy = resolved;
  }

  const allowedDomain = domainOf(ranBy.email);

  // ---- recipients, bounded by the sender's own domain ----
  const to = listOf('--to');
  if (to.length === 0) {
    throw new Error(
      `${USAGE}\n  --to is required and must name at least one address. A configuration with no ` +
        'recipient would produce a drop that is picked up and sent to nobody — a silent success.',
    );
  }
  const cc = listOf('--cc');

  for (const [field, addresses] of [
    ['--to', to],
    ['--cc', cc],
  ] as const) {
    const check = checkRecipients(addresses, allowedDomain);
    if (check.malformed.length > 0) {
      throw new Error(
        `${field}: ${check.malformed.map((a) => `"${a}"`).join(', ')} ` +
          `${check.malformed.length === 1 ? 'is not an address' : 'are not addresses'}.`,
      );
    }
    if (check.rejected.length > 0) {
      // REFUSED AT SETUP, where a typo is cheap. The flow drops them at send time
      // instead, because by then the mail is going out and silently including an
      // outside address is the worse failure — two policies, one domain rule.
      throw new Error(
        `refusing to configure: ${field} names ${check.rejected.length} address(es) outside ` +
          `"${allowedDomain}", which is the domain of ranBy (${ranBy.email}):\n` +
          check.rejected.map((r) => `    ${r.address}  (${r.domain})`).join('\n') +
          "\n  Recipients are bounded by the sender's own domain so a report about a customer " +
          'system cannot leave the organisation through a typo. Use --ran-by if you meant a ' +
          'different sender.',
      );
    }
  }

  // ---- REFUSE under an override, rather than writing a file nothing will read ----
  // `AITP_NOTIFY_CONFIG` redirects the READERS (the reporter and `run-sheet`). This
  // command is the WRITER, and it deliberately does not follow: writing the repo's
  // own file while every run reads another one would leave a QA looking at a correct
  // configuration that does nothing. Refusing names both files, which is the only
  // version of this a reader can act on.
  const override = notifyConfigOverride(process.env);
  if (override) {
    throw new Error(
      `refusing to configure: ${NOTIFY_CONFIG_VAR} is set to ${override}, so runs on this ` +
        `machine read THAT file while this command writes ${notifyConfigPath(root)}. ` +
        'Unset it and run this again, or edit the file it names directly. (It exists so the ' +
        "platform's own tests can point a spawned run at their own config without touching " +
        'yours — it is not meant to be set for ordinary use.)',
    );
  }

  // ---- merge, never replace ----
  // Existing entries for OTHER applications are preserved. A setup run for `ecom`
  // that wiped `dms` would be a silent regression: the dms drop would simply stop,
  // and nothing would say why.
  const existing: NotifyConfig | null = loadNotifyConfig(root);
  const entry: NotifyAppConfig = {
    folder: resolvedFolder,
    to,
    cc,
    ranBy: ranBy.email,
    ranBySource: ranBy.source,
    allowedDomain,
  };
  const merged: NotifyConfig = {
    schemaVersion: NOTIFY_CONFIG_SCHEMA_VERSION,
    apps: { ...(existing?.apps ?? {}), [application]: entry },
  };

  const file = notifyConfigPath(root);
  const replaced = existing?.apps[application] !== undefined;
  writeAtomically(file, `${JSON.stringify(merged, null, 2)}\n`);

  // Read back THROUGH THE LOADER, not just as bytes: the loader is what a run uses,
  // and a file that parses but fails its validation would otherwise be reported as
  // configured and refuse at the next run instead (§"assert your own effect").
  const confirmed = loadNotifyConfig(root);
  if (!confirmed?.apps[application]) {
    throw new Error(
      `wrote ${file} but the loader does not see an entry for "${application}" — refusing to ` +
        'report success.',
    );
  }

  process.stdout.write(
    [
      '',
      `notify: ${replaced ? 'updated' : 'configured'} "${application}"`,
      `  drop folder : ${resolvedFolder}`,
      `  to          : ${to.join(', ')}`,
      `  cc          : ${cc.length ? cc.join(', ') : '(none)'}`,
      `  ran by      : ${ranBy.email}  (from ${ranBy.source})`,
      `  domain       : ${allowedDomain}  — recipients outside it are refused`,
      `  written to  : ${path.join(NOTIFY_CONFIG_RELATIVE)}  (gitignored; holds no credential)`,
      `  other apps  : ${
        Object.keys(merged.apps)
          .filter((slug) => slug !== application)
          .join(', ') || '(none)'
      }`,
      '',
      '  Next: set up the Power Automate flow once per project —',
      '  docs/notify/POWER-AUTOMATE-FLOW.md',
      '',
    ].join('\n'),
  );
}

const describeCandidate = (value: string | undefined): string =>
  value === undefined || value === ''
    ? 'not set'
    : isEmailShaped(value)
      ? `"${value}"`
      : `"${value}" (not an address)`;

try {
  main();
} catch (error) {
  log.error((error as Error).message);
  process.exitCode = 1;
}
