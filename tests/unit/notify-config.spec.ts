import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  NOTIFY_CONFIG_RELATIVE,
  NOTIFY_CONFIG_SCHEMA_VERSION,
  checkRecipients,
  domainOf,
  howToConfigure,
  isEmailShaped,
  loadNotifyConfig,
  notifyConfigPath,
  resolveRanBy,
  type NotifyAppConfig,
} from '@aitp/reporting-engine';

/**
 * WHO THE REPORT MAIL IS FROM, AND WHO MAY RECEIVE IT.
 *
 * ## The identity cascade is PURE, and that is the point
 *
 * `resolveRanBy` takes its three candidates and reads nothing. A version that
 * reached for `process.env.USERPRINCIPALNAME` itself would be testing this laptop:
 * every assertion below would depend on whether this machine happens to be
 * Entra-joined and signed in to OneDrive — green here, red on a clean checkout, and
 * silently wrong the day somebody runs it on a build agent (§AJ). The impure half
 * lives in `scripts/notify-setup.ts` and is reached only by the CLI.
 *
 * ## Recipients are bounded by the SENDER's own domain
 *
 * Derived from `ranBy`, never typed. A report about a customer system must not be
 * able to leave the organisation because somebody mistyped an address, and the only
 * bound available without an address book is the domain of the person the mail is
 * from.
 *
 * The same rule has TWO POLICIES, deliberately: `notify:setup` refuses outright,
 * because a typo at setup time is cheap to fix with a human present; the Power
 * Automate flow drops the address and warns its owner, because by then the mail is
 * being sent and silently including an outsider is the worse failure.
 * `checkRecipients` is the one function both ask, so neither re-derives the rule.
 */

/** A repo root holding a notify.json whose text a test chooses. */
function rootWith(contents: string | undefined): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-notify-'));
  if (contents !== undefined) {
    const file = path.join(root, NOTIFY_CONFIG_RELATIVE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  }
  return root;
}

/** A valid entry. Typed, not cast (§AD), so a field the loader reads cannot be forgotten. */
const VALID_ENTRY: NotifyAppConfig = {
  folder: 'C:\\synced\\Contoso - Ecom QA',
  // The fail-closed default. Asserted as a VALUE here rather than omitted, because
  // the type requiring it is what stops a fixture quietly meaning "whatever".
  includeScreenshots: false,
  to: ['qa@contoso.com'],
  cc: ['lead@contoso.com'],
  ranBy: 'me@contoso.com',
  ranBySource: 'upn',
  allowedDomain: 'contoso.com',
};

const configText = (
  entry: Partial<NotifyAppConfig>,
  schemaVersion = NOTIFY_CONFIG_SCHEMA_VERSION,
) => JSON.stringify({ schemaVersion, apps: { ecom: { ...VALID_ENTRY, ...entry } } });

test.describe('report-email configuration @unit', () => {
  test('N1: the cascade prefers the UPN, and records that it did', () => {
    // wrong: returning the git address because it is always present — which on a
    // managed laptop is frequently the person's PERSONAL address, so the mail would
    // claim to be from somewhere outside the organisation and the domain bound would
    // then allow exactly the wrong set of recipients. The SOURCE is asserted, not
    // just the address: a right answer reached from the wrong place is the thing
    // that becomes untraceable later.
    expect(
      resolveRanBy({
        upn: 'me@contoso.com',
        oneDriveUserEmail: 'other@contoso.com',
        gitUserEmail: 'personal@gmail.com',
      }),
    ).toEqual({ email: 'me@contoso.com', source: 'upn' });
  });

  test('N2: a UPN that is NOT an address is skipped, not used', () => {
    // wrong: `DOMAIN\\user` is taken as the sender, `domainOf` then throws or
    // produces nonsense, and either the setup dies with an unrelated message or the
    // allowed domain becomes a string no address can ever match — refusing every
    // recipient. This is the ordinary state of a laptop that is not Entra-joined, so
    // it is the common case rather than an edge.
    expect(
      resolveRanBy({
        upn: 'CONTOSO\\hashim',
        oneDriveUserEmail: 'me@contoso.com',
        gitUserEmail: 'personal@gmail.com',
      }),
    ).toEqual({ email: 'me@contoso.com', source: 'onedrive' });
  });

  test('N3: with the first two unusable it falls through to git, and says so', () => {
    // wrong: stopping at the first DEFINED value rather than the first USABLE one —
    // an empty string from an unset-but-present variable would end the cascade and
    // return nothing, while the usable answer sat one step further down.
    expect(
      resolveRanBy({ upn: '', oneDriveUserEmail: undefined, gitUserEmail: 'me@contoso.com' }),
    ).toEqual({ email: 'me@contoso.com', source: 'git' });
  });

  test('N4: no usable source at all returns null, so the caller can name all three', () => {
    // wrong: throwing here, or inventing `user@localhost`. The caller's refusal
    // prints WHICH three places were looked at and what each held, which it can only
    // do if it is handed a null rather than an exception — "could not determine your
    // address" is useless to somebody who does not know where to look.
    expect(
      resolveRanBy({ upn: 'CONTOSO\\hashim', oneDriveUserEmail: '', gitUserEmail: undefined }),
    ).toBeNull();
  });

  test('N5: NO config file is `null` — not configured is not an error', () => {
    // wrong: throwing. Notification is opt-in and a run must succeed without it; a
    // throw here would make every run on an unconfigured machine fail for a reason
    // that has nothing to do with the tests.
    const root = rootWith(undefined);
    expect(loadNotifyConfig(root)).toBeNull();
    // And the sentence the run prints names the whole command, not a concept.
    expect(howToConfigure('ecom', root)).toContain('pnpm notify:setup --app ecom');
    expect(howToConfigure('ecom', root)).toContain(NOTIFY_CONFIG_RELATIVE);
  });

  test('N6: a BROKEN config throws and says broken — never "not configured"', () => {
    // wrong: a `catch` returning null, which converts a failure into a confident
    // negative answer. The reader is then told to configure something that IS
    // configured, and the file stays broken forever. This is the exact failure the
    // test inventory had — a corrupted search reported as an empty result — and the
    // two states call for opposite actions, which is the only thing a report is for.
    const root = rootWith('{ "schemaVersion": 1, "apps": { not json');
    expect(() => loadNotifyConfig(root)).toThrow(/could not be read as JSON/);
    expect(() => loadNotifyConfig(root)).toThrow(/BROKEN configuration, not a missing one/);
  });

  test('N7: a secret-shaped key is REFUSED, at any depth', () => {
    // wrong: silence — the file accepts an `smtpPassword` and now a plaintext
    // credential sits in a gitignored file that every run reads, which is precisely
    // what this whole design exists to avoid. Nested on purpose: a check that only
    // looked at top-level keys would pass `apps.ecom.smtp.password`, and that is
    // where somebody would actually put it.
    for (const text of [
      JSON.stringify({ schemaVersion: 1, apps: {}, smtpPassword: 'x' }),
      JSON.stringify({ schemaVersion: 1, apps: { ecom: { ...VALID_ENTRY, apiKey: 'x' } } }),
      JSON.stringify({
        schemaVersion: 1,
        apps: { ecom: { ...VALID_ENTRY, smtp: { clientSecret: 'x' } } },
      }),
    ]) {
      expect(() => loadNotifyConfig(rootWith(text)), text).toThrow(/secret-shaped/);
    }
  });

  test('N8: a valid file loads, which is what makes N6 and N7 mean something', () => {
    // wrong: a loader that refused everything would pass every refusal test above
    // and configure nothing — a rule that refuses everything is as empty as one that
    // accepts everything, and it is the harder of the two to see because it fails
    // safe while measuring nothing. This is the case that must come out the other way.
    const config = loadNotifyConfig(rootWith(configText({})));
    expect(config?.apps.ecom).toEqual(VALID_ENTRY);
    expect(notifyConfigPath('/r')).toBe(path.join('/r', NOTIFY_CONFIG_RELATIVE));
  });

  test('N9: allowedDomain disagreeing with ranBy is refused', () => {
    // wrong: the stored domain wins and somebody who edited `ranBy` by hand has
    // silently widened — or narrowed — the recipient allowlist of an existing entry.
    // A derived value STORED beside its source is a second source of truth unless
    // something checks the two agree, and this file is hand-editable by design.
    expect(() =>
      loadNotifyConfig(rootWith(configText({ ranBy: 'me@other.test', to: ['qa@other.test'] }))),
    ).toThrow(/allowedDomain.*is "contoso\.com" but "ranBy" is in "other\.test"/);
  });

  test('N10: a recipient outside the domain is refused ON READ, not only at setup', () => {
    // wrong: checking only in the CLI. The file is hand-editable, so an address
    // pasted in later would never meet the rule the CLI enforces — and the run that
    // read it would write a drop addressed outside the organisation. Both `to` and
    // `cc` are checked, because a cc is delivered exactly like a to.
    expect(() => loadNotifyConfig(rootWith(configText({ to: ['outsider@gmail.com'] })))).toThrow(
      /outside "contoso\.com"/,
    );
    expect(() => loadNotifyConfig(rootWith(configText({ cc: ['outsider@gmail.com'] })))).toThrow(
      /outside "contoso\.com"/,
    );
  });

  test('N11: an entry with no recipient is refused rather than written', () => {
    // wrong: a drop is written, a flow picks it up, a mail is addressed to nobody and
    // the whole chain reports success. A silent success is the one outcome worth
    // refusing outright, because nothing downstream can notice it.
    expect(() => loadNotifyConfig(rootWith(configText({ to: [] })))).toThrow(/"to" is empty/);
  });

  test('N12: an unknown schemaVersion refuses and says to re-run setup', () => {
    // wrong: reading a future shape with today's field names, which is how a field
    // that MOVED gets read from the wrong place — the same positional-read fault as
    // a sheet layout, arriving in a config file.
    expect(() => loadNotifyConfig(rootWith(configText({}, 99)))).toThrow(/schemaVersion is 99/);
  });

  test('N13: checkRecipients separates allowed, outside-domain and malformed', () => {
    // wrong: one list, or a boolean. The three are different ANSWERS — an allowed
    // address is sent to, an outside one is dropped with a warning naming the domain
    // it was in, and a malformed one is a typo somebody has to fix. Merged, the
    // result is useless to all three, which is why `failed` and `refused` are
    // separate statuses elsewhere in this repo for the same reason.
    const check = checkRecipients(
      ['qa@contoso.com', ' lead@contoso.com ', 'outsider@gmail.com', 'not-an-address', ''],
      'CONTOSO.com',
    );
    expect(check.allowed).toEqual(['qa@contoso.com', 'lead@contoso.com']);
    expect(check.rejected).toEqual([{ address: 'outsider@gmail.com', domain: 'gmail.com' }]);
    expect(check.malformed).toEqual(['not-an-address']);
  });

  test('N14: the address and domain helpers are case- and whitespace-tolerant', () => {
    // wrong: `Me@Contoso.com` treated as a different domain from `contoso.com`, so a
    // correctly-spelled recipient is refused for its capitalisation — a refusal
    // nobody can act on because the two strings look identical when read aloud.
    expect(domainOf('Me@Contoso.COM')).toBe('contoso.com');
    expect(isEmailShaped(' me@contoso.com ')).toBe(true);
    // And the cases it must still reject, or the shape check is decoration.
    expect(isEmailShaped('CONTOSO\\hashim')).toBe(false);
    expect(isEmailShaped('me@localhost')).toBe(false);
    expect(isEmailShaped('C:\\synced\\folder')).toBe(false);
  });
});
