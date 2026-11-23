import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  RunStatus,
  TestOutcome,
  describeTarget,
  emptySummary,
  rootLogger,
  type Run,
} from '@aitp/shared';
import {
  NOTIFY_CONFIG_RELATIVE,
  NOTIFY_CONFIG_SCHEMA_VERSION,
  NOTIFY_CONFIG_VAR,
  loadNotifyConfigFile,
  notifyConfigOverride,
  notifyConfigPath,
  notifyRun,
  validateNotifyConfigOverride,
} from '@aitp/reporting-engine';
import { describeNotifyConfigChange, snapshotNotifyConfig } from '../support/notify-config-guard';

/**
 * WHICH NOTIFY CONFIG A RUN READS, and the guard that it was not the developer's.
 *
 * ## What this replaces
 *
 * `notify-drop-e2e.spec.ts` spawns a real `playwright test`, which resolves its own
 * repo root — so the only config it could read was `.aitp-local/notify.json` in THIS
 * repo. The spec therefore wrote that file and restored the previous contents
 * afterwards, and there is no correct way to do that to somebody else's file:
 * restoring the PREVIOUS contents preserves a leftover (a dead `aitp-configured-*`
 * temp folder sat in this repo's config for days), and restoring a known-clean
 * `{apps:{}}` would delete the entries a QA had configured, on every `pnpm verify`.
 *
 * `AITP_NOTIFY_CONFIG` removes the need to write it at all.
 *
 * ## A bad value is REFUSED, and that is the substance
 *
 * The tempting shape is "if the override looks wrong, use the default". That is
 * fail-open in the one direction that matters: a test that set this and had it
 * silently ignored would write the developer's real config while believing it had
 * been redirected — the exact failure the variable exists to end. Ambiguity resolves
 * toward refusal (§AC).
 *
 * ## The environment is PASSED IN
 *
 * `validateNotifyConfigOverride` takes the raw value and `notifyConfigOverride`
 * takes the whole environment; neither reads `process.env`. With every variable on
 * this machine deleted these assertions would be comparing exactly what they compare
 * now, which is what §AJ asks of a guard.
 */

const log = rootLogger.child('notify-override-spec');

/** A directory that exists, so only the thing under test can make a path invalid. */
function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'aitp-cfg-'));
}

function configText(folder: string, to: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: NOTIFY_CONFIG_SCHEMA_VERSION,
      apps: {
        ecom: {
          folder,
          to: [to],
          cc: [],
          ranBy: 'me@contoso.com',
          ranBySource: 'explicit',
          allowedDomain: 'contoso.com',
        },
      },
    },
    null,
    2,
  )}\n`;
}

test.describe('the notify config path can be overridden @unit', () => {
  test('O1: unset, empty and whitespace all mean the repo’s own file', () => {
    // wrong: treating `''` as a path, which resolves to `.` and then reads a
    // DIRECTORY as a config — or honouring it as "somewhere else" so a machine with
    // the variable exported empty would silently stop reading its own configuration.
    // `AITP_NOTIFY_TEST_FOLDER` answers the same question the same way, deliberately.
    expect(notifyConfigOverride({})).toBeUndefined();
    expect(notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: '' })).toBeUndefined();
    expect(notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: '   ' })).toBeUndefined();
    expect(validateNotifyConfigOverride(undefined)).toBeUndefined();
    // And the default those fall back to is the repo's own file, not a guess.
    expect(notifyConfigPath('/r')).toBe(path.join('/r', NOTIFY_CONFIG_RELATIVE));
  });

  test('O2: an absolute path is honoured even though the FILE does not exist', () => {
    // wrong: requiring the file to exist. An absent config is the NOT CONFIGURED
    // state and a valid answer — `notify:setup` has to be able to create one at the
    // overridden location, and a run before that must say "not configured" rather
    // than refuse. Only the DIRECTORY has to be real.
    const base = dir();
    try {
      const file = path.join(base, 'does-not-exist-yet.json');
      expect(notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: file })).toBe(file);
      // Whitespace around a real value is trimmed, not refused.
      expect(notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: `  ${file}  ` })).toBe(file);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('O3: a RELATIVE path is refused, never resolved against cwd', () => {
    // wrong: `path.resolve(value)`. The reporter runs with cwd at the repo root and
    // `pnpm run-sheet` need not, so one setting would name two different files and
    // the one a test checked would not be the one a run read. The message says
    // "relative" so the fix is obvious rather than mysterious.
    for (const value of ['notify.json', path.join('.aitp-local', 'notify.json'), './x.json']) {
      expect(() => notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: value }), value).toThrow(
        /RELATIVE path/,
      );
    }
  });

  test('O4: a missing parent directory is refused, not created and not ignored', () => {
    // wrong: falling back to the repo's own config. A test that mistyped this would
    // then write the developer's real file while every assertion it makes passes —
    // fail-open, and silent. The named directory is absent while its PARENT exists,
    // so the only thing that can make this throw is the check under test.
    const base = dir();
    try {
      const file = path.join(base, 'no-such-dir', 'notify.json');
      expect(() => notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: file })).toThrow(/does not exist/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('O5: a path that names a DIRECTORY is refused', () => {
    // wrong: accepting it and letting `readFileSync` fail later with EISDIR, which
    // arrives as "exists but could not be read as JSON" — a broken-file sentence for
    // what is actually a wrong setting, sending the reader to fix the wrong thing.
    const base = dir();
    try {
      const inner = path.join(base, 'a-directory');
      mkdirSync(inner);
      expect(() => notifyConfigOverride({ [NOTIFY_CONFIG_VAR]: inner })).toThrow(/is a DIRECTORY/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('O6: the loader reads the file it is GIVEN, not the repo’s', () => {
    // wrong: a loader that still joined the root would return the repo's entry, and
    // this would pass over an implementation that ignores the override entirely. The
    // two configs differ in a FIELD THAT IS READ BACK — a fixture where both named
    // the same recipient could not tell them apart (a fixture that cannot
    // discriminate).
    const base = dir();
    try {
      const root = path.join(base, 'repo');
      mkdirSync(path.join(root, '.aitp-local'), { recursive: true });
      writeFileSync(notifyConfigPath(root), configText(base, 'repo@contoso.com'), 'utf8');
      const elsewhere = path.join(base, 'elsewhere.json');
      writeFileSync(elsewhere, configText(base, 'override@contoso.com'), 'utf8');

      expect(loadNotifyConfigFile(elsewhere)?.apps.ecom?.to).toEqual(['override@contoso.com']);
      expect(loadNotifyConfigFile(notifyConfigPath(root))?.apps.ecom?.to).toEqual([
        'repo@contoso.com',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('O7: the three states survive the override — absent is null, broken THROWS', () => {
    // wrong: a `catch` returning `null` for a broken file at the overridden path.
    // "Not configured" and "could not be read" ask different things of the reader —
    // create one, versus fix the one you have — and collapsing them is the
    // confident-negative-answer shape. The override must not quietly weaken that.
    const base = dir();
    try {
      expect(loadNotifyConfigFile(path.join(base, 'absent.json'))).toBeNull();
      const broken = path.join(base, 'broken.json');
      writeFileSync(broken, '{ not json', 'utf8');
      expect(() => loadNotifyConfigFile(broken)).toThrow(/BROKEN configuration/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('O8: notifyRun drops into the folder named by the OVERRIDDEN config', () => {
    // wrong: reading the repo root's config, which here names a DIFFERENT folder —
    // so the drop would land in `repoDrop` and `overrideDrop` would be empty. Both
    // folders exist and both are writable, so nothing but the path resolution can
    // decide which one receives the file.
    const base = dir();
    try {
      const root = path.join(base, 'repo');
      const repoDrop = path.join(base, 'repo-drop');
      const overrideDrop = path.join(base, 'override-drop');
      const reportDir = path.join(root, 'artifacts', 'reports', 'html');
      for (const made of [repoDrop, overrideDrop, reportDir]) {
        mkdirSync(made, { recursive: true });
      }
      writeFileSync(path.join(reportDir, 'index.html'), '<p>report</p>', 'utf8');
      mkdirSync(path.join(root, '.aitp-local'), { recursive: true });
      writeFileSync(notifyConfigPath(root), configText(repoDrop, 'repo@contoso.com'), 'utf8');
      const elsewhere = path.join(base, 'elsewhere.json');
      writeFileSync(elsewhere, configText(overrideDrop, 'override@contoso.com'), 'utf8');

      const outcome = notifyRun({
        root,
        run: aRun(),
        application: 'ecom',
        environment: 'qa',
        baseUrl: 'https://qa.example.test',
        reportDir,
        disabled: false,
        configFileOverride: elsewhere,
        log,
      });

      expect(outcome.written, outcome.message).toBe(true);
      expect(outcome.message).toContain('override@contoso.com');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('O9: a bad override is config-broken, and does NOT fall back to the repo’s', () => {
    // wrong: resolving to the repo's own config on a bad value. The run would then
    // report `notify: report queued` for the real recipients in the developer's file
    // — a drop the caller believed was redirected. The repo config here is VALID and
    // its folder exists, so a fallback would succeed, which is what makes the
    // distinction visible.
    const base = dir();
    try {
      const root = path.join(base, 'repo');
      const repoDrop = path.join(base, 'repo-drop');
      const reportDir = path.join(root, 'artifacts', 'reports', 'html');
      for (const made of [repoDrop, reportDir]) mkdirSync(made, { recursive: true });
      writeFileSync(path.join(reportDir, 'index.html'), '<p>report</p>', 'utf8');
      mkdirSync(path.join(root, '.aitp-local'), { recursive: true });
      writeFileSync(notifyConfigPath(root), configText(repoDrop, 'repo@contoso.com'), 'utf8');

      const outcome = notifyRun({
        root,
        run: aRun(),
        application: 'ecom',
        environment: 'qa',
        baseUrl: 'https://qa.example.test',
        reportDir,
        disabled: false,
        configFileOverride: 'notify.json',
        log,
      });

      expect(outcome.written).toBe(false);
      expect(outcome.skipped).toBe('config-broken');
      expect(outcome.message).toContain('RELATIVE path');
      // The fallback did not happen: nothing was written anywhere.
      expect(outcome.message).not.toContain('repo@contoso.com');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test.describe('the guard that the real notify config was untouched @unit', () => {
  test('G1: identical contents read as UNCHANGED', () => {
    // wrong: a comparison that always reports a change. The guard in
    // notify-drop-e2e.spec.ts would then fail every run and be deleted, which is the
    // rule-that-refuses-everything shape. This is the silent half, and it is the
    // case the real assertion is written against.
    const base = dir();
    try {
      const file = path.join(base, 'notify.json');
      writeFileSync(file, configText(base, 'qa@contoso.com'), 'utf8');
      const before = snapshotNotifyConfig(file);
      // Re-written with the SAME bytes: a guard keyed on mtime would cry here.
      writeFileSync(file, configText(base, 'qa@contoso.com'), 'utf8');
      expect(describeNotifyConfigChange(before, snapshotNotifyConfig(file))).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('G2: a changed byte is caught, and the message does not quote the contents', () => {
    // wrong: a guard that reports nothing — the hazard is re-introduced by four
    // convenient lines and the file is gitignored, so `git status` stays clean and
    // nothing says a word. And a guard that explained itself with a DIFF would put
    // real colleagues' addresses into a test report, a trace and an archive.
    const base = dir();
    try {
      const file = path.join(base, 'notify.json');
      writeFileSync(file, configText(base, 'real.person@contoso.com'), 'utf8');
      const before = snapshotNotifyConfig(file);
      writeFileSync(file, configText(base, 'someone.else@contoso.com'), 'utf8');

      const changed = describeNotifyConfigChange(before, snapshotNotifyConfig(file));
      expect(changed).not.toBeNull();
      expect(changed).toContain('contents changed');
      expect(changed).toContain(file);
      expect(changed).not.toContain('real.person@contoso.com');
      expect(changed).not.toContain('someone.else@contoso.com');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('G3: creating one where there was none, and deleting one, are both caught', () => {
    // wrong: treating absent as "nothing to compare" and returning null. A suite that
    // CREATED a config on a machine that had none would make the platform start
    // claiming notification was set up; one that DELETED it would silently stop a
    // real QA's mail. Both directions, because a guard built around only the
    // present-to-present case covers neither.
    const base = dir();
    try {
      const file = path.join(base, 'notify.json');
      const absent = snapshotNotifyConfig(file);
      expect(absent.digest).toBeNull();

      writeFileSync(file, configText(base, 'qa@contoso.com'), 'utf8');
      const present = snapshotNotifyConfig(file);
      expect(describeNotifyConfigChange(absent, present)).toContain('did not exist before');

      rmSync(file);
      expect(describeNotifyConfigChange(present, snapshotNotifyConfig(file))).toContain(
        'has been deleted',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('G4: absent before and absent after is unchanged, and two different files are a guard bug', () => {
    // wrong: null-versus-null read as a change, which would fail on every machine
    // that has never configured notification — the majority of them. The second half
    // is the §T case: a guard handed two snapshots of DIFFERENT files is comparing
    // nothing meaningful, and must say so rather than report a reassuring null.
    const base = dir();
    try {
      const file = path.join(base, 'notify.json');
      const absent = snapshotNotifyConfig(file);
      expect(describeNotifyConfigChange(absent, snapshotNotifyConfig(file))).toBeNull();

      const other = snapshotNotifyConfig(path.join(base, 'other.json'));
      expect(describeNotifyConfigChange(absent, other)).toContain('two DIFFERENT files');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/** A minimal passing run — the drop's contents are `notify-drop.spec.ts`'s subject. */
function aRun(): Run {
  return {
    id: 'run_0verr1de',
    status: RunStatus.Passed,
    request: { environment: 'qa', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt: '2026-11-23T09:00:00.000Z',
    startedAt: '2026-11-23T09:00:01.000Z',
    finishedAt: '2026-11-23T09:00:41.000Z',
    summary: { ...emptySummary(), total: 1, passed: 1, durationMs: 40_000, passRate: 100 },
    target: describeTarget('qa', 'https://qa.example.test', 'ecom'),
    artifacts: {},
    results: [
      {
        id: 't1',
        title: 'Departments › DEPT-001 list loads',
        file: 'tests/apps/ecom/departments.spec.ts',
        project: 'chromium',
        tags: [],
        outcome: TestOutcome.Passed,
        durationMs: 1200,
        retry: 0,
        steps: [],
        attachments: [],
      },
    ],
  };
}
