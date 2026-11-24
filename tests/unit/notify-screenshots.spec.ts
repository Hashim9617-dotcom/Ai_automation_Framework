import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  ALLOWED_IN_NOTIFY_BUNDLE,
  NOTIFY_CONFIG_SCHEMA_VERSION,
  loadNotifyConfig,
  notifyConfigPath,
  zipSources,
} from '@aitp/reporting-engine';

/**
 * WHETHER A FAILURE SCREENSHOT MAY BE MAILED IS A PER-APPLICATION ANSWER.
 *
 * ## Why the platform cannot decide this
 *
 * A failure screenshot is a picture of the application at the moment it broke, so it
 * shows whatever was on screen. Whether that may leave the machine is a property of
 * the SYSTEM UNDER TEST:
 *
 * - **DMS** is a live UAT system; its captures hold real names and real document
 *   titles, so a screenshot is personal data.
 * - **Ecom** is a dev environment with no live or personal data, stated by its owner,
 *   so a screenshot is a debugging aid.
 *
 * Nothing in this repository can tell those apart. So the application's notify config
 * says, `includeScreenshots` defaults to FALSE, and an application nobody has thought
 * about yet starts with pictures off.
 *
 * ## The same run, twice — which is the whole design of this suite
 *
 * One synthetic run directory, bundled twice with nothing different but the flag. A
 * test that built two different fixtures could pass over an implementation that
 * ignores the flag entirely and simply reflects its input, which is the
 * fixture-cannot-discriminate shape.
 */

/** A run directory with one allowed file and one failure screenshot. */
function syntheticRun(): { reports: string; results: string; cleanUp: () => void } {
  const reports = mkdtempSync(path.join(tmpdir(), 'aitp-shot-reports-'));
  const results = mkdtempSync(path.join(tmpdir(), 'aitp-shot-results-'));
  writeFileSync(path.join(reports, 'run.json'), '{"id":"run_shot"}', 'utf8');
  writeFileSync(path.join(reports, 'summary.md'), '# run', 'utf8');
  mkdirSync(path.join(results, 'a-failing-test'), { recursive: true });
  writeFileSync(
    path.join(results, 'a-failing-test', 'test-failed-1.png'),
    'PNG-PIXELS-THAT-SHOW-THE-APP',
    'utf8',
  );
  return {
    reports,
    results,
    cleanUp: () => {
      rmSync(reports, { recursive: true, force: true });
      rmSync(results, { recursive: true, force: true });
    },
  };
}

const bundle = (run: { reports: string; results: string }, includeScreenshots: boolean) =>
  zipSources(
    [
      { root: run.reports, prefix: '' },
      { root: run.results, prefix: 'test-results' },
    ],
    { includeScreenshots },
  );

/** A notify.json on disk, so the DEFAULT is read the way a real run reads it. */
function configWith(entry: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-shot-cfg-'));
  mkdirSync(path.dirname(notifyConfigPath(root)), { recursive: true });
  writeFileSync(
    notifyConfigPath(root),
    JSON.stringify({
      schemaVersion: NOTIFY_CONFIG_SCHEMA_VERSION,
      apps: {
        dms: {
          folder: root,
          to: ['qa@contoso.com'],
          cc: [],
          ranBy: 'me@contoso.com',
          ranBySource: 'explicit',
          allowedDomain: 'contoso.com',
          ...entry,
        },
      },
    }),
    'utf8',
  );
  return root;
}

test.describe('failure screenshots travel only where the application allows @unit', () => {
  test('S1: the SAME run bundles with the screenshot for one app and without for another', () => {
    // wrong: a platform-wide answer. DMS is a live UAT system and Ecom is a dev
    // environment, and the only difference between these two bundles is the flag —
    // same directories, same bytes on disk — so an implementation that ignored it
    // could not pass both halves.
    const run = syntheticRun();
    try {
      const withShots = bundle(run, true).bytes.toString('latin1');
      const withoutShots = bundle(run, false).bytes.toString('latin1');

      expect(withShots, 'the screenshot is missing for an app that allows it').toContain(
        'test-failed-1.png',
      );
      expect(withoutShots, 'the screenshot travelled for an app that forbids it').not.toContain(
        'test-failed-1.png',
      );
      // And its CONTENT, not just its name: a payload deflated into the bundle under
      // another entry's name would pass a name check and still ship the pixels.
      expect(withShots).toContain('PNG-PIXELS-THAT-SHOW-THE-APP');
      expect(withoutShots).not.toContain('PNG-PIXELS-THAT-SHOW-THE-APP');

      // THE REST OF THE BUNDLE IS IDENTICAL either way, which is what makes the two
      // results above a fact about the flag rather than about two different runs.
      for (const bytes of [withShots, withoutShots]) {
        expect(bytes).toContain('run.json');
        expect(bytes).toContain('summary.md');
      }
    } finally {
      run.cleanUp();
    }
  });

  test('S2: an opted-out screenshot is REPORTED as excluded, with the reason', () => {
    // wrong: dropping it silently. A bundle that is missing a picture for a policy
    // reason and one that is missing it because the run never took one look the same
    // from inside the zip — and the mail says what it left behind, so the reason has
    // to distinguish "never travels" from "not for this application".
    const run = syntheticRun();
    try {
      const off = bundle(run, false);
      const shot = off.excluded.find((entry) => entry.name.endsWith('test-failed-1.png'));
      expect(shot, 'the excluded screenshot was not reported at all').toBeDefined();
      expect(shot!.why).toContain('not included for this application');
      // A kind that NEVER travels gets the other sentence, so the two are
      // distinguishable by a reader rather than only by a maintainer.
      writeFileSync(path.join(run.reports, 'summary.html'), '<html/>', 'utf8');
      const again = bundle(run, false);
      const report = again.excluded.find((entry) => entry.name === 'summary.html');
      expect(report!.why).toBe('not on the notify allowlist');
    } finally {
      run.cleanUp();
    }
  });

  test('S3: an ABSENT includeScreenshots key reads as false, and a non-boolean is refused', () => {
    // wrong: defaulting to true, or coercing a truthy value. Every notify.json
    // written before this setting exists has no such key, and DMS is one of them —
    // so absent has to mean OFF or the change itself would start mailing pictures of
    // a live system. And `"false"` is a truthy string, which is exactly why the
    // check is on the type rather than on the value.
    const absent = configWith({});
    const off = configWith({ includeScreenshots: false });
    const on = configWith({ includeScreenshots: true });
    const bad = configWith({ includeScreenshots: 'true' });
    try {
      expect(loadNotifyConfig(absent)!.apps.dms!.includeScreenshots).toBe(false);
      expect(loadNotifyConfig(off)!.apps.dms!.includeScreenshots).toBe(false);
      // The discriminating half: the loader CAN return true, so `false` above is a
      // reading rather than a constant.
      expect(loadNotifyConfig(on)!.apps.dms!.includeScreenshots).toBe(true);
      expect(() => loadNotifyConfig(bad)).toThrow(/must be true or false/);
    } finally {
      for (const root of [absent, off, on, bad]) rmSync(root, { recursive: true, force: true });
    }
  });

  test('S4: the screenshot rule is the ONLY opt-in rule, so nothing else is gated by accident', () => {
    // wrong: an opt-in marker spreading to a rule that should be unconditional —
    // `run.json` behind a flag would make a bundle silently empty for every app that
    // had not set it. The list is asserted here so adding a second opt-in kind is a
    // deliberate act that fails this test and has to be justified in the change.
    const optIn = ALLOWED_IN_NOTIFY_BUNDLE.filter((rule) => rule.optIn);
    expect(optIn.map((rule) => rule.label)).toEqual(['a failure screenshot']);
    expect(optIn[0]!.optIn).toBe('includeScreenshots');
    // §T — and the list is not empty, so S1's two halves are about a real mechanism.
    expect(ALLOWED_IN_NOTIFY_BUNDLE.length).toBeGreaterThan(optIn.length);
  });
});
